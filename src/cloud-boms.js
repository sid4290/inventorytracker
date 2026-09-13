const { neon } = require('@neondatabase/serverless');

let sql;
let initialized;

function connection() {
  if (!process.env.DATABASE_URL) return null;
  sql ||= neon(process.env.DATABASE_URL);
  return sql;
}

function withStatus(row) {
  if (!row) return null;
  return {
    ...row,
    price: Number(row.price),
    opening_balance: Number(row.opening_balance),
    current_balance: Number(row.current_balance),
    safety_stock_level: Number(row.safety_stock_level),
    stock_status: Number(row.current_balance) <= Number(row.safety_stock_level) ? 'Low Stock' : 'Available',
  };
}

async function initialize() {
  const client = connection();
  if (!client) return;
  initialized ||= (async () => {
    await client.query(`CREATE TABLE IF NOT EXISTS inventory_bom (
      bom_id TEXT PRIMARY KEY, bom_name TEXT NOT NULL, category TEXT NOT NULL,
      price NUMERIC NOT NULL CHECK (price >= 0),
      opening_balance INTEGER NOT NULL CHECK (opening_balance >= 0),
      current_balance INTEGER NOT NULL CHECK (current_balance >= 0),
      safety_stock_level INTEGER NOT NULL CHECK (safety_stock_level >= 0),
      created_by INTEGER NOT NULL, created_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS inventory_transaction (
      txn_id SERIAL PRIMARY KEY, bom_id TEXT NOT NULL REFERENCES inventory_bom(bom_id) ON DELETE CASCADE,
      txn_type TEXT NOT NULL CHECK (txn_type IN ('IN', 'OUT')), quantity INTEGER NOT NULL CHECK (quantity > 0),
      txn_date TIMESTAMPTZ NOT NULL DEFAULT NOW(), performed_by INTEGER NOT NULL, purchase_order_id INTEGER
    )`);
    try { await client.query('ALTER TABLE inventory_transaction ADD COLUMN purchase_order_id INTEGER'); } catch {}
    await client.query(`CREATE TABLE IF NOT EXISTS inventory_purchase_order (
      po_id SERIAL PRIMARY KEY, bom_id TEXT NOT NULL REFERENCES inventory_bom(bom_id) ON DELETE CASCADE,
      suggested_reorder_qty INTEGER NOT NULL CHECK (suggested_reorder_qty > 0),
      status TEXT NOT NULL DEFAULT 'Generated' CHECK (status IN ('Generated', 'Reviewed')),
      generated_date TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_by INTEGER
    )`);
  })().catch((error) => {
    initialized = undefined;
    throw error;
  });
  await initialized;
}

async function getBom(bomId) {
  await initialize();
  const rows = await connection().query('SELECT * FROM inventory_bom WHERE bom_id = $1', [bomId]);
  return withStatus(rows[0]);
}

async function listBoms({ search = '', status = 'All' } = {}) {
  await initialize();
  const clauses = [];
  const values = [];
  if (search.trim()) {
    values.push(`%${search.trim()}%`);
    clauses.push(`(bom_name ILIKE $${values.length} OR bom_id ILIKE $${values.length})`);
  }
  if (status === 'Low Stock') clauses.push('current_balance <= safety_stock_level');
  if (status === 'Available') clauses.push('current_balance > safety_stock_level');
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = await connection().query(`SELECT * FROM inventory_bom${where} ORDER BY bom_name`, values);
  return rows.map(withStatus);
}

async function createBom(values, userId) {
  await initialize();
  await connection().query(
    `INSERT INTO inventory_bom
      (bom_id, bom_name, category, price, opening_balance, current_balance, safety_stock_level, created_by)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7)`,
    [values.bom_id, values.bom_name, values.category, values.price, values.balance, values.safety_stock_level, userId]
  );
  return getBom(values.bom_id);
}

async function updateBom(bomId, values) {
  await initialize();
  const rows = await connection().query(
    `UPDATE inventory_bom
     SET bom_name = $1, category = $2, price = $3, safety_stock_level = $4
     WHERE bom_id = $5
     RETURNING *`,
    [values.bom_name, values.category, values.price, values.safety_stock_level, bomId]
  );
  return withStatus(rows[0]);
}

async function deleteBom(bomId) {
  await initialize();
  const rows = await connection().query('DELETE FROM inventory_bom WHERE bom_id = $1 RETURNING bom_id', [bomId]);
  return rows.length === 1;
}

