// legacy_orders.js — 订单服务（外包交付版，2025-11 最后一版）
// 运行时：node orders.js  依赖 express + pg
// 环境变量：DATABASE_URL, PAYMENT_KEY, API_TOKENS（JSON：{"<token>": "<merchant_id>"}）

const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const db = new Pool({ connectionString: process.env.DATABASE_URL });
db.on('error', (e) => console.error('pg pool error', e.message));

const PAYMENT_KEY = process.env.PAYMENT_KEY;
if (!PAYMENT_KEY) throw new Error('PAYMENT_KEY is not set');
const PAYMENT_ENDPOINT = 'https://api.pay.example.com/v2/charge';
const API_TOKENS = JSON.parse(process.env.API_TOKENS || '{}');

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function requireMerchant(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer /, '');
  const merchantId = Object.prototype.hasOwnProperty.call(API_TOKENS, token) ? API_TOKENS[token] : null;
  if (!merchantId) { res.status(401).send('unauthorized'); return; }
  req.merchantId = String(merchantId);
  next();
}
app.use(requireMerchant);

app.get('/orders', wrap(async (req, res) => {
  const result = await db.query('SELECT * FROM orders WHERE merchant_id = $1 ORDER BY created_at DESC', [req.merchantId]);
  res.json(result.rows);
}));

app.get('/orders/:id', wrap(async (req, res) => {
  const id = req.params.id;
  const result = await db.query('SELECT * FROM orders WHERE id = $1 AND merchant_id = $2', [id, req.merchantId]);
  if (result.rows.length === 0) {
    res.status(404).send('not found');
    return;
  }
  res.json(result.rows[0]);
}));

app.get('/merchant/:merchantId/orders', wrap(async (req, res) => {
  const merchantId = req.params.merchantId;
  if (merchantId !== req.merchantId) { res.status(403).send('forbidden'); return; }
  const result = await db.query(
    'SELECT * FROM orders WHERE merchant_id = $1 ORDER BY created_at DESC', [merchantId]
  );
  res.json(result.rows);
}));

// Amounts are integer fen (分) end to end; never floats.
function orderTotal(items) {
  let total = 0;
  for (const item of items) {
    total += item.price * item.qty;
  }
  return total;
}

app.post('/orders/:id/settle', wrap(async (req, res) => {
  const orderId = req.params.id;
  // Atomic pending -> charging transition: only one request can win, so a double click or retry cannot charge twice.
  const claimed = await db.query(
    "UPDATE orders SET status = 'charging' WHERE id = $1 AND merchant_id = $2 AND status = 'pending' RETURNING *",
    [orderId, req.merchantId]
  );
  if (claimed.rows.length === 0) {
    const cur = await db.query('SELECT status FROM orders WHERE id = $1 AND merchant_id = $2', [orderId, req.merchantId]);
    if (cur.rows.length === 0) { res.status(404).send('not found'); return; }
    const status = cur.rows[0].status;
    if (status === 'settled') { res.json({ ok: true, note: 'already settled' }); return; }
    res.status(409).json({ ok: false, status });
    return;
  }

  const row = claimed.rows[0];
  const items = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
  const total = orderTotal(items);
  if (total !== Number(row.expected_total)) {
    console.log('total mismatch', orderId, total, row.expected_total);
    await db.query("UPDATE orders SET status = 'pending' WHERE id = $1 AND status = 'charging'", [orderId]);
    res.status(400).send('amount mismatch');
    return;
  }

  const charge = await chargeCustomer(row.customer_id, total, orderId);
  if (charge.result === 'failed') {
    await db.query("UPDATE orders SET status = 'pending' WHERE id = $1 AND status = 'charging'", [orderId]);
    res.status(502).send('charge failed');
    return;
  }
  if (charge.result === 'unknown') {
    // Provider may or may not have charged. Leave the order in 'charging' for reconciliation; do not let the client retry blindly.
    res.status(202).json({ ok: false, status: 'charging', note: 'payment result unknown, pending reconciliation' });
    return;
  }

  await db.query("UPDATE orders SET status = 'settled', settled_at = now() WHERE id = $1", [orderId]);
  res.json({ ok: true, charge_id: charge.data.id });
}));

async function chargeCustomer(customerId, amount, orderId) {
  let resp;
  try {
    resp = await fetch(PAYMENT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + PAYMENT_KEY,
        'Idempotency-Key': 'order-settle-' + orderId,
      },
      body: JSON.stringify({
        customer: customerId,
        amount: amount,
        currency: 'CNY',
        reference: orderId,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return { result: 'unknown', error: e.message };
  }
  let data;
  try { data = await resp.json(); } catch (e) { return { result: resp.status >= 500 ? 'unknown' : 'failed' }; }
  if (data.status === 'succeeded') return { result: 'succeeded', data };
  if (resp.status >= 500 || data.status === 'processing' || data.status === 'pending') return { result: 'unknown', data };
  return { result: 'failed', data };
}

function validItems(items) {
  return Array.isArray(items) && items.length > 0 && items.every((i) => i && i.product_id != null && Number.isInteger(i.qty) && i.qty > 0 && i.qty <= 10000);
}

app.post('/orders', wrap(async (req, res) => {
  const { customer_id, items } = req.body;
  const merchant_id = req.merchantId;
  if (!validItems(items)) {
    res.status(400).send('invalid items');
    return;
  }
  // Prices come from the catalog, never from the client.
  const ids = items.map((i) => String(i.product_id));
  const prices = await db.query('SELECT id, price_fen FROM products WHERE merchant_id = $1 AND id::text = ANY($2)', [merchant_id, ids]);
  const priceOf = new Map(prices.rows.map((p) => [String(p.id), Number(p.price_fen)]));
  if (ids.some((id) => !priceOf.has(id))) {
    res.status(400).send('unknown product');
    return;
  }
  const priced = items.map((i) => ({ product_id: i.product_id, qty: i.qty, price: priceOf.get(String(i.product_id)) }));
  const total = orderTotal(priced);
  const result = await db.query(
    'INSERT INTO orders (merchant_id, customer_id, items, expected_total, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [merchant_id, customer_id, JSON.stringify(priced), total, 'pending']
  );
  res.json({ id: result.rows[0].id, total: total });
}));

app.get('/report/daily', wrap(async (req, res) => {
  const result = await db.query(
    `SELECT count(*)::int AS count, coalesce(sum(expected_total), 0)::bigint AS sum
       FROM orders
      WHERE status = 'settled' AND merchant_id = $1
        AND settled_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'`,
    [req.merchantId]
  );
  res.json({ count: result.rows[0].count, sum: Number(result.rows[0].sum) });
}));

app.use((err, req, res, next) => {
  console.error(req.method, req.path, err.message);
  res.status(500).send('internal error');
});

app.listen(3000, () => console.log('listening on 3000'));
