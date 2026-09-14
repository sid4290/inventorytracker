// Business logic — one function group per SDD logic module (NFR-09 modularity).
const bcrypt = require('bcryptjs');
const { CATEGORIES, FIXED_REORDER_QTY } = require('./db');

class ValidationError extends Error {}

const EDIT_ROLES = ['Inventory Manager', 'System Administrator']; // FR14 / FR15
const canModifyBom = (role) => EDIT_ROLES.includes(role);

// ---------- INV-LOG-01: authentication ----------
function authenticate(db, username, password) {
  const user = db.prepare('SELECT * FROM User WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) return null; // FR2
  return { user_id: user.user_id, username: user.username, role: user.role };   // FR1
}

// ---------- INV-LOG-02: BoM CRUD + validation ----------
function validateBomInput(input, { isNew }) {
  const errors = {};
  const bom_id = String(input.bom_id || '').trim();
  const bom_name = String(input.bom_name || '').trim();
  const category = String(input.category || '').trim();
  const price = Number(input.price);
  const balance = Number(input.balance);
  const safety = Number(input.safety_stock_level);

  if (isNew && !bom_id) errors.bom_id = 'BoM ID is required';
  if (!bom_name) errors.bom_name = 'Name is required';
  if (!CATEGORIES.includes(category)) errors.category = 'Choose a category';
  if (input.price === '' || input.price == null || Number.isNaN(price) || price < 0) errors.price = 'Enter a price of 0 or more';
  if (!Number.isInteger(balance) || balance < 0) errors.balance = 'Enter a whole-number balance of 0 or more';
  if (!Number.isInteger(safety) || safety < 0) errors.safety_stock_level = 'Enter a whole-number safety stock level';

  return { errors, values: { bom_id, bom_name, category, price, balance, safety_stock_level: safety } };
}

function createBom(db, input, userId) {
  const { errors, values } = validateBomInput(input, { isNew: true }); // FR7
  if (Object.keys(errors).length) throw Object.assign(new ValidationError('Invalid BoM'), { errors });
  if (db.prepare('SELECT 1 FROM BoM WHERE bom_id = ?').get(values.bom_id)) {                // FR13
    throw Object.assign(new ValidationError('Duplicate'), { errors: { bom_id: `BoM ID ${values.bom_id} already exists` } });
  }
  // FR3/FR4: first entry captures the current balance as the opening balance
  db.prepare(`INSERT INTO BoM (bom_id, bom_name, category, price, opening_balance, current_balance, safety_stock_level, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(values.bom_id, values.bom_name, values.category, values.price, values.balance, values.balance, values.safety_stock_level, userId);
  maybeGeneratePurchaseOrder(db, values.bom_id);
  return getBom(db, values.bom_id);
}

function updateBom(db, bomId, input, role) {
  if (!canModifyBom(role)) throw new ValidationError('Not permitted');                       // FR14
  const { errors, values } = validateBomInput(input, { isNew: false });
  if (Object.keys(errors).length) throw Object.assign(new ValidationError('Invalid BoM'), { errors });
  const res = db.prepare('UPDATE BoM SET bom_name = ?, category = ?, price = ?, current_balance = ?, safety_stock_level = ? WHERE bom_id = ?')
    .run(values.bom_name, values.category, values.price, values.balance, values.safety_stock_level, bomId);
  if (res.changes === 0) throw new ValidationError('BoM not found');
  maybeGeneratePurchaseOrder(db, bomId); // raising safety stock can push a BoM into low stock
  return getBom(db, bomId);
}

function deleteBom(db, bomId, role) {
  if (!canModifyBom(role)) throw new ValidationError('Not permitted');                       // FR15
  return db.prepare('DELETE FROM BoM WHERE bom_id = ?').run(bomId).changes === 1;           // FR6
}

const STOCK_STATUS_SQL = `CASE WHEN current_balance <= safety_stock_level THEN 'Low Stock' ELSE 'Available' END AS stock_status`;

function getBom(db, bomId) {
  return db.prepare(`SELECT *, ${STOCK_STATUS_SQL} FROM BoM WHERE bom_id = ?`).get(bomId) || null;
}

// ---------- INV-LOG-06: search + stock-status filter ----------
function listBoms(db, { search = '', status = 'All' } = {}) {
  const where = [];
  const params = [];
  if (search.trim()) { where.push('(bom_name LIKE ? OR bom_id LIKE ?)'); params.push(`%${search.trim()}%`, `%${search.trim()}%`); } // FR12
  if (status === 'Low Stock') where.push('current_balance <= safety_stock_level');                   // FR16
  if (status === 'Available') where.push('current_balance > safety_stock_level');
  const sql = `SELECT *, ${STOCK_STATUS_SQL} FROM BoM ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY bom_name`;
  return db.prepare(sql).all(...params);
}

// ---------- INV-LOG-04: safety-stock monitor ----------
function listLowStock(db) {                                                                          // FR10b / FR11
  return db.prepare(`SELECT *, ${STOCK_STATUS_SQL}, (safety_stock_level - current_balance) AS shortfall
                     FROM BoM WHERE current_balance <= safety_stock_level ORDER BY shortfall DESC, bom_name`).all();
}

// ---------- INV-LOG-03: stock transaction engine ----------
function recordTransaction(db, { bom_id, txn_type, quantity, vendor }, userId) {
  const qty = Number(quantity);
  if (!['IN', 'OUT'].includes(txn_type)) throw new ValidationError('Choose stock-in or stock-out');
  if (!Number.isInteger(qty) || qty <= 0) throw new ValidationError('Quantity must be a whole number greater than 0');

  const bom = getBom(db, bom_id);
  if (!bom) throw new ValidationError('BoM not found');
  if (txn_type === 'OUT' && qty > bom.current_balance) {                                              // FR10a / NFR7
    throw new ValidationError(`Only ${bom.current_balance} available — cannot issue ${qty}`);
  }
  const delta = txn_type === 'IN' ? qty : -qty;

  db.exec('BEGIN');                                                                                   // NFR8 atomic
  try {
    const openPo = txn_type === 'IN'
      ? db.prepare("SELECT po_id FROM PurchaseOrder WHERE bom_id = ? AND status = 'Generated' ORDER BY po_id LIMIT 1").get(bom_id)
      : null;
    db.prepare('UPDATE BoM SET current_balance = current_balance + ? WHERE bom_id = ?').run(delta, bom_id); // FR8 / FR9
    db.prepare('INSERT INTO StockTransaction (bom_id, txn_type, quantity, vendor, performed_by, purchase_order_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(bom_id, txn_type, qty, String(vendor || '').trim() || null, userId, openPo?.po_id || null);
    const po = maybeGeneratePurchaseOrder(db, bom_id);
    db.exec('COMMIT');
    return { bom: getBom(db, bom_id), purchaseOrder: po };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function listTransactions(db, { limit = 50 } = {}) {
  return db.prepare(`SELECT t.*, b.bom_name, u.username AS performed_by_name
                     FROM StockTransaction t JOIN BoM b ON b.bom_id = t.bom_id JOIN User u ON u.user_id = t.performed_by
                     ORDER BY t.txn_date DESC, t.txn_id DESC LIMIT ?`).all(limit);
}

// ---------- INV-LOG-05: auto purchase-order generator ----------
// Creates one open PO per BoM when it is at or below safety stock (SDD FR-10, D-01).
// Fixed reorder quantity in v1.0 (SDD §8C); never creates a second PO while one is still 'Generated'.
function maybeGeneratePurchaseOrder(db, bomId) {
  const bom = getBom(db, bomId);
  if (!bom || bom.current_balance > bom.safety_stock_level) return null;
  const open = db.prepare(`SELECT po_id FROM PurchaseOrder WHERE bom_id = ? AND status = 'Generated'`).get(bomId);
  if (open) return null;
  const qty = Math.max(FIXED_REORDER_QTY, bom.safety_stock_level - bom.current_balance);
  const res = db.prepare('INSERT INTO PurchaseOrder (bom_id, suggested_reorder_qty) VALUES (?, ?)').run(bomId, qty);
  return db.prepare('SELECT * FROM PurchaseOrder WHERE po_id = ?').get(res.lastInsertRowid);
}

function listPurchaseOrders(db) {
  return db.prepare(`SELECT p.*, b.bom_name, b.current_balance, b.safety_stock_level, u.username AS reviewed_by_name
                     FROM PurchaseOrder p JOIN BoM b ON b.bom_id = p.bom_id LEFT JOIN User u ON u.user_id = p.reviewed_by
                     ORDER BY CASE p.status WHEN 'Generated' THEN 0 ELSE 1 END, p.generated_date DESC`).all();
}

function reviewPurchaseOrder(db, poId, user) {
  if (!canModifyBom(user.role)) throw new ValidationError('Not permitted'); // review → confirm by Inventory Manager (SDD §8C)
  return db.prepare(`UPDATE PurchaseOrder SET status = 'Reviewed', reviewed_by = ? WHERE po_id = ? AND status = 'Generated'`)
    .run(user.user_id, poId).changes === 1;
}

function dashboardSummary(db) {
  return {
    totalBoms: db.prepare('SELECT COUNT(*) AS n FROM BoM').get().n,
    lowStock: db.prepare('SELECT COUNT(*) AS n FROM BoM WHERE current_balance <= safety_stock_level').get().n,
    openPos: db.prepare(`SELECT COUNT(*) AS n FROM PurchaseOrder WHERE status = 'Generated'`).get().n,
    recent: listTransactions(db, { limit: 8 }),
  };
}

module.exports = {
  ValidationError, canModifyBom, authenticate, validateBomInput,
  createBom, updateBom, deleteBom, getBom, listBoms, listLowStock,
  recordTransaction, listTransactions,
  maybeGeneratePurchaseOrder, listPurchaseOrders, reviewPurchaseOrder, dashboardSummary,
};
