"""Auto purchase-order generator (INV-LOG-05, SDD FR-10).

Rule (v1.0): when a BoM's current_balance <= safety_stock_level and no PO in
status 'Generated' already exists for it, create one with the BoM's fixed
reorder quantity. Inventory Manager / System Administrator review → confirm.
"""
from flask import Blueprint, flash, g, redirect, render_template, request, url_for

from .auth import login_required, modify_required
from .db import get_db, now

bp = Blueprint("po", __name__, url_prefix="/purchase-orders")


def ensure_purchase_order(db, bom_id):
    """Create a PO for bom_id if it is at/below safety stock and none is pending.
    Caller commits. Returns the new po_id or None."""
    row = db.execute(
        "SELECT current_balance, safety_stock_level, reorder_qty FROM bom "
        "WHERE bom_id = ? AND is_active = 1", (bom_id,)).fetchone()
    if row is None or row["current_balance"] > row["safety_stock_level"]:
        return None
    pending = db.execute(
        "SELECT 1 FROM purchase_order WHERE bom_id = ? AND status = 'Generated'",
        (bom_id,)).fetchone()
    if pending:
        return None
    cur = db.execute(
        "INSERT INTO purchase_order (bom_id, suggested_reorder_qty, generated_date) VALUES (?, ?, ?)",
        (bom_id, row["reorder_qty"], now()))
    return cur.lastrowid


@bp.route("/")
@login_required
def list_po():
    status = request.args.get("status", "All")
    sql = """SELECT po.*, b.bom_name, b.current_balance, b.safety_stock_level, u.username AS reviewer
             FROM purchase_order po
             JOIN bom b ON b.bom_id = po.bom_id
             LEFT JOIN users u ON u.user_id = po.reviewed_by"""
    params = []
    if status in ("Generated", "Reviewed"):
        sql += " WHERE po.status = ?"
        params.append(status)
    sql += " ORDER BY po.status = 'Reviewed', po.generated_date DESC"
    rows = get_db().execute(sql, params).fetchall()
    return render_template("purchase_orders.html", pos=rows, status=status)


@bp.route("/<int:po_id>/review", methods=("POST",))
@modify_required
def review(po_id):
    db = get_db()
    db.execute("UPDATE purchase_order SET status = 'Reviewed', reviewed_by = ? "
               "WHERE po_id = ? AND status = 'Generated'", (g.user["user_id"], po_id))
    db.commit()
    flash(f"PO-{po_id} marked as reviewed.", "success")
    return redirect(url_for("po.list_po"))
