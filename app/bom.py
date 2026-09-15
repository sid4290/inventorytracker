"""BoM CRUD + validation + search/filter (INV-LOG-02, INV-LOG-06).

FR3/FR4 add BoM (opening balance captured on first entry)
FR5 edit   FR6 delete   FR7 mandatory-field validation   FR13 unique bom_id
FR12 search by name   FR16 filter by stock status
"""
from flask import (Blueprint, flash, g, redirect, render_template, request,
                   url_for)

from .auth import login_required, modify_required
from .db import get_db, now
from .purchase_orders import ensure_purchase_order

bp = Blueprint("bom", __name__, url_prefix="/bom")

# Predefined categories (SDD §8C assumption). Edit this list to suit the business.
CATEGORIES = ["Raw Material", "Component", "Packaging", "Consumable", "Finished Good"]

DEFAULT_REORDER_MULTIPLIER = 2   # fixed reorder qty = safety stock × 2 unless user overrides


def stock_status(row):
    """INV-LOG-04 — safety-stock monitor."""
    return "Low Stock" if row["current_balance"] <= row["safety_stock_level"] else "Available"


def _validate(form, editing=False):
    """FR7 — every mandatory field must be present and valid. Returns (data, errors)."""
    errors = {}
    data = {}

    if not editing:
        data["bom_id"] = form.get("bom_id", "").strip()
        if not data["bom_id"]:
            errors["bom_id"] = "Enter a BoM ID."

    data["bom_name"] = form.get("bom_name", "").strip()
    if not data["bom_name"]:
        errors["bom_name"] = "Enter a BoM name."

    data["category"] = form.get("category", "").strip()
    if data["category"] not in CATEGORIES:
        errors["category"] = "Choose a category."

    data["unit"] = form.get("unit", "").strip()
    if not data["unit"]:
        errors["unit"] = "Enter a unit, such as pcs, kg, or L."

    for field, label, kind, minimum in (
        ("price", "price", float, 0),
        ("safety_stock_level", "safety stock level", int, 0),
    ):
        raw = form.get(field, "").strip()
        try:
            val = kind(raw)
            if val < minimum:
                raise ValueError
            data[field] = val
        except ValueError:
            errors[field] = f"Enter a valid {label} (0 or more)."

    if not editing:
        raw = form.get("current_balance", "").strip()
        try:
            val = int(raw)
            if val < 0:
                raise ValueError
            data["current_balance"] = val
        except ValueError:
            errors["current_balance"] = "Enter the current balance (0 or more)."

    raw = form.get("reorder_qty", "").strip()
    if raw:
        try:
            val = int(raw)
            if val <= 0:
                raise ValueError
            data["reorder_qty"] = val
        except ValueError:
            errors["reorder_qty"] = "Reorder quantity must be a whole number above 0."
    elif "safety_stock_level" in data:
        data["reorder_qty"] = max(1, data["safety_stock_level"] * DEFAULT_REORDER_MULTIPLIER)

    return data, errors


@bp.route("/")
@login_required
def list_bom():
    q = request.args.get("q", "").strip()               # FR12
    status = request.args.get("status", "All")          # FR16
    sql = "SELECT * FROM bom WHERE is_active = 1"
    params = []
    if q:
        sql += " AND bom_name LIKE ?"
        params.append(f"%{q}%")
    if status == "Low Stock":
        sql += " AND current_balance <= safety_stock_level"
    elif status == "Available":
        sql += " AND current_balance > safety_stock_level"
    sql += " ORDER BY bom_name"
    rows = get_db().execute(sql, params).fetchall()
    return render_template("bom_list.html", boms=rows, q=q, status=status,
                           stock_status=stock_status)


@bp.route("/add", methods=("GET", "POST"))
@login_required
def add():
    if request.method == "POST":
        data, errors = _validate(request.form)
        db = get_db()
        if "bom_id" not in errors and db.execute(
                "SELECT 1 FROM bom WHERE bom_id = ?", (data["bom_id"],)).fetchone():
            errors["bom_id"] = f"BoM ID {data['bom_id']} already exists. Choose a different ID."   # FR13
        if errors:
            return render_template("bom_form.html", mode="add", form=request.form,
                                   errors=errors, categories=CATEGORIES), 400
        db.execute(
            """INSERT INTO bom (bom_id, bom_name, category, unit, price, opening_balance,
                                current_balance, safety_stock_level, reorder_qty,
                                created_by, created_date)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (data["bom_id"], data["bom_name"], data["category"], data["unit"], data["price"],
             data["current_balance"],            # opening balance captured on first entry (FR3)
             data["current_balance"], data["safety_stock_level"], data["reorder_qty"],
             g.user["user_id"], now()),
        )
        ensure_purchase_order(db, data["bom_id"])    # a BoM entered already at/below safety stock
        db.commit()
        flash(f"{data['bom_name']} added.", "success")
        return redirect(url_for("bom.list_bom"))
    return render_template("bom_form.html", mode="add", form={}, errors={}, categories=CATEGORIES)


@bp.route("/<bom_id>/edit", methods=("GET", "POST"))
@modify_required                                     # FR5 + FR14
def edit(bom_id):
    db = get_db()
    row = db.execute("SELECT * FROM bom WHERE bom_id = ? AND is_active = 1", (bom_id,)).fetchone()
    if row is None:
        flash("That BoM doesn't exist.", "error")
        return redirect(url_for("bom.list_bom"))
    if request.method == "POST":
        data, errors = _validate(request.form, editing=True)
        if errors:
            return render_template("bom_form.html", mode="edit", bom=row, form=request.form,
                                   errors=errors, categories=CATEGORIES), 400
        db.execute(
            """UPDATE bom SET bom_name = ?, category = ?, unit = ?, price = ?,
                              safety_stock_level = ?, reorder_qty = ?
               WHERE bom_id = ?""",
            (data["bom_name"], data["category"], data["unit"], data["price"],
             data["safety_stock_level"], data["reorder_qty"], bom_id),
        )
        ensure_purchase_order(db, bom_id)            # safety stock may have been raised
        db.commit()
        flash(f"{data['bom_name']} updated.", "success")
        return redirect(url_for("bom.list_bom"))
    return render_template("bom_form.html", mode="edit", bom=row, form=row, errors={},
                           categories=CATEGORIES)


@bp.route("/<bom_id>/delete", methods=("POST",))
@modify_required                                     # FR6 + FR15
def delete(bom_id):
    db = get_db()
    db.execute("UPDATE bom SET is_active = 0 WHERE bom_id = ?", (bom_id,))
    db.commit()
    flash(f"BoM {bom_id} removed.", "success")
    return redirect(url_for("bom.list_bom"))
