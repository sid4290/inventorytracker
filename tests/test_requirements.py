"""Requirement-traced tests. Each test name carries the tracker ID (INV-FR-nn / INV-NFR-nn)."""
import os
import tempfile

import pytest

from app import create_app
from app.auth import create_user
from app.db import get_db
from app.seed import seed


@pytest.fixture
def app():
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    app = create_app({"TESTING": True, "DATABASE": path, "SECRET_KEY": "test"})
    with app.app_context():
        seed()
    yield app
    os.close(fd)
    os.unlink(path)


@pytest.fixture
def client(app):
    return app.test_client()


def login(client, username="manager", password="manager123"):
    return client.post("/login", data={"username": username, "password": password}, follow_redirects=True)


def bom_form(**over):
    data = {"bom_id": "BOM-900", "bom_name": "Test widget", "category": "Component",
            "price": "5.00", "unit": "pcs", "current_balance": "100", "safety_stock_level": "10", "reorder_qty": ""}
    data.update(over)
    return data


def balance(app, bom_id):
    with app.app_context():
        return get_db().execute("SELECT current_balance FROM bom WHERE bom_id = ?", (bom_id,)).fetchone()[0]


# ---- Auth -------------------------------------------------------------------
def test_INV_FR_01_valid_login_reaches_dashboard(client):
    r = login(client)
    assert r.status_code == 200 and b"Dashboard" in r.data


def test_INV_FR_02_invalid_login_stays_on_login_with_error(client):
    r = client.post("/login", data={"username": "manager", "password": "wrong"})
    assert r.status_code == 401 and b"incorrect" in r.data


def test_INV_FR_17_logout_ends_session(client):
    login(client)
    client.post("/logout")
    r = client.get("/dashboard")
    assert r.status_code == 302 and "/login" in r.headers["Location"]


def test_INV_NFR_06_passwords_are_hashed(app):
    with app.app_context():
        row = get_db().execute("SELECT password_hash FROM users WHERE username='staff'").fetchone()
    assert "staff123" not in row["password_hash"]


# ---- BoM master ------------------------------------------------------------
def test_INV_FR_03_add_bom_captures_opening_balance(client, app):
    login(client, "staff", "staff123")
    r = client.post("/bom/add", data=bom_form(), follow_redirects=True)
    assert b"Test widget" in r.data
    with app.app_context():
        row = get_db().execute("SELECT * FROM bom WHERE bom_id='BOM-900'").fetchone()
    assert row["opening_balance"] == 100 and row["current_balance"] == 100
    assert row["unit"] == "pcs"
    assert row["reorder_qty"] == 20   # default = safety stock × 2


def test_INV_FR_07_missing_mandatory_field_blocks_save(client, app):
    login(client)
    r = client.post("/bom/add", data=bom_form(bom_name=""))
    assert r.status_code == 400 and b"Enter a BoM name" in r.data
    with app.app_context():
        assert get_db().execute("SELECT 1 FROM bom WHERE bom_id='BOM-900'").fetchone() is None


def test_INV_FR_13_duplicate_bom_id_rejected(client):
    login(client)
    client.post("/bom/add", data=bom_form())
    r = client.post("/bom/add", data=bom_form(bom_name="Another"))
    assert r.status_code == 400 and b"already exists" in r.data


def test_INV_FR_05_manager_can_edit(client, app):
    login(client)
    r = client.post("/bom/BOM-001/edit", data=bom_form(bom_name="Renamed bracket", price="13.00"),
                    follow_redirects=True)
    assert b"Renamed bracket" in r.data


def test_INV_FR_14_staff_cannot_edit(client, app):
    login(client, "staff", "staff123")
    r = client.post("/bom/BOM-001/edit", data=bom_form(bom_name="Hacked"))
    assert r.status_code == 403
    with app.app_context():
        assert get_db().execute("SELECT bom_name FROM bom WHERE bom_id='BOM-001'").fetchone()[0] != "Hacked"


def test_INV_FR_06_delete_removes_from_active_list(client):
    login(client, "admin", "admin123")
    client.post("/bom/BOM-001/delete")
    r = client.get("/bom/")
    assert b"<td>BOM-001</td>" not in r.data


def test_INV_FR_15_staff_cannot_delete(client):
    login(client, "staff", "staff123")
    assert client.post("/bom/BOM-001/delete").status_code == 403
    assert b"BOM-001" in client.get("/bom/").data


def test_INV_FR_12_search_by_name(client):
    login(client)
    r = client.get("/bom/?q=bolt")
    assert b"BOM-002" in r.data and b"BOM-001" not in r.data


def test_INV_FR_XX_bom_list_shows_carrying_cost(client, app):
    login(client)
    with app.app_context():
        get_db().execute("UPDATE bom SET opening_balance = 150, current_balance = 120, price = 5.00 WHERE bom_id = 'BOM-001'")
        get_db().commit()
    r = client.get("/bom/")
    assert b"Carrying cost" in r.data
    assert b"150.00" in r.data


