"""Stock transaction engine (INV-LOG-03).

FR8 stock-in increases balance       FR9 stock-out decreases balance
FR10a stock-out exceeding balance is rejected and balance is unchanged
NFR5/NFR7/NFR8: balance recalculated only through transactions, never negative,
written atomically with the transaction row (rollback on failure).
"""
import sqlite3

from flask import Blueprint, flash, g, redirect, render_template, request, url_for

from .auth import login_required
from .db import get_db, now
from .purchase_orders import ensure_purchase_order

bp = Blueprint("txn", __name__, url_prefix="/transactions")


class TransactionError(ValueError):
    pass


def record_transaction(db, bom_id, txn_type, quantity, user_id):
    """Apply a stock movement. Raises TransactionError; commits on success."""
    if txn_type not in ("IN", "OUT"):
        raise TransactionError("Choose Stock In or Stock Out.")
    if quantity <= 0:
        raise TransactionError("Quantity must be a whole number above 0.")
    bom = db.execute("SELECT * FROM bom WHERE bom_id = ? AND is_active = 1", (bom_id,)).fetchone()
    if bom is None:
        raise TransactionError("Choose a BoM.")
    if txn_type == "OUT" and quantity > bom["current_balance"]:               # FR10a
        raise TransactionError(
            f"Only {bom['current_balance']} of {bom['bom_name']} in stock; can't issue {quantity}.")

    delta = quantity if txn_type == "IN" else -quantity
    try:
        db.execute("BEGIN")
        db.execute("INSERT INTO stock_transaction (bom_id, txn_type, quantity, txn_date, performed_by) "
                   "VALUES (?, ?, ?, ?, ?)", (bom_id, txn_type, quantity, now(), user_id))
        db.execute("UPDATE bom SET current_balance = current_balance + ? WHERE bom_id = ?",
                   (delta, bom_id))                                            # NFR7 CHECK guards here
        po_id = ensure_purchase_order(db, bom_id)                              # auto-PO
        db.commit()                                                            # NFR8 atomic
    except sqlite3.Error as exc:
        db.rollback()
        raise TransactionError("Transaction failed and was rolled back.") from exc
    new_balance = bom["current_balance"] + delta
    return new_balance, po_id


@bp.route("/", methods=("GET", "POST"))
@login_required
def new():
    db = get_db()
    boms = db.execute("SELECT bom_id, bom_name, current_balance FROM bom WHERE is_active = 1 "
                      "ORDER BY bom_name").fetchall()
    if request.method == "POST":
        bom_id = request.form.get("bom_id", "")
        txn_type = request.form.get("txn_type", "")
        try:
            quantity = int(request.form.get("quantity", "").strip())
        except ValueError:
            quantity = 0
        try:
            new_balance, po_id = record_transaction(db, bom_id, txn_type, quantity, g.user["user_id"])
        except TransactionError as exc:
            flash(str(exc), "error")
            return render_template("transaction.html", boms=boms, form=request.form), 400
        msg = f"{'Stock in' if txn_type == 'IN' else 'Stock out'} recorded. New balance: {new_balance}."
        if po_id:
            msg += f" Balance is at or below safety stock — purchase order PO-{po_id} generated."
        flash(msg, "success")
        return redirect(url_for("bom.list_bom"))
    return render_template("transaction.html", boms=boms, form={"bom_id": request.args.get("bom_id", "")})
