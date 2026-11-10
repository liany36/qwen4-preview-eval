> **明天能不能直接上线？**
>
> **不能。** 里面有 8 个致命问题：支付密钥写死在源码里、所有接口零鉴权、结算先查后写无锁会重复扣款、支付调用没有幂等键、两处 SQL 注入、金额用浮点严格相等导致合法订单结算不了、单价完全信任客户端。
> **最少改 4 类才能上**：① 密钥进环境变量 + 立刻在支付方轮换 ② 加鉴权并按 merchant 隔离 ③ 结算改成「条件更新抢占 + 事务 + 幂等键 + 整数分」 ④ 两处 SQL 参数化 + 服务端定价。改完这 4 类，剩下的分页、日报时区、日志脱敏建议同一批带上，否则会以另一种方式出事。

---

## 问题 1：支付私钥硬编码在源码里
- **位置**：`const PAYMENT_KEY`，第 13 行（文件顶部）
- **后果**：这把 `sk_live_` 是生产密钥。任何拿到这份代码的人（前外包、Git 历史、离职员工、代码被上传到任何仓库）都能直接调用支付方扣款/退款接口。上线当天起，账户就是敞开的；等发现时通常已经是拒付或提现异常。
- **严重度**：致命
- **修法**：密钥移到环境变量/密钥管理，代码里只读 `process.env.PAYMENT_KEY`，并在支付方后台立即轮换这一把（它已经泄露，改代码不等于收回）。

## 问题 2：全部接口没有任何鉴权，任何人能查所有订单、能触发扣款
- **位置**：`app.get('/orders')`、`app.get('/orders/:id')`、`app.get('/merchant/:merchantId/orders')`、`app.post('/orders/:id/settle')`、`app.get('/report/daily')`，第 16、21、31、52、123 行
- **后果**：没有中间件、没有 token 校验、没有 merchant 归属判断。任何人 `curl` 一下 `/orders` 就拿到全平台所有订单（含 customer_id）；更严重的是 `POST /orders/:id/settle` 谁都能调——不需要登录就能让别人的订单真的扣钱，或者拿别人的订单把自己刷成"已结算"。上线第一天就会被扫到。
- **严重度**：致命
- **修法**：加一层鉴权中间件解析身份，所有查询按 `merchant_id` 过滤，settle 前校验订单归属当前调用方。

## 问题 3：结算「先查后写」无事务无行锁，并发请求会重复扣款
- **位置**：`app.post('/orders/:id/settle')`，第 52–81 行（`SELECT` 在第 54 行，状态判断在第 61 行，`chargeCustomer` 在第 73 行，`UPDATE` 在第 79 行）
- **后果**：两个请求同时进来，都读到 `status='pending'`，都通过 `total !== expected_total` 检查，都去 `chargeCustomer`。用户被扣两次钱，但库里只有一条 settled 记录。客户端超时重发、用户连点两下、移动网络重试，都会命中。
- **严重度**：致命
- **修法**：在一个事务里 `SELECT ... FOR UPDATE` 锁住该行，或用 `UPDATE ... WHERE status='pending'` 的条件更新抢占，抢不到的直接返回"处理中"。

## 问题 4：调用支付时没有幂等键，失败重试=重复扣款
- **位置**：`chargeCustomer()`，第 83–106 行（第 91–96 行的请求体只有 `customer/amount/currency/reference`，没有幂等键）
- **后果**：支付方其实已经扣款成功，但响应超时/网络抖动 → `catch` 返回 `null` → 接口回 502，订单还是 pending；前端或用户再点一次结算，就再扣一次。`reference: orderId` 只是备注，支付方不会据此去重。
- **严重度**：致命
- **修法**：请求头带一个由订单号派生的幂等键（`Idempotency-Key`），并保存支付方返回的 charge_id，重试时先查已有 charge 而不是再发一次。

## 问题 5：`/orders/:id` 拼接 SQL，可注入
- **位置**：`app.get('/orders/:id')`，第 23 行（`'... WHERE id = ' + id`）
- **后果**：`/orders/1 OR 1=1` 直接拖库；`/orders/0 UNION SELECT ...` 能读出任意表。这个接口还没鉴权，等于把数据库只读权限挂在公网上。
- **严重度**：致命
- **修法**：改成 `$1` 占位符传参，并对 id 做整数校验。

## 问题 6：`/merchant/:merchantId/orders` 同样拼接 SQL
- **位置**：`app.get('/merchant/:merchantId/orders')`，第 34 行
- **后果**：同上，且这个路径天然是"按商户查"，注入点更显眼。攻击者能一次拉走所有商户的订单明细（客户 id、金额、时间），属于个人信息泄露，出事要报备。
- **严重度**：致命
- **修法**：参数化查询；`merchantId` 必须来自鉴权身份而不是 URL。

## 问题 7：金额用浮点算、再用 `!==` 严格比较，合法订单永远结算不了
- **位置**：`orderTotal()` 第 39–45 行，比较在第 67 行（`if (total !== row.expected_total)`）
- **后果**：客户端传 `price: 19.9, qty: 3` 时 `19.9*3 = 59.699999999999996`。下单那一刻写进库的 `expected_total` 若是 `numeric(12,2)` 列，读回来就是 `59.7`，与重算的 `59.699...` **永不相等** → 所有含小数单价的订单都回 400 `amount mismatch`，客服会收到一堆"付不了款"工单；而 `expected_total` 若也是浮点列，两边都带误差，则会在个别组合上差一分，账永远对不平。
- **严重度**：致命
- **修法**：金额统一用整数分（`Math.round(price*100)`），比较前不做浮点运算，直接比整数。