def test_INV_FR_16_filter_by_stock_status(client):
    login(client)
    r = client.get("/bom/?status=Low+Stock")
    assert b"BOM-002" in r.data and b"BOM-005" in r.data and b"BOM-003" not in r.data


# ---- Stock transactions ----------------------------------------------------
def test_INV_FR_08_stock_in_increases_balance(client, app):
    login(client, "staff", "staff123")
    client.post("/transactions/", data={"bom_id": "BOM-001", "txn_type": "IN", "quantity": "30"})
    assert balance(app, "BOM-001") == 150


def test_INV_FR_09_stock_out_decreases_balance(client, app):
    login(client, "staff", "staff123")
    client.post("/transactions/", data={"bom_id": "BOM-001", "txn_type": "OUT", "quantity": "20"})
    assert balance(app, "BOM-001") == 100


def test_INV_FR_10a_stock_out_over_balance_rejected(client, app):
    login(client, "staff", "staff123")
    r = client.post("/transactions/", data={"bom_id": "BOM-001", "txn_type": "OUT", "quantity": "121"})
    assert r.status_code == 400 and balance(app, "BOM-001") == 120     # NFR-07 boundary: balance+1


def test_INV_NFR_07_stock_out_equal_to_balance_allowed(client, app):
    login(client, "staff", "staff123")
    client.post("/transactions/", data={"bom_id": "BOM-001", "txn_type": "OUT", "quantity": "120"})
    assert balance(app, "BOM-001") == 0


# ---- Safety stock & auto-PO ------------------------------------------------
def test_INV_FR_10b_low_stock_screen_lists_at_or_below_safety(client):
    login(client)
    r = client.get("/low-stock")
    assert b"BOM-002" in r.data and b"BOM-005" in r.data and b"BOM-001" not in r.data


def test_INV_FR_11_dashboard_shows_low_stock_count(client):
    login(client)
    assert b"at or below safety stock" in client.get("/dashboard").data


def test_INV_FR_18_auto_po_generated_when_balance_reaches_safety_stock(client, app):
    login(client, "staff", "staff123")
    with app.app_context():
        assert get_db().execute("SELECT 1 FROM purchase_order WHERE bom_id='BOM-001'").fetchone() is None
    r = client.post("/transactions/", data={"bom_id": "BOM-001", "txn_type": "OUT", "quantity": "90"},
                    follow_redirects=True)
    assert b"purchase order" in r.data
    with app.app_context():
        po = get_db().execute("SELECT * FROM purchase_order WHERE bom_id='BOM-001'").fetchone()
    assert po["status"] == "Generated" and po["suggested_reorder_qty"] == 60


def test_INV_FR_18_no_duplicate_po_while_one_is_pending(client, app):
    login(client, "staff", "staff123")
    client.post("/transactions/", data={"bom_id": "BOM-002", "txn_type": "OUT", "quantity": "5"})
    with app.app_context():
        n = get_db().execute("SELECT COUNT(*) FROM purchase_order WHERE bom_id='BOM-002'").fetchone()[0]
    assert n == 1


def test_INV_FR_18_manager_reviews_po(client, app):
    login(client)
    with app.app_context():
        po_id = get_db().execute("SELECT po_id FROM purchase_order WHERE bom_id='BOM-002'").fetchone()[0]
    r = client.post(f"/purchase-orders/{po_id}/review", follow_redirects=True)
    assert b"marked as reviewed" in r.data


# ---- NFR-10 volume ---------------------------------------------------------
def test_INV_NFR_10_1000_boms_10000_transactions(client, app):
    """Load smoke test: CRUD stays correct and list renders at target volume."""
    import time
    from app.transactions import record_transaction
    login(client, "staff", "staff123")
    with app.app_context():
        db = get_db()
        uid = db.execute("SELECT user_id FROM users WHERE username='staff'").fetchone()[0]
        db.executemany(
            "INSERT INTO bom (bom_id,bom_name,category,unit,price,opening_balance,current_balance,"
            "safety_stock_level,reorder_qty,created_by,created_date) VALUES (?,?,?,?,?,?,?,?,?,?,'2026-09-03')",
            [(f"L-{i:04d}", f"Load item {i}", "Component", "pcs", 1.0, 1000, 1000, 10, 20, uid) for i in range(1000)])
        db.commit()
        for i in range(10000):
            record_transaction(db, f"L-{i % 1000:04d}", "OUT" if (i // 1000) % 2 else "IN", 1, uid)
        assert db.execute("SELECT current_balance FROM bom WHERE bom_id='L-0000'").fetchone()[0] == 1000
    t = time.time()
    r = client.get("/bom/")
    assert r.status_code == 200 and time.time() - t < 5     # NFR-01
