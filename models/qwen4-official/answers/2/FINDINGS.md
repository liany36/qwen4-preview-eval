# 上线判断（三行以内）

**明天不能直接接支付上线。** 最少必须改四处：① settle 的并发双扣（原子占位 + 支付幂等）；② 两处 SQL 注入参数化；③ 生产密钥移出代码并作废轮换；④ 金额改整数分比较 + 下单输入校验。这四处改完、支付方确认 reference 幂等语义后，才可灰度上线；其余问题可随后修。

---

## 问题 1：settle 并发双扣——同一订单能被扣两次钱
- **位置**：`app.post('/orders/:id/settle')`，原文件 52–81 行（读 54 → 判 61 → 扣 73 → 写 79）
- **后果**：两个请求（用户双击、前端重试、网关超时重发）同时进来，都读到 `status='pending'`，都通过 61 行的检查，各自调一次 `chargeCustomer`，客户被扣两笔钱，第二笔没有任何记录能追回。这是直接的资金损失，上线第一天就会发生。
- **严重度**：致命
- **修法**：扣款前用一条带条件的 UPDATE 原子占位（pending→settling），抢不到就拒绝；支付请求带订单号做幂等键。

## 问题 2：SQL 注入（两处，同一类）
- **位置**：`GET /orders/:id` 23 行、`GET /merchant/:merchantId/orders` 34 行
- **后果**：URL 参数直接拼进 SQL。任何人构造 `/orders/1 OR 1=1` 或 union 注入，就能拖走全库订单（含客户 ID、金额），甚至写库删库。接口无鉴权，等于把数据库裸奔在公网上。
- **严重度**：致命
- **修法**：全部改 `$1` 参数化查询。

## 问题 3：生产支付密钥硬编码在源码里
- **位置**：13 行 `const PAYMENT_KEY = 'sk_live_…'`
- **后果**：`sk_live` 是生产密钥，任何拿到代码的人（外包全员、仓库历史、日志截图）都能直接调支付接口扣款/退款。代码已经在外包手里流转过，必须视为已泄露。
- **严重度**：致命
- **修法**：改读环境变量，并立刻在支付平台作废这把 key、换新的。

## 问题 4：金额用浮点累加 + `!==` 严格比较，合法订单会被拒结算
- **位置**：`orderTotal` 39–45 行；settle 里 67 行 `total !== row.expected_total`
- **后果**：`0.1*3 + 0.2` 这类浮点误差会让 `total` 和下单时存的 `expected_total` 差一个 epsilon，67 行严格不等直接 400。客户下得了单、付不了款，客服会被"金额不符"投诉淹没；反过来若误差方向有利，也可能放过不该放的单。
- **严重度**：严重
- **修法**：金额一律换算成整数"分"再累加和比较。

## 问题 5：下单不校验价格/数量，NaN 或负数金额能入库
- **位置**：`app.post('/orders')` 108–121 行，`orderTotal(items)` 115 行
- **后果**：`items` 里缺 price/qty、传字符串、传负数都不拦。`NaN` 会被 `JSON.stringify` 存成 null 进 `expected_total`；负价格能造出负总额订单，结算时给客户"倒找钱"。脏数据一旦入库，对账永远对不平。
- **严重度**：严重
- **修法**：下单时校验每个 item 的 price>0、qty 为正整数，非法直接 400。

## 问题 6：支付失败被静默吞掉，且超时≠没扣款
- **位置**：`chargeCustomer` 83–106 行，catch 里 104 行 `return null`；98 行不看 `resp.ok`
- **后果**：网络超时/断网时，网关侧可能已经扣款成功，但这里一律当失败返回 502，订单留在 pending；用户重试又扣一笔（叠加问题 1）。HTTP 500 的错误页若不是 JSON，`resp.json()` 抛错也走同一条吞错路径，运维看不到任何日志。
- **严重度**：严重
- **修法**：检查 `resp.ok`、记录异常日志；重试必须依赖支付侧按 reference 幂等（上线前与支付方确认）。

## 问题 7：日报取最近 5000 条回内存筛"今天"，量大就漏算
- **位置**：`GET /report/daily` 123–130 行，`LIMIT 5000` + `isToday` 过滤
- **后果**：当天结算超过 5000 单时，早于最近 5000 条的当日订单被截掉，日报金额偏小，财务对账对不上。另外 `isToday` 用 UTC 日界，东八区早上 8 点前的单会被算进"昨天"。
- **严重度**：严重
- **修法**：把"今天"的过滤和 SUM 下推到 SQL（`settled_at >= date_trunc('day', now())`），并明确时区口径。

## 问题 8：所有 async handler 无 try/catch，DB 一抖就挂请求/崩进程
- **位置**：全部路由（16、21、31、52、108、123 行）；11 行 `db.connect()` 无 catch
- **后果**：任何一次 DB 断连/查询抛错，async handler 的 rejection 无人接住：请求永远挂起（客户端转圈），Node 18+ 默认还会因 unhandledRejection 直接退出进程。数据库抖一下，整个服务就没了。
- **严重度**：严重
- **修法**：每个 handler 包 try/catch 交给统一错误中间件返回 500；`db.connect()` 加 catch 并退出交给进程管理器重启。

---

## 补丁改动清单（`patched/orders.js`，相对原文件）

1. 13 行：`PAYMENT_KEY` 改读 `process.env.PAYMENT_KEY`（endpoint 也可环境变量覆盖）。
2. 23、34 行：两处拼接 SQL 改 `$1` 参数化。
3. 新增 `toCents` / `orderTotalCents`：金额按整数分计算；settle 67 行与下单 115 行都用分比较/入库（对外 total 仍返回元，保持兼容）。
4. settle：扣款前新增原子占位 `UPDATE … WHERE status='pending'`（pending→settling），失败回滚 pending；扣款失败不再直接写 settled。
5. `chargeCustomer`：检查 `resp.ok`；catch 里打日志不再静默；注释标明 reference 幂等与超时风险。
6. `POST /orders`：校验 merchant_id/customer_id 必填、items 为非空数组、每项 price>0 且 qty 正整数。
7. `/report/daily`：改为 SQL 内按当日过滤 + COUNT/SUM，去掉 LIMIT 5000 与内存 `isToday`（时区口径注释说明）。
8. 全部路由包 try/catch + 末尾统一错误中间件；`db.connect().catch` 退出；端口可用 `PORT` 覆盖。

未改动：表结构、接口路径、返回字段形状（除 daily 的 sum 用 Number 归一）、`reference=orderId` 的支付约定。