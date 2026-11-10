// orders.js — 修补版（最小改动，保持原有路由与响应结构）
// 运行时：node orders.js  依赖 express + pg
//
// 与原版的差异见 ../FINDINGS.md 末尾清单。所有改动都围绕"能不能接支付上线"，
// 没有重构目录结构、没有引入新框架。

const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '256kb' }));

/* ---------- 密钥：必须有，缺失就不启动 ---------- */
const PAYMENT_KEY = process.env.PAYMENT_KEY;
const PAYMENT_ENDPOINT = process.env.PAYMENT_ENDPOINT || 'https://api.pay.example.com/v2/charge';
if (!PAYMENT_KEY) {
  console.error('[fatal] PAYMENT_KEY 未配置，拒绝启动');
  process.exit(1);
}

/* ---------- 连接池：连接失败不再静默 ---------- */
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});
db.on('error', (e) => console.error('[db] idle client error', e.message));

/* ---------- 工具 ---------- */
// 金额一律用整数分。只在入口处做一次四舍五入，之后全程整数运算。
function toCents(v) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  return Math.round(n * 100);
}

function orderTotalCents(items) {
  let total = 0;
  for (const item of items) {
    if (!Number.isInteger(item.price_cents) || item.price_cents < 0) return null;
    if (!Number.isInteger(item.qty) || item.qty <= 0) return null;
    total += item.price_cents * item.qty;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function parseId(raw) {
  if (!/^\d{1,15}$/.test(String(raw))) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

// Express 4 不会捕获 async handler 的 rejection，必须自己包。
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/* ---------- 鉴权：从 token 解出 merchant，绝不信任 URL / body 里的 merchant_id ---------- */
async function auth(req, res, next) {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return res.status(401).json({ error: 'unauthorized' });
  try {
    const r = await db.query(
      'SELECT merchant_id FROM api_tokens WHERE token = $1 AND revoked_at IS NULL',
      [m[1]]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'unauthorized' });
    req.merchant = r.rows[0].merchant_id;
    next();
  } catch (e) {
    next(e);
  }
}

/* ---------- 查询 ---------- */
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

app.get('/orders', auth, wrap(async (req, res) => {
  const limit = Math.min(PAGE_MAX, Math.max(1, parseInt(req.query.limit, 10) || PAGE_DEFAULT));
  const before = req.query.before ? new Date(req.query.before) : null;
  const params = [req.merchant, limit];
  let sql = 'SELECT * FROM orders WHERE merchant_id = $1';
  if (before && !isNaN(before.getTime())) {
    params.push(before);
    sql += ` AND created_at < $${params.length}`;
  }
  sql += ' ORDER BY created_at DESC LIMIT $2';
  const result = await db.query(sql, params);
  res.json(result.rows);
}));

app.get('/orders/:id', auth, wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'bad id' });
  const result = await db.query(
    'SELECT * FROM orders WHERE id = $1 AND merchant_id = $2',
    [id, req.merchant]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json(result.rows[0]);
}));

app.get('/merchant/:merchantId/orders', auth, wrap(async (req, res) => {
  // merchantId 只用于校验，真正的过滤条件来自 token
  if (String(req.merchant) !== String(req.params.merchantId)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const limit = Math.min(PAGE_MAX, Math.max(1, parseInt(req.query.limit, 10) || PAGE_DEFAULT));
  const result = await db.query(
    'SELECT * FROM orders WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT $2',
    [req.merchant, limit]
  );
  res.json(result.rows);
}));

/* ---------- 结算 ---------- */
app.post('/orders/:id/settle', auth, wrap(async (req, res) => {
  const orderId = parseId(req.params.id);
  if (orderId === null) return res.status(400).json({ error: 'bad id' });

  // 第一步：用条件更新原子地"抢占"这笔订单，避免两个请求同时扣款。
  // status: pending -> settling；抢不到说明别人正在处理或已经处理完。
  const claim = await db.query(
    `UPDATE orders SET status = 'settling', settling_at = now()
     WHERE id = $1 AND merchant_id = $2 AND status = 'pending'
     RETURNING *`,
    [orderId, req.merchant]
  );

  if (!claim.rows.length) {
    const cur = await db.query(
      'SELECT status, charge_id FROM orders WHERE id = $1 AND merchant_id = $2',
      [orderId, req.merchant]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'not found' });
    const st = cur.rows[0].status;
    if (st === 'settled') return res.json({ ok: true, note: 'already settled', charge_id: cur.rows[0].charge_id });
    if (st === 'settling') return res.status(409).json({ error: 'settling in progress' });
    return res.status(409).json({ error: 'order not payable', status: st });
  }

  const row = claim.rows[0];
  try {
    // 金额校验：两边都必须是整数分。expected_total 若还是浮点旧数据，这里会拦住而不是误判。
    const totalCents = orderTotalCents(row.items);
    const expectedCents = Number.isInteger(row.expected_total_cents)
      ? row.expected_total_cents
      : toCents(row.expected_total);

    if (totalCents === null || totalCents !== expectedCents) {
      await db.query(
        "UPDATE orders SET status = 'pending', settling_at = NULL WHERE id = $1",
        [orderId]
      );
      console.warn('[settle] amount mismatch', { orderId, totalCents, expectedCents });
      return res.status(400).json({ error: 'amount mismatch' });
    }

    const charge = await chargeCustomer(row.customer_id, totalCents, orderId, row.currency || 'CNY');
    if (!charge) {
      await db.query(
        "UPDATE orders SET status = 'pending', settling_at = NULL WHERE id = $1",
        [orderId]
      );
      return res.status(502).json({ error: 'charge failed' });
    }

    await db.query(
      "UPDATE orders SET status = 'settled', settled_at = now(), charge_id = $2, settling_at = NULL WHERE id = $1",
      [orderId, charge.id]
    );
    res.json({ ok: true, charge_id: charge.id });
  } catch (e) {
    // 任何异常都要把订单从 settling 放回 pending，否则这单永远卡住。
    await db.query("UPDATE orders SET status = 'pending', settling_at = NULL WHERE id = $1", [orderId])
      .catch((e2) => console.error('[settle] rollback failed', orderId, e2.message));
    throw e;
  }
}));

async function chargeCustomer(customerId, amountCents, orderId, currency) {
  try {
    const resp = await fetch(PAYMENT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PAYMENT_KEY}`,
        // 幂等键：同一订单重试命中同一笔，不会重复扣款
        'Idempotency-Key': `settle-${orderId}`
      },
      body: JSON.stringify({
        customer: customerId,
        amount: amountCents,
        amount_unit: 'cent',
        currency,
        reference: String(orderId)
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) {
      console.error('[pay] http', resp.status, await resp.text().catch(() => ''));
      return null;
    }
    const data = await resp.json();
    if (data.status !== 'succeeded') {
      console.error('[pay] not succeeded', orderId, data.status);
      return null;
    }
    return data;
  } catch (e) {
    console.error('[pay] request failed', orderId, e.message);
    return null;
  }
}

/* ---------- 下单：只收 sku + qty，单价一律服务端查 ---------- */
app.post('/orders', auth, wrap(async (req, res) => {
  const { customer_id, items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'empty items' });
  }
  if (items.length > 100) return res.status(400).json({ error: 'too many items' });

  const skus = [];
  for (const it of items) {
    if (!it || typeof it.sku !== 'string' || !/^[\w.-]{1,64}$/.test(it.sku)) {
      return res.status(400).json({ error: 'bad sku' });
    }
    if (!Number.isInteger(it.qty) || it.qty <= 0 || it.qty > 9999) {
      return res.status(400).json({ error: 'bad qty' });
    }
    skus.push(it.sku);
  }

  const priceRes = await db.query(
    'SELECT sku, price_cents FROM product_prices WHERE sku = ANY($1)',
    [skus]
  );
  const priceMap = new Map(priceRes.rows.map((r) => [r.sku, r.price_cents]));

  const priced = items.map((it) => {
    const cents = priceMap.get(it.sku);
    return { sku: it.sku, qty: it.qty, price_cents: cents === undefined ? null : cents };
  });
  if (priced.some((p) => !Number.isInteger(p.price_cents))) {
    return res.status(400).json({ error: 'unknown sku' });
  }

  const totalCents = orderTotalCents(priced);
  if (totalCents === null || totalCents <= 0) {
    return res.status(400).json({ error: 'bad amount' });
  }

  const currency = 'CNY';
  const result = await db.query(
    `INSERT INTO orders (merchant_id, customer_id, items, expected_total_cents, currency, status)
     VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id`,
    [req.merchant, String(customer_id), JSON.stringify(priced), totalCents, currency]
  );

  // 日志里不再打印客户信息与明细原文
  console.log('[order] created', { id: result.rows[0].id, merchant: req.merchant, total: totalCents, lines: priced.length });
  res.json({ id: result.rows[0].id, total: totalCents / 100, total_cents: totalCents, currency });
}));

/* ---------- 日报：日期边界与时区都在 SQL 里算，求和交给数据库 ---------- */
app.get('/report/daily', auth, wrap(async (req, res) => {
  // 默认按 Asia/Shanghai 的业务日；可用 ?date=YYYY-MM-DD 指定
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const result = await db.query(
    `SELECT count(*)::int AS count,
            COALESCE(sum(COALESCE(settled_amount_cents, expected_total_cents)), 0)::bigint AS sum_cents
       FROM orders
      WHERE merchant_id = $1
        AND status = 'settled'
        AND settled_at >= COALESCE($2::date, (now() AT TIME ZONE 'Asia/Shanghai')::date) AT TIME ZONE 'Asia/Shanghai'
        AND settled_at <  (COALESCE($2::date, (now() AT TIME ZONE 'Asia/Shanghai')::date) + INTERVAL '1 day') AT TIME ZONE 'Asia/Shanghai'`,
    [req.merchant, date]
  );
  const r = result.rows[0];
  res.json({ count: r.count, sum_cents: Number(r.sum_cents), sum: Number(r.sum_cents) / 100 });
}));

/* ---------- 统一错误处理 ---------- */
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.path, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal' });
});

const PORT = Number(process.env.PORT) || 3000;
const server = app.listen(PORT, () => console.log('listening on ' + PORT));

process.on('unhandledRejection', (e) => {
  console.error('[fatal] unhandledRejection', e);
  server.close(() => process.exit(1));
});

module.exports = { app, toCents, orderTotalCents, parseId };
