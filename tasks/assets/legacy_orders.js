// legacy_orders.js — 订单服务（外包交付版，2025-11 最后一版）
// 运行时：node orders.js  依赖 express + pg

const express = require('express');
const { Client } = require('pg');

const app = express();
app.use(express.json());

const db = new Client({ connectionString: process.env.DATABASE_URL });
db.connect();

const PAYMENT_KEY = 'sk_live_7Qm2xR9tLpA4vN8bW3yH6kD1sF5gJ0zC';
const PAYMENT_ENDPOINT = 'https://api.pay.example.com/v2/charge';

app.get('/orders', async (req, res) => {
  const result = await db.query('SELECT * FROM orders ORDER BY created_at DESC');
  res.json(result.rows);
});

app.get('/orders/:id', async (req, res) => {
  const id = req.params.id;
  const result = await db.query('SELECT * FROM orders WHERE id = ' + id);
  if (result.rows.length === 0) {
    res.status(404).send('not found');
    return;
  }
  res.json(result.rows[0]);
});

app.get('/merchant/:merchantId/orders', async (req, res) => {
  const merchantId = req.params.merchantId;
  const result = await db.query(
    'SELECT * FROM orders WHERE merchant_id = ' + merchantId + ' ORDER BY created_at DESC'
  );
  res.json(result.rows);
});

function orderTotal(items) {
  let total = 0;
  for (const item of items) {
    total += item.price * item.qty;
  }
  return total;
}

function isToday(isoString) {
  const today = new Date().toISOString().slice(0, 10);
  return isoString.slice(0, 10) === today;
}

app.post('/orders/:id/settle', async (req, res) => {
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

  const total = orderTotal(row.items);
  if (total !== row.expected_total) {
    console.log('total mismatch', orderId, total, row.expected_total);
    res.status(400).send('amount mismatch');
    return;
  }

  const charge = await chargeCustomer(row.customer_id, total, orderId);
  if (!charge) {
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
        amount: amount,
        currency: 'CNY',
        reference: orderId,
      }),
    });
    const data = await resp.json();
    if (data.status !== 'succeeded') {
      return null;
    }
    return data;
  } catch (e) {
    return null;
  }
}

app.post('/orders', async (req, res) => {
  console.log('create order', req.body);
  const { merchant_id, customer_id, items } = req.body;
  if (!items || items.length === 0) {
    res.status(400).send('empty items');
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
  const result = await db.query(
    "SELECT * FROM orders WHERE status = 'settled' ORDER BY settled_at DESC LIMIT 5000"
  );
  const rows = result.rows.filter((r) => isToday(r.settled_at.toISOString()));
  const sum = rows.reduce((acc, r) => acc + r.expected_total, 0);
  res.json({ count: rows.length, sum: sum });
});

app.listen(3000, () => console.log('listening on 3000'));
