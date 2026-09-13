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
  initialized ||= client.query(`
    CREATE TABLE IF NOT EXISTS inventory_bom (
      bom_id TEXT PRIMARY KEY,
      bom_name TEXT NOT NULL,
      category TEXT NOT NULL,
      price NUMERIC NOT NULL CHECK (price >= 0),
      opening_balance INTEGER NOT NULL CHECK (opening_balance >= 0),
      current_balance INTEGER NOT NULL CHECK (current_balance >= 0),
      safety_stock_level INTEGER NOT NULL CHECK (safety_stock_level >= 0),
      created_by INTEGER NOT NULL,
      created_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await initialized;
}

async function getBom(bomId) {
  const rows = await connection().query('SELECT * FROM inventory_bom WHERE bom_id = $1', [bomId]);
  return withStatus(rows[0]);
}

async function listBoms({ search = '', status = 'All' } = {}) {
  const clauses = [];
  const values = [];
  if (search.trim()) {
    values.push(`%${search.trim()}%`);
    clauses.push(`bom_name ILIKE $${values.length}`);
  }
  if (status === 'Low Stock') clauses.push('current_balance <= safety_stock_level');
  if (status === 'Available') clauses.push('current_balance > safety_stock_level');
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = await connection().query(`SELECT * FROM inventory_bom${where} ORDER BY bom_name`, values);
  return rows.map(withStatus);
}

async function createBom(values, userId) {
  await connection().query(
    `INSERT INTO inventory_bom
      (bom_id, bom_name, category, price, opening_balance, current_balance, safety_stock_level, created_by)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7)`,
    [values.bom_id, values.bom_name, values.category, values.price, values.balance, values.safety_stock_level, userId]
  );
  return getBom(values.bom_id);
}

async function updateBom(bomId, values) {
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
  const rows = await connection().query('DELETE FROM inventory_bom WHERE bom_id = $1 RETURNING bom_id', [bomId]);
  return rows.length === 1;
}

async function exists(bomId) {
  const rows = await connection().query('SELECT 1 FROM inventory_bom WHERE bom_id = $1', [bomId]);
  return rows.length > 0;
}

module.exports = { initialize, getBom, listBoms, createBom, updateBom, deleteBom, exists };