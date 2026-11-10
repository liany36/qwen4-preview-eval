// legacy_orders.js — 订单服务（外包交付版，2025-11 最后一版）
// 运行时：node orders.js  依赖 express + pg

const express = require('express');
const { Client } = require('pg');

const app = express();
app.use(express.json());

const db = new Client({ connectionString: process.env.DATABASE_URL });
db.connect();

const PAYMENT_KEY = process.env.PAYMENT_KEY;
if (!PAYMENT_KEY) throw new Error('PAYMENT_KEY env var is required');
const PAYMENT_ENDPOINT = 'https://api.pay.example.com/v2/charge';

app.get('/orders', async (req, res) => {
  const result = await db.query('SELECT * FROM orders ORDER BY created_at DESC');
  res.json(result.rows);
});

app.get('/orders/:id', async (req, res) => {
  const id = req.params.id;
  const result = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
  if (result.rows.length === 0) {
    res.status(404).send('not found');
    return;
  }
  res.json(result.rows[0]);
});

app.get('/merchant/:merchantId/orders', async (req, res) => {
  const merchantId = req.params.merchantId;
  const result = await db.query(
    'SELECT * FROM orders WHERE merchant_id = $1 ORDER BY created_at DESC',
    [merchantId]
  );
  res.json(result.rows);
});

// money in integer cents: item.price is yuan, expected_total stored in cents
function orderTotal(items) {
  let cents = 0;
  for (const item of items) {
    cents += Math.round(item.price * 100) * item.qty;
  }
  return cents / 100;
}

function isToday(isoString) {
  // compare in server-local date, same basis as business day
  const d = new Date(isoString);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

app.post('/orders/:id/settle', async (req, res) => {
  const orderId = req.params.id;
  // atomic claim: only one concurrent request can move pending -> settling
  const claim = await db.query(
    "UPDATE orders SET status = 'settling' WHERE id = $1 AND status = 'pending' RETURNING *",
    [orderId]
  );
  if (claim.rows.length === 0) {
    const order = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (order.rows.length === 0) {
      res.status(404).send('not found');
      return;
    }
    if (order.rows[0].status === 'settled') {
      res.json({ ok: true, note: 'already settled' });
      return;
    }
    res.status(409).send('settlement already in progress');
    return;
  }

  const row = claim.rows[0];
  const total = orderTotal(row.items);
  if (Math.abs(total - row.expected_total) > 0.005) {
    console.log('total mismatch', orderId, total, row.expected_total);
    await db.query("UPDATE orders SET status = 'pending' WHERE id = $1", [orderId]);
    res.status(400).send('amount mismatch');
    return;
  }

  const charge = await chargeCustomer(row.customer_id, total, orderId);
  if (!charge) {
    await db.query("UPDATE orders SET status = 'pending' WHERE id = $1", [orderId]);
    res.status(502).send('charge failed');
    return;
  }

  await db.query("UPDATE orders SET status = 'settled', settled_at = now() WHERE id = $1", [orderId]);
  res.json({ ok: true, charge_id: charge.id });
});

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
        // gateway expects minor units (cents); total is yuan
        amount: Math.round(amount * 100),
        currency: 'CNY',
        reference: orderId,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || data.status !== 'succeeded') {
      console.error('charge rejected', orderId, resp.status, data);
      return null;
    }
    return data;
  } catch (e) {
    console.error('charge error', orderId, e.message);
    return null;
  }
}

app.post('/orders', async (req, res) => {
  const { merchant_id, customer_id, items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).send('empty items');
    return;
  }
  for (const it of items) {
    if (typeof it.price !== 'number' || !isFinite(it.price) || it.price <= 0 ||
        !Number.isInteger(it.qty) || it.qty <= 0) {
      res.status(400).send('invalid item price/qty');
      return;
    }
  }
  if (merchant_id == null || customer_id == null) {
    res.status(400).send('merchant_id and customer_id required');
    return;
  }
  const total = orderTotal(items);
  const result = await db.query(
    'INSERT INTO orders (merchant_id, customer_id, items, expected_total, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [merchant_id, customer_id, JSON.stringify(items), total, 'pending']
  );
  res.json({ id: result.rows[0].id, total: total });
});

app.get('/report/daily', async (req, res) => {
  // filter in SQL by business day (server-local midnight), not the latest 5000 rows
  const result = await db.query(
    "SELECT * FROM orders WHERE status = 'settled' AND settled_at >= date_trunc('day', now())"
  );
  const rows = result.rows;
  const sum = rows.reduce((acc, r) => acc + Number(r.expected_total), 0);
  res.json({ count: rows.length, sum: Math.round(sum * 100) / 100 });
});

app.listen(3000, () => console.log('listening on 3000'));