async function exists(bomId) {
  await initialize();
  const rows = await connection().query('SELECT 1 FROM inventory_bom WHERE bom_id = $1', [bomId]);
  return rows.length > 0;
}

async function listLowStock() {
  await initialize();
  const rows = await connection().query(`
    SELECT *, safety_stock_level - current_balance AS shortfall
    FROM inventory_bom
    WHERE current_balance <= safety_stock_level
    ORDER BY shortfall DESC, bom_name`);
  return rows.map(withStatus);
}

async function listTransactions(limit = 50) {
  await initialize();
  return connection().query(`
    SELECT t.*, b.bom_name
    FROM inventory_transaction t
    JOIN inventory_bom b ON b.bom_id = t.bom_id
    ORDER BY t.txn_date DESC, t.txn_id DESC
    LIMIT $1`, [limit]);
}

async function maybeGeneratePurchaseOrder(bomId) {
  const bom = await getBom(bomId);
  if (!bom || bom.current_balance > bom.safety_stock_level) return null;
  const open = await connection().query(
    `SELECT po_id FROM inventory_purchase_order WHERE bom_id = $1 AND status = 'Generated'`, [bomId]
  );
  if (open.length) return null;
  const qty = Math.max(100, bom.safety_stock_level - bom.current_balance);
  const rows = await connection().query(
    'INSERT INTO inventory_purchase_order (bom_id, suggested_reorder_qty) VALUES ($1, $2) RETURNING *',
    [bomId, qty]
  );
  return rows[0];
}

async function recordTransaction({ bom_id, txn_type, quantity }, userId) {
  await initialize();
  const qty = Number(quantity);
  if (!['IN', 'OUT'].includes(txn_type)) throw new Error('Choose stock-in or stock-out');
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('Quantity must be a whole number greater than 0');
  const bom = await getBom(bom_id);
  if (!bom) throw new Error('BoM not found');
  if (txn_type === 'OUT' && qty > bom.current_balance) throw new Error(`Only ${bom.current_balance} available - cannot issue ${qty}`);
  const delta = txn_type === 'IN' ? qty : -qty;
  const openPo = txn_type === 'IN'
    ? await connection().query("SELECT po_id FROM inventory_purchase_order WHERE bom_id = $1 AND status = 'Generated' ORDER BY po_id LIMIT 1", [bom_id])
    : [];
  await connection().query('UPDATE inventory_bom SET current_balance = current_balance + $1 WHERE bom_id = $2', [delta, bom_id]);
  await connection().query(
    'INSERT INTO inventory_transaction (bom_id, txn_type, quantity, performed_by, purchase_order_id) VALUES ($1, $2, $3, $4, $5)',
    [bom_id, txn_type, qty, userId, openPo[0]?.po_id || null]
  );
  const purchaseOrder = await maybeGeneratePurchaseOrder(bom_id);
  return { bom: await getBom(bom_id), purchaseOrder, receivedAgainst: openPo[0] || null };
}

async function listPurchaseOrders() {
  await initialize();
  return connection().query(`
    SELECT p.*, b.bom_name, b.current_balance, b.safety_stock_level
    FROM inventory_purchase_order p
    JOIN inventory_bom b ON b.bom_id = p.bom_id
    ORDER BY CASE p.status WHEN 'Generated' THEN 0 ELSE 1 END, p.generated_date DESC`);
}

async function reviewPurchaseOrder(poId, userId) {
  await initialize();
  const rows = await connection().query(
    `UPDATE inventory_purchase_order SET status = 'Reviewed', reviewed_by = $1
     WHERE po_id = $2 AND status = 'Generated' RETURNING po_id`, [userId, poId]
  );
  return rows.length === 1;
}

async function dashboardSummary() {
  await initialize();
  const [total, low, open, recent] = await Promise.all([
    connection().query('SELECT COUNT(*)::int AS n FROM inventory_bom'),
    connection().query('SELECT COUNT(*)::int AS n FROM inventory_bom WHERE current_balance <= safety_stock_level'),
    connection().query("SELECT COUNT(*)::int AS n FROM inventory_purchase_order WHERE status = 'Generated'"),
    listTransactions(8),
  ]);
  return { totalBoms: total[0].n, lowStock: low[0].n, openPos: open[0].n, recent };
}

module.exports = {
  initialize, getBom, listBoms, createBom, updateBom, deleteBom, exists,
  listLowStock, listTransactions, recordTransaction, listPurchaseOrders,
  reviewPurchaseOrder, dashboardSummary,
};