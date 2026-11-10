// orders.js — 订单服务（上线前修补）
// 运行时：node orders.js
// 必须的环境变量：DATABASE_URL、PAYMENT_KEY、API_TOKEN
// 仓库里曾经写死的 sk_live 密钥视为已泄露，作废后再把新密钥放进 PAYMENT_KEY。

const express = require('express');
const { Client } = require('pg');

const PAYMENT_KEY = process.env.PAYMENT_KEY;
const API_TOKEN = process.env.API_TOKEN;
const PAYMENT_ENDPOINT = 'https://api.pay.example.com/v2/charge';

if (!PAYMENT_KEY || !API_TOKEN || !process.env.DATABASE_URL) {
  console.error('DATABASE_URL, PAYMENT_KEY and API_TOKEN are required');
  process.exit(1);
}

const app = express();
app.use(express.json());

const db = new Client({ connectionString: process.env.DATABASE_URL });
db.on('error', (err) => {
  console.error('db client error', err.message);
  process.exit(1);
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== API_TOKEN) {
    res.status(401).send('unauthorized');
    return;
  }
  next();
}

app.use(requireAuth);

function wrap(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.get('/orders', wrap(async (req, res) => {
  const result = await db.query('SELECT * FROM orders ORDER BY created_at DESC');
  res.json(result.rows);
}));

app.get('/orders/:id', wrap(async (req, res) => {
  const result = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (result.rows.length === 0) {
    res.status(404).send('not found');
    return;
  }
  res.json(result.rows[0]);
}));

app.get('/merchant/:merchantId/orders', wrap(async (req, res) => {
  const result = await db.query(
    'SELECT * FROM orders WHERE merchant_id = $1 ORDER BY created_at DESC',
    [req.params.merchantId]
  );
  res.json(result.rows);
}));

function lineCents(price, qty) {
  const p = typeof price === 'string' ? Number(price) : price;
  const q = typeof qty === 'string' ? Number(qty) : qty;
  if (!Number.isFinite(p) || !Number.isFinite(q) || p < 0 || q <= 0 || q > 1e6) return null;
  const cents = Math.round(p * q * 100);
  if (!Number.isSafeInteger(cents) || cents < 0) return null;
  return cents;
}

function toCents(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  if (!Number.isSafeInteger(cents)) return null;
  return cents;
}

function orderTotalCents(items) {
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch (e) {
      return null;
    }
  }
  if (!Array.isArray(items) || items.length === 0) return null;
  let cents = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') return null;
    const line = lineCents(item.price, item.qty);
    if (line === null) return null;
    cents += line;
  }
  if (!Number.isSafeInteger(cents)) return null;
  return cents;
}

app.post('/orders/:id/settle', wrap(async (req, res) => {
  const orderId = req.params.id;
  const claimed = await db.query(
    "UPDATE orders SET status = 'charging' WHERE id = $1 AND status = 'pending' RETURNING *",
    [orderId]
  );

  if (claimed.rows.length === 0) {
    const current = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    if (current.rows.length === 0) {
      res.status(404).send('not found');
      return;
    }
    if (current.rows[0].status === 'settled') {
      res.json({ ok: true, note: 'already settled' });
      return;
    }
    res.status(409).send('settle in progress');
    return;
  }

  const row = claimed.rows[0];
  const totalCents = orderTotalCents(row.items);
  const expectedCents = toCents(row.expected_total);
  if (totalCents === null || expectedCents === null || totalCents !== expectedCents) {
    await db.query(
      "UPDATE orders SET status = 'pending' WHERE id = $1 AND status = 'charging'",
      [orderId]
    );
    res.status(400).send('amount mismatch');
    return;
  }

  const charge = await chargeCustomer(row.customer_id, totalCents / 100, orderId);
  if (charge.result === 'succeeded') {
    await db.query(
      "UPDATE orders SET status = 'settled', settled_at = now() WHERE id = $1 AND status = 'charging'",
      [orderId]
    );
    res.json({ ok: true, charge_id: charge.id });
    return;
  }

  if (charge.result === 'failed') {
    await db.query(
      "UPDATE orders SET status = 'pending' WHERE id = $1 AND status = 'charging'",
      [orderId]
    );
    res.status(502).send('charge failed');
    return;
  }

  res.status(502).send('charge uncertain, reconcile before retry');
}));

async function chargeCustomer(customerId, amount, orderId) {
  try {
    const resp = await fetch(PAYMENT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + PAYMENT_KEY,
      },
      body: JSON.stringify({
        customer: customerId,
        amount: amount,
        currency: 'CNY',
        reference: orderId,
      }),
    });
    let data = null;
    try {
      data = await resp.json();
    } catch (e) {
      data = null;
    }
    if (resp.ok && data && data.status === 'succeeded') {
      return { result: 'succeeded', id: data.id };
    }
    if (resp.status >= 400 && resp.status < 500) {
      return { result: 'failed' };
    }
    if (resp.ok && data && data.status && data.status !== 'succeeded') {
      return { result: 'failed' };
    }
    return { result: 'uncertain' };
  } catch (e) {
    return { result: 'uncertain' };
  }
}

app.post('/orders', wrap(async (req, res) => {
  const { merchant_id, customer_id, items } = req.body || {};
  if (!merchant_id || !customer_id) {
    res.status(400).send('missing merchant or customer');
    return;
  }
  const totalCents = orderTotalCents(items);
  if (totalCents === null) {
    res.status(400).send('invalid items');
    return;
  }
  const total = totalCents / 100;
  const result = await db.query(
    'INSERT INTO orders (merchant_id, customer_id, items, expected_total, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [merchant_id, customer_id, JSON.stringify(items), total, 'pending']
  );
  res.json({ id: result.rows[0].id, total: total });
}));

app.get('/report/daily', wrap(async (req, res) => {
  const result = await db.query(
    `SELECT COUNT(*)::int AS count,
            COALESCE(SUM(expected_total), 0) AS sum
     FROM orders
     WHERE status = 'settled'
       AND settled_at IS NOT NULL
       AND (settled_at AT TIME ZONE 'Asia/Shanghai')::date
         = (now() AT TIME ZONE 'Asia/Shanghai')::date`
  );
  const row = result.rows[0];
  res.json({ count: row.count, sum: Number(row.sum) });
}));

app.use((err, req, res, next) => {
  console.error(err.message);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).send('internal error');
});

async function main() {
  await db.connect();
  app.listen(3000, () => console.log('listening on 3000'));
}

main().catch((err) => {
  console.error('startup failed', err.message);
  process.exit(1);
});
