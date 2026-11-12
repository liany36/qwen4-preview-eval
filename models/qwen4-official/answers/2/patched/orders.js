// orders.js — 订单服务（体检补丁版）
// 基于外包交付版 legacy_orders.js（2025-11 最后一版）做最小修改。
// 运行时：node orders.js  依赖 express + pg（Node >= 18，用全局 fetch）
// 改动清单见 ../FINDINGS.md 末尾。未改动的行为保持原样。

const express = require('express');
const { Client } = require('pg');

const app = express();
app.use(express.json());

const db = new Client({ connectionString: process.env.DATABASE_URL });
// 修复：connect 失败必须能看见，并以非零码退出，交给进程管理器重启
db.connect().catch((e) => {
  console.error('db connect failed', e);
  process.exit(1);
});

// 修复：生产密钥移出代码。旧 key 已泄露在仓库历史里，必须在支付平台作废轮换。
const PAYMENT_KEY = process.env.PAYMENT_KEY;
const PAYMENT_ENDPOINT = process.env.PAYMENT_ENDPOINT || 'https://api.pay.example.com/v2/charge';

// 金额统一用“分”（整数）计算与比较，避免浮点误差。
// 约定：item.price 的单位是元；若上游已用分，把 *100 去掉即可（见 FINDINGS 假设）。
function toCents(price) {
  return Math.round(Number(price) * 100);
}

function orderTotalCents(items) {
  let total = 0;
  for (const item of items) {
    total += toCents(item.price) * item.qty;
  }
  return total;
}

app.get('/orders', async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (e) { next(e); }
});

app.get('/orders/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    // 修复：SQL 注入 → 参数化
    const result = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      res.status(404).send('not found');
      return;
    }
    res.json(result.rows[0]);
  } catch (e) { next(e); }
});

app.get('/merchant/:merchantId/orders', async (req, res, next) => {
  try {
    const merchantId = req.params.merchantId;
    // 修复：SQL 注入 → 参数化
    const result = await db.query(
      'SELECT * FROM orders WHERE merchant_id = $1 ORDER BY created_at DESC',
      [merchantId]
    );
    res.json(result.rows);
  } catch (e) { next(e); }
});

app.post('/orders/:id/settle', async (req, res, next) => {
  try {
    const orderId = req.params.id;
    const order = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (order.rows.length === 0) {
      res.status(404).send('not found');
      return;
    }

    const row = order.rows[0];
    if (row.status === 'settled') {
      res.json({ ok: true, note: 'already settled' });
      return;
    }

    // 修复：金额用整数分比较，避免浮点 !== 误判
    const totalCents = orderTotalCents(row.items);
    if (totalCents !== Math.round(Number(row.expected_total) * 100)) {
      console.log('total mismatch', orderId, totalCents, row.expected_total);
      res.status(400).send('amount mismatch');
      return;
    }

    // 修复：并发双扣 → 先原子占位（pending → settling），抢不到说明有别的请求在处理
    const claim = await db.query(
      "UPDATE orders SET status = 'settling' WHERE id = $1 AND status = 'pending' RETURNING id",
      [orderId]
    );
    if (claim.rowCount === 0) {
      res.status(409).send('order is being settled or not pending');
      return;
    }

    const charge = await chargeCustomer(row.customer_id, totalCents, orderId);
    if (!charge) {
      // 扣款未确认：回滚占位，允许重试（chargeCustomer 带 reference，支付侧应幂等）
      await db.query("UPDATE orders SET status = 'pending' WHERE id = $1", [orderId]);
      res.status(502).send('charge failed');
      return;
    }

    await db.query("UPDATE orders SET status = 'settled', settled_at = now() WHERE id = $1", [orderId]);
    res.json({ ok: true, charge_id: charge.id });
  } catch (e) { next(e); }
});

async function chargeCustomer(customerId, amountCents, orderId) {
  try {
    const resp = await fetch(PAYMENT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + PAYMENT_KEY,
      },
      body: JSON.stringify({
        customer: customerId,
        amount: amountCents, // 单位：分（与支付网关约定一致；若网关收元，这里 /100）
        currency: 'CNY',
        reference: orderId, // 幂等键：同一订单重试不应产生第二笔扣款
      }),
    });
    // 修复：HTTP 非 2xx 不能当成功；网关错误页不是 JSON 时也不崩
    if (!resp.ok) {
      console.error('charge http error', orderId, resp.status);
      return null;
    }
    const data = await resp.json();
    if (data.status !== 'succeeded') {
      return null;
    }
    return data;
  } catch (e) {
    // 修复：不再静默吞错。注意：超时/断网时扣款可能已在网关侧成功，
    // 重试必须依赖 reference 幂等；上线前需与支付方确认该语义。
    console.error('charge exception', orderId, e);
    return null;
  }
}

app.post('/orders', async (req, res, next) => {
  try {
    const { merchant_id, customer_id, items } = req.body || {};
    // 修复：输入校验——缺字段、非数组、非法价格/数量一律 400，不再 NaN 入库或 500
    if (!merchant_id || !customer_id) {
      res.status(400).send('merchant_id and customer_id required');
      return;
    }
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).send('empty items');
      return;
    }
    for (const item of items) {
      const price = Number(item && item.price);
      const qty = Number(item && item.qty);
      if (!Number.isFinite(price) || price <= 0 || !Number.isInteger(qty) || qty <= 0) {
        res.status(400).send('invalid item price/qty');
        return;
      }
    }
    const totalCents = orderTotalCents(items);
    const total = totalCents / 100; // 对外仍用元，保持接口兼容
    const result = await db.query(
      'INSERT INTO orders (merchant_id, customer_id, items, expected_total, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [merchant_id, customer_id, JSON.stringify(items), total, 'pending']
    );
    res.json({ id: result.rows[0].id, total: total });
  } catch (e) { next(e); }
});

// 修复：日报在 SQL 里按“今天”过滤并聚合，不再取最近 5000 条回内存筛。
// 时区按业务约定：这里用 UTC 日界（与原 isToday 的 toISOString 行为一致）；
// 若财务口径是东八区，把 date_trunc 换成 (now() AT TIME ZONE 'Asia/Shanghai')::date 口径。
app.get('/report/daily', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(expected_total), 0) AS sum
       FROM orders
       WHERE status = 'settled' AND settled_at >= date_trunc('day', now())`
    );
    const row = result.rows[0];
    res.json({ count: row.count, sum: Number(row.sum) });
  } catch (e) { next(e); }
});

// 修复：统一错误处理——任何 handler 抛错都返回 500，而不是挂死请求/拖崩进程
app.use((err, req, res, next) => {
  console.error('unhandled error', req.method, req.originalUrl, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal error' });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log('listening on ' + PORT));