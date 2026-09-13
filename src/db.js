// Data layer — SDD §5 entities: User, BoM, StockTransaction, PurchaseOrder.
// Uses Node's built-in SQLite (node:sqlite, Node ≥ 22.5) so there is no native build step.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const ROLES = ['Inventory Staff', 'Inventory Manager', 'Business Owner', 'System Administrator'];
// SDD §8C: predefined categories for v1.0
const CATEGORIES = ['Raw Material', 'Component', 'Sub-assembly', 'Packaging', 'Consumable'];
// SDD §8C: fixed reorder quantity for v1.0 (decision gate M5 — change here if the team picks another rule)
const FIXED_REORDER_QTY = 100;

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS User (
    user_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN (${ROLES.map((r) => `'${r}'`).join(',')}))
  );

  CREATE TABLE IF NOT EXISTS BoM (
    bom_id             TEXT PRIMARY KEY,                         -- FR13: unique
    bom_name           TEXT NOT NULL,
    category           TEXT NOT NULL,
    price              REAL NOT NULL CHECK (price >= 0),
    opening_balance    INTEGER NOT NULL CHECK (opening_balance >= 0),
    current_balance    INTEGER NOT NULL CHECK (current_balance >= 0), -- NFR7: never negative
    safety_stock_level INTEGER NOT NULL CHECK (safety_stock_level >= 0),
    created_by         INTEGER NOT NULL REFERENCES User(user_id),
    created_date       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS StockTransaction (
    txn_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    bom_id       TEXT NOT NULL REFERENCES BoM(bom_id) ON DELETE CASCADE,
    txn_type     TEXT NOT NULL CHECK (txn_type IN ('IN','OUT')),
    quantity     INTEGER NOT NULL CHECK (quantity > 0),
    txn_date     TEXT NOT NULL DEFAULT (datetime('now')),
    performed_by INTEGER NOT NULL REFERENCES User(user_id),
    purchase_order_id INTEGER REFERENCES PurchaseOrder(po_id)
  );

  CREATE TABLE IF NOT EXISTS PurchaseOrder (
    po_id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    bom_id                TEXT NOT NULL REFERENCES BoM(bom_id) ON DELETE CASCADE,
    suggested_reorder_qty INTEGER NOT NULL CHECK (suggested_reorder_qty > 0),
    status                TEXT NOT NULL DEFAULT 'Generated' CHECK (status IN ('Generated','Reviewed')),
    generated_date        TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_by           INTEGER REFERENCES User(user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_bom_name ON BoM(bom_name);
  CREATE INDEX IF NOT EXISTS idx_txn_bom ON StockTransaction(bom_id, txn_date);
  CREATE INDEX IF NOT EXISTS idx_po_bom_status ON PurchaseOrder(bom_id, status);
`;

// One demo account per role (SDD §3). Change passwords before any real use.
const SEED_USERS = [
  { username: 'staff',   password: 'staff123',   role: 'Inventory Staff' },
  { username: 'manager', password: 'manager123', role: 'Inventory Manager' },
  { username: 'owner',   password: 'owner123',   role: 'Business Owner' },
  { username: 'admin',   password: 'admin123',   role: 'System Administrator' },
];

function openDatabase(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'inventory.db')) {
  if (file !== ':memory:') require('node:fs').mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  try { db.exec('ALTER TABLE StockTransaction ADD COLUMN purchase_order_id INTEGER REFERENCES PurchaseOrder(po_id)'); } catch {}
  seedUsers(db);
  return db;
}

function seedUsers(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM User').get().n;
  if (count > 0) return;
  const insert = db.prepare('INSERT INTO User (username, password_hash, role) VALUES (?, ?, ?)');
  for (const u of SEED_USERS) insert.run(u.username, bcrypt.hashSync(u.password, 10), u.role);
}

module.exports = { openDatabase, ROLES, CATEGORIES, FIXED_REORDER_QTY, SEED_USERS };
