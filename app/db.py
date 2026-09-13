"""Data layer — SQLite (SDD storage option A).

Entities (SDD §5): User, BoM, StockTransaction, PurchaseOrder.
Negative balances are blocked at the data layer via a CHECK constraint (NFR-07).
"""
import sqlite3
from datetime import datetime

from flask import current_app, g

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    user_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT    NOT NULL UNIQUE,
    password_hash  TEXT    NOT NULL,
    role           TEXT    NOT NULL CHECK (role IN (
                       'Inventory Staff', 'Inventory Manager',
                       'Business Owner', 'System Administrator'))
);

CREATE TABLE IF NOT EXISTS bom (
    bom_id             TEXT    PRIMARY KEY,            -- FR13: unique
    bom_name           TEXT    NOT NULL,
    category           TEXT    NOT NULL,
    price              REAL    NOT NULL CHECK (price >= 0),
    opening_balance    INTEGER NOT NULL CHECK (opening_balance >= 0),
    current_balance    INTEGER NOT NULL CHECK (current_balance >= 0),  -- NFR-07
    safety_stock_level INTEGER NOT NULL CHECK (safety_stock_level >= 0),
    reorder_qty        INTEGER NOT NULL CHECK (reorder_qty > 0),       -- fixed qty (SDD §8C)
    is_active          INTEGER NOT NULL DEFAULT 1,     -- FR6: delete = remove from active list
    created_by         INTEGER REFERENCES users(user_id),
    created_date       TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_transaction (
    txn_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    bom_id       TEXT    NOT NULL REFERENCES bom(bom_id),
    txn_type     TEXT    NOT NULL CHECK (txn_type IN ('IN', 'OUT')),
    quantity     INTEGER NOT NULL CHECK (quantity > 0),
    txn_date     TEXT    NOT NULL,
    performed_by INTEGER REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS purchase_order (
    po_id                INTEGER PRIMARY KEY AUTOINCREMENT,
    bom_id               TEXT    NOT NULL REFERENCES bom(bom_id),
    suggested_reorder_qty INTEGER NOT NULL,
    status               TEXT    NOT NULL DEFAULT 'Generated'
                             CHECK (status IN ('Generated', 'Reviewed')),
    generated_date       TEXT    NOT NULL,
    reviewed_by          INTEGER REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_bom_name ON bom(bom_name);
CREATE INDEX IF NOT EXISTS idx_txn_bom  ON stock_transaction(bom_id);
CREATE INDEX IF NOT EXISTS idx_po_bom   ON purchase_order(bom_id, status);
"""


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(current_app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(_exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = get_db()
    db.executescript(SCHEMA)
    db.commit()


def init_app(app):
    app.teardown_appcontext(close_db)
    with app.app_context():
        init_db()
