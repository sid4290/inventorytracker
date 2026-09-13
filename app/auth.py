"""Authentication & role-based session module (INV-LOG-01).

FR1  log in with valid credentials         FR2  reject invalid credentials
FR14/FR15 role restrictions on edit/delete FR17 log out
NFR6 passwords stored as hashes; role held in the session.
"""
from functools import wraps

from flask import (Blueprint, flash, g, redirect, render_template, request,
                   session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

from .db import get_db

bp = Blueprint("auth", __name__)

ROLES = ["Inventory Staff", "Inventory Manager", "Business Owner", "System Administrator"]
# FR14 / FR15: only these roles may edit or delete a BoM.
MODIFY_ROLES = {"Inventory Manager", "System Administrator"}


def create_user(username, password, role):
    db = get_db()
    db.execute(
        "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
        (username, generate_password_hash(password), role),
    )
    db.commit()


@bp.before_app_request
def load_user():
    uid = session.get("user_id")
    g.user = get_db().execute("SELECT * FROM users WHERE user_id = ?", (uid,)).fetchone() if uid else None
    g.can_modify = bool(g.user) and g.user["role"] in MODIFY_ROLES


def login_required(view):
    @wraps(view)
    def wrapped(*a, **kw):
        if g.user is None:
            return redirect(url_for("auth.login"))
        return view(*a, **kw)
    return wrapped


def modify_required(view):
    """FR14 / FR15 — edit and delete restricted to authorised roles."""
    @wraps(view)
    def wrapped(*a, **kw):
        if g.user is None:
            return redirect(url_for("auth.login"))
        if not g.can_modify:
            flash("Your role can't edit or delete BoMs. Ask an Inventory Manager or System Administrator.", "error")
            return redirect(url_for("bom.list_bom")), 403
        return view(*a, **kw)
    return wrapped


@bp.route("/login", methods=("GET", "POST"))
def login():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        user = get_db().execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if user and check_password_hash(user["password_hash"], password):   # FR1
            session.clear()
            session["user_id"] = user["user_id"]
            session["role"] = user["role"]
            return redirect(url_for("dashboard.index"))
        flash("Username or password is incorrect.", "error")                 # FR2
        return render_template("login.html"), 401
    return render_template("login.html")


@bp.route("/logout", methods=("POST",))
def logout():                                                                # FR17
    session.clear()
    return redirect(url_for("auth.login"))
