# 后端体检 · legacy_orders.js

> **明天能不能直接上线？不能。** 致命项：SQL 注入（2 处）、结算并发双扣、支付金额单位错（元当分传）、live 密钥硬编码。
> 最少改：参数化查询、结算加原子状态抢占、金额换算成分、密钥进环境变量——这四处改完才谈得上接支付；其余严重项建议同批修。

## 问题 1：GET 接口 SQL 注入
- **位置**：`GET /orders/:id`（原 L23）、`GET /merchant/:merchantId/orders`（原 L33-35）
- **后果**：任何人把 `id` 换成 `1 OR 1=1` 或 `1; DROP TABLE orders;--` 就能拖库/改库。上线当天第一个扫描器就会打进来。
- **严重度**：致命
- **修法**：改成 `$1` 参数化查询（settle 里已经是这么写的，照抄）。

## 问题 2：结算无并发控制，会双扣
- **位置**：`POST /orders/:id/settle`（原 L52-81）
- **后果**：先 SELECT 判 `status==='settled'` 再扣款再 UPDATE，中间没有锁也没有原子条件。用户双击/前端重试/两个并发请求同时进来，都读到 pending，各扣一次钱。客户被扣两次，投诉+退款。
- **严重度**：致命
- **修法**：用 `UPDATE ... SET status='settling' WHERE id=$1 AND status='pending' RETURNING *` 原子抢占，抢不到就拒绝；失败回滚状态。

## 问题 3：支付金额单位错（元 vs 分）
- **位置**：`chargeCustomer` 请求体 `amount: amount`（原 L93）
- **后果**：`orderTotal` 算出来是元（price×qty），支付网关 v2 的 `amount` 惯例是最小货币单位（分）。199 元的单会按 1.99 元扣；若网关按元收则反过来放大 100 倍。无论哪种，对账第一天就炸。
- **严重度**：致命
- **修法**：发送前 `Math.round(amount*100)` 转分，并在对账层用同一口径。

## 问题 4：live 支付密钥硬编码在源码里
- **位置**：原 L12 `PAYMENT_KEY = 'sk_live_...'`
- **后果**：密钥随代码进 git、进外包所有人的机器。拿到源码=拿到扣款权限；离职/跑路后无法撤销追溯。
- **严重度**：致命
- **修法**：改读 `process.env.PAYMENT_KEY`，缺失即启动失败；**已泄露的这把 key 必须去支付后台吊销换新**（代码改了不等于钥匙换了）。

## 问题 5：浮点金额累加 + 严格相等校验
- **位置**：`orderTotal`（原 L39-45）与 settle 的 `total !== row.expected_total`（原 L67）
- **后果**：`0.1*3=0.30000000000000004` 这类误差会让合法订单被 400 拒结；pg 的 numeric 回来可能是字符串，`!==` 直接永假/永真。商户的正常单结不了算。
- **严重度**：严重
- **修法**：全程整数分运算（`Math.round(price*100)*qty`），比较用容差或统一转 Number 后按分比。

## 问题 6：日报只查最近 5000 条再过滤"今天"
- **位置**：`GET /report/daily`（原 L124-129）
- **后果**：`LIMIT 5000` 后再 filter 今天——历史 settled 超过 5000 条时，今天的早期订单被挤出去，财务日报少钱。量一上来必现，且是静默错。
- **严重度**：严重
- **修法**：把日期条件放进 SQL（`settled_at >= date_trunc('day', now())`），去掉 LIMIT。

## 问题 7：isToday 用 UTC 日期切"今天"
- **位置**：`isToday`（原 L47-50）
- **后果**：`toISOString()` 是 UTC。北京时间 0:00-8:00 结算的单会被算进"昨天"，日报每天凌晨少 8 小时的量。（问题 6 修掉后此函数不再被调用，但留着就是下一个坑。）
- **严重度**：严重
- **修法**：按业务时区（服务器本地或 Asia/Shanghai）比较年月日，别切 ISO 字符串。

## 问题 8：创建订单不校验价格/数量，可造负数单
- **位置**：`POST /orders`（原 L108-121）
- **后果**：`price:-100` 或 `qty:-5` 或 `price:"abc"` 都能入库，total 变负数/NaN；负数单进结算就是给攻击者打钱，NaN 单污染报表。
- **严重度**：严重
- **修法**：校验 price 为正有限数、qty 为正整数，merchant/customer 必填，不合法 400。

## 问题 9：chargeCustomer 吞掉所有错误，扣款失败无日志
- **位置**：`chargeCustomer` catch 与 `data.status` 分支（原 L98-105）
- **后果**：网关 500、网络断、签名错全部静默变 `null`→502。客户说扣了钱你说没扣，没有任何日志可查；也没检查 `resp.ok`，非 2xx 但 body 里有 `status:'succeeded'` 的异常响应会被当成功。
- **严重度**：严重
- **修法**：检查 `resp.ok`，失败路径 `console.error` 带上 orderId 和网关返回，保留排查线索。

## 问题 10：console.log 整个请求体
- **位置**：`POST /orders` 原 L109
- **后果**：items 里若带客户信息/备注会全量进日志，日志系统一泄露就是二次事故；高并发下也是性能噪音。
- **严重度**：一般
- **修法**：删掉或只 log 脱敏后的 orderId。

---

## 修改清单（2/patched/orders.js）

1. L12：密钥改环境变量，缺失抛错（问题 4）
2. `/orders/:id`、`/merchant/:merchantId/orders`：参数化查询（问题 1）
3. `orderTotal`：整数分运算（问题 5）
4. `isToday`：本地日期比较（问题 7，保留函数但日报已不调用）
5. `/orders/:id/settle`：原子抢占 pending→settling，失败回滚，金额容差比较（问题 2、5）
6. `chargeCustomer`：amount 转分、检查 resp.ok、失败日志（问题 3、9）
7. `POST /orders`：price/qty/必填校验，删请求体日志（问题 8、10）
8. `/report/daily`：SQL 内按天过滤，去 LIMIT，sum 按分舍入（问题 6）

未动：表结构、路由形状、express/pg 依赖。`node --check` 通过。