## 问题 8：单价完全信任客户端，可以下一分钱的单
- **位置**：`app.post('/orders')` 第 108–121 行取 `req.body.items`，`orderTotal` 用的是 `item.price`
- **后果**：`items` 里没有校验元素结构，`price` 和 `qty` 都由调用方给。攻击者传 `[{price: 0.01, qty: 1}]`，服务端就把 `expected_total = 0.01` 写进库，后面结算校验当然通过——花一分钱买到一万块的东西。传负数还能让总额为负，等于反向退款。
- **严重度**：致命
- **修法**：请求只收 `sku + qty`，单价一律从服务端价目表查；qty 必须是正整数，价目表查不到就拒单。

## 问题 9：异步路由没有 try/catch，一个异常请求能打挂整个进程
- **位置**：除 settle 外所有 `async` handler（第 16、21、31、108、123 行），以及 `db.connect()` 第 11 行
- **后果**：Express 4 不会捕获 async handler 的 rejection。数据库一抖动、`row.items` 不是数组、`settled_at` 为 null，就会变成 unhandledRejection。Node 20 默认直接退出进程——**一个畸形请求就能让整个订单服务下线**，而且客户端拿到的是连接被重置，不会看到 500。
- **严重度**：严重
- **修法**：给每个 async handler 套统一包装函数捕获异常并转 500；`db.connect()` 失败要有重连或直接快速失败退出。

## 问题 10：`/orders` 全表返回，没有分页也没有条数上限
- **位置**：`app.get('/orders')`，第 17 行
- **后果**：`SELECT * FROM orders ORDER BY created_at DESC` 无 WHERE、无 LIMIT。订单表涨到几十万行后，每次调用都要全表排序并把所有行 `JSON.stringify` 进内存——这是标准的"一个请求打满内存和数据库连接池"。配合问题 2 的零鉴权，任何人都能反复触发。
- **严重度**：严重
- **修法**：强制 `LIMIT`（默认 50，最大 200）+ 游标分页，并按鉴权身份过滤。

## 问题 11：日报用 UTC 日期判断 + 先 `LIMIT 5000` 再内存过滤，数字一定是错的
- **位置**：`app.get('/report/daily')`，第 123–130 行（`isToday` 在 47–50 行，`LIMIT 5000` 在第 125 行，内存过滤在第 127 行）
- **后果**：两处错。① `toISOString()` 是 UTC，北京时间 00:00–08:00 的订单会被算进"昨天"，财务每天早上的日报都对不上账。② 先取最近 5000 条再在 JS 里筛今天，一旦当天结算量超过 5000 条，日报直接少报，而且不报错——这是最危险的一类错：看起来正常。另外求和用的是 `expected_total`（应收）而不是实收。
- **严重度**：严重
- **修法**：日期边界用业务时区在 SQL 里算（`settled_at >= $1 AND settled_at < $2`），求和交给数据库 `SUM`，去掉 `LIMIT`。

## 问题 12：创建订单时把完整请求体打进日志
- **位置**：`app.post('/orders')`，第 109 行 `console.log('create order', req.body)`
- **后果**：`req.body` 含 `customer_id`、`merchant_id`、商品明细。日志一般保留 30–180 天、可被运维和第三方日志平台读取，等于把客户信息复制了一份到不受控的地方。合规审计会直接提这一条。
- **严重度**：一般
- **修法**：只记录订单号、商户号和金额，不记录 customer_id 与 items 原文。

---

## 改了什么（`patched/orders.js`）

1. `PAYMENT_KEY` 改读 `process.env.PAYMENT_KEY`，缺失时启动即失败（不再静默用空 key 发请求）。
2. 新增 `auth` 中间件：校验 `Authorization: Bearer`，把 `merchant_id` 挂到 `req.merchant`，所有查询与结算按它过滤；无 token 一律 401。
3. 两处拼接 SQL 改 `$1` 参数化，并对 id 做整数校验。
4. 金额全面改成整数分：`toCents()` 只做一次 `Math.round`，`orderTotal()` 用整数累加，比较用 `!==` 比整数。
5. 下单只接受 `{sku, qty}`，单价从 `product_prices` 表查（查不到 → 400），qty 必须正整数。
6. settle 改为「条件更新抢占」：`UPDATE ... SET status='settling' WHERE id=$1 AND status='pending' RETURNING *`，抢不到的直接返回 409，从根上消除并发双扣；异常时把订单放回 pending，不会卡死。
7. 调用支付带 `Idempotency-Key`（由订单号派生），并把成功返回的 charge_id 落库，重试先查已有扣款。
8. 所有 async handler 包 `wrap()` 统一捕获异常 → 500，不再有 unhandledRejection。
9. `/orders` 加 `LIMIT` + 游标分页；`/report/daily` 改 SQL 内按业务时区聚合。
10. 日志不再打印 `req.body` 原文。

> 假设：`product_prices(sku, price_cents, currency)` 与 `orders.charge_id`、`orders.currency` 三处结构需建表/加列；
> 支付方支持 `Idempotency-Key` 请求头（多数 v2 支付 API 都有，若没有则需改用"带 reference 查询"策略）。
