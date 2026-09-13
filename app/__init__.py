"""Inventory Tracker — Flask application factory.

Screens (SDD §4): Login, Dashboard, BoM List, Add BoM, Edit BoM,
Stock Transaction, Low-Stock Status, Purchase Orders.
"""
import os

from flask import Blueprint, Flask, redirect, render_template, url_for

from . import auth, bom, db, purchase_orders, transactions
from .auth import login_required
from .db import get_db

dashboard = Blueprint("dashboard", __name__)


@dashboard.route("/")
def root():
    return redirect(url_for("dashboard.index"))


@dashboard.route("/dashboard")
@login_required
def index():
    d = get_db()
    total = d.execute("SELECT COUNT(*) FROM bom WHERE is_active = 1").fetchone()[0]
    low = d.execute("SELECT COUNT(*) FROM bom WHERE is_active = 1 "
                    "AND current_balance <= safety_stock_level").fetchone()[0]       # FR11
    pending_po = d.execute("SELECT COUNT(*) FROM purchase_order WHERE status = 'Generated'").fetchone()[0]
    recent = d.execute(
        """SELECT t.txn_type, t.quantity, t.txn_date, b.bom_name, u.username
           FROM stock_transaction t JOIN bom b ON b.bom_id = t.bom_id
           LEFT JOIN users u ON u.user_id = t.performed_by
           ORDER BY t.txn_id DESC LIMIT 8""").fetchall()
    return render_template("dashboard.html", total=total, low=low, pending_po=pending_po, recent=recent)


@dashboard.route("/low-stock")
@login_required
def low_stock():                                                                     # FR10b, FR11
    rows = get_db().execute(
        """SELECT b.*, (SELECT COUNT(*) FROM purchase_order p
                        WHERE p.bom_id = b.bom_id AND p.status = 'Generated') AS pending_po
           FROM bom b WHERE is_active = 1 AND current_balance <= safety_stock_level
           ORDER BY (safety_stock_level - current_balance) DESC, bom_name""").fetchall()
    return render_template("low_stock.html", boms=rows)


def create_app(test_config=None):
    app = Flask(__name__, instance_relative_config=True)
    app.config.from_mapping(
        SECRET_KEY=os.environ.get("SECRET_KEY", "dev-change-me"),
        DATABASE=os.path.join(app.instance_path, "inventory.sqlite"),
    )
    if test_config:
        app.config.update(test_config)
    os.makedirs(app.instance_path, exist_ok=True)

    db.init_app(app)
    app.register_blueprint(auth.bp)
    app.register_blueprint(bom.bp)
    app.register_blueprint(transactions.bp)
    app.register_blueprint(purchase_orders.bp)
    app.register_blueprint(dashboard)

    @app.cli.command("seed")
    def seed_command():
        """Create the four role users and sample BoMs."""
        from .seed import seed
        seed()
        print("Seeded users and sample BoMs.")

    return app
