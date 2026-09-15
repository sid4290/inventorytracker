"""Seed data — one account per role (SDD §3) and a few sample BoMs for the demo."""
from flask import current_app

from .auth import create_user
from .db import get_db, now
from .purchase_orders import ensure_purchase_order

USERS = [
    ("staff",   "staff123",   "Inventory Staff"),
    ("manager", "manager123", "Inventory Manager"),
    ("owner",   "owner123",   "Business Owner"),
    ("admin",   "admin123",   "System Administrator"),
]

# bom_id, name, category, unit, price, opening balance, safety stock, reorder qty
BOMS = [
    ("BOM-001", "Steel bracket 40mm",   "Component",     "pcs", 12.50, 120, 30, 60),
    ("BOM-002", "M6 hex bolt (100 pk)", "Component",      "box",  4.20,  25, 40, 80),   # already low
    ("BOM-003", "Corrugated box L",     "Packaging",      "box",  0.90, 500, 100, 200),
    ("BOM-004", "Aluminium sheet 2mm",  "Raw Material",  "sheet", 38.00,  15, 10, 20),
    ("BOM-005", "Machine oil 5L",       "Consumable",    "L", 22.00,   8,  8, 16),   # exactly at safety stock
]


def seed():
    db = get_db()
    for username, password, role in USERS:
        if not db.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            create_user(username, password, role)
    admin = db.execute("SELECT user_id FROM users WHERE username = 'admin'").fetchone()[0]
    for bom_id, name, cat, unit, price, bal, safety, reorder in BOMS:
        if db.execute("SELECT 1 FROM bom WHERE bom_id = ?", (bom_id,)).fetchone():
            continue
        db.execute(
            """INSERT INTO bom (bom_id, bom_name, category, unit, price, opening_balance, current_balance,
                                safety_stock_level, reorder_qty, created_by, created_date)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (bom_id, name, cat, unit, price, bal, bal, safety, reorder, admin, now()))
        ensure_purchase_order(db, bom_id)
    db.commit()
