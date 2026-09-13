// Tests trace to tracker IDs INV-FR-nn. Run with `npm test`.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const s = require('../src/services');

let db, staff, manager;
const bom = (over = {}) => ({ bom_id: 'B-100', bom_name: 'Steel bracket', category: 'Component', price: 12.5, balance: 50, safety_stock_level: 20, ...over });

beforeEach(() => {
  db = openDatabase(':memory:');
  staff = s.authenticate(db, 'staff', 'staff123');
  manager = s.authenticate(db, 'manager', 'manager123');
});

test('INV-FR-01/02 login accepts valid and rejects invalid credentials', () => {
  assert.equal(staff.role, 'Inventory Staff');
  assert.equal(s.authenticate(db, 'staff', 'wrong'), null);
  assert.equal(s.authenticate(db, 'nobody', 'x'), null);
});

test('INV-FR-03 add BoM captures opening balance and appears in list', () => {
  const created = s.createBom(db, bom(), staff.user_id);
  assert.equal(created.opening_balance, 50);
  assert.equal(created.current_balance, 50);
  assert.equal(s.listBoms(db).length, 1);
});

test('INV-FR-07 mandatory-field validation blocks save', () => {
  assert.throws(() => s.createBom(db, bom({ bom_name: '' }), staff.user_id), (e) => !!e.errors.bom_name);
  assert.throws(() => s.createBom(db, bom({ price: '' }), staff.user_id), (e) => !!e.errors.price);
  assert.throws(() => s.createBom(db, bom({ category: 'Nope' }), staff.user_id), (e) => !!e.errors.category);
  assert.equal(s.listBoms(db).length, 0);
});

test('INV-FR-13 duplicate BoM ID rejected', () => {
  s.createBom(db, bom(), staff.user_id);
  assert.throws(() => s.createBom(db, bom(), staff.user_id), (e) => /already exists/.test(e.errors.bom_id));
});

test('INV-FR-05/14 edit is role-gated and updates balance for authorized users', () => {
  s.createBom(db, bom(), staff.user_id);
  assert.throws(() => s.updateBom(db, 'B-100', bom({ bom_name: 'X' }), staff.role), /Not permitted/);
  const updated = s.updateBom(db, 'B-100', bom({ bom_name: 'Steel bracket v2', balance: 999 }), manager.role);
  assert.equal(updated.bom_name, 'Steel bracket v2');
  assert.equal(updated.current_balance, 999);
});

test('INV-FR-06/15 delete is role-gated', () => {
  s.createBom(db, bom(), staff.user_id);
  assert.throws(() => s.deleteBom(db, 'B-100', staff.role), /Not permitted/);
  assert.equal(s.deleteBom(db, 'B-100', manager.role), true);
  assert.equal(s.getBom(db, 'B-100'), null);
});

test('INV-FR-08/09 stock-in and stock-out update balance', () => {
  s.createBom(db, bom(), staff.user_id);
  s.recordTransaction(db, { bom_id: 'B-100', txn_type: 'IN', quantity: 25 }, staff.user_id);
  assert.equal(s.getBom(db, 'B-100').current_balance, 75);
  s.recordTransaction(db, { bom_id: 'B-100', txn_type: 'OUT', quantity: 30 }, staff.user_id);
  assert.equal(s.getBom(db, 'B-100').current_balance, 45);
  assert.equal(s.listTransactions(db).length, 2);
});

test('INV-FR-10a / NFR7 boundary: qty = balance allowed, qty = balance + 1 rejected', () => {
  s.createBom(db, bom(), staff.user_id);
  assert.throws(() => s.recordTransaction(db, { bom_id: 'B-100', txn_type: 'OUT', quantity: 51 }, staff.user_id), /Only 50 available/);
  assert.equal(s.getBom(db, 'B-100').current_balance, 50);
  s.recordTransaction(db, { bom_id: 'B-100', txn_type: 'OUT', quantity: 50 }, staff.user_id);
  assert.equal(s.getBom(db, 'B-100').current_balance, 0);
});

test('INV-FR-10b/11/16 low-stock detection and status filter', () => {
  s.createBom(db, bom(), staff.user_id);
  s.createBom(db, bom({ bom_id: 'B-200', bom_name: 'Gasket', balance: 20 }), staff.user_id); // equal to safety = low
  assert.deepEqual(s.listLowStock(db).map((b) => b.bom_id), ['B-200']);
  assert.equal(s.listBoms(db, { status: 'Low Stock' }).length, 1);
  assert.equal(s.listBoms(db, { status: 'Available' }).length, 1);
  assert.equal(s.getBom(db, 'B-200').stock_status, 'Low Stock');
});

test('INV-FR-12 search by name', () => {
  s.createBom(db, bom(), staff.user_id);
  s.createBom(db, bom({ bom_id: 'B-200', bom_name: 'Gasket' }), staff.user_id);
  assert.deepEqual(s.listBoms(db, { search: 'gask' }).map((b) => b.bom_id), ['B-200']);
});

test('INV-FR-18 auto-PO generated once when balance reaches safety stock', () => {
  s.createBom(db, bom(), staff.user_id);
  assert.equal(s.listPurchaseOrders(db).length, 0);
  const { purchaseOrder } = s.recordTransaction(db, { bom_id: 'B-100', txn_type: 'OUT', quantity: 30 }, staff.user_id);
  assert.equal(purchaseOrder.status, 'Generated');
  assert.equal(purchaseOrder.suggested_reorder_qty, 100);
  s.recordTransaction(db, { bom_id: 'B-100', txn_type: 'OUT', quantity: 5 }, staff.user_id);
  assert.equal(s.listPurchaseOrders(db).length, 1, 'no duplicate PO while one is open');
  assert.throws(() => s.reviewPurchaseOrder(db, purchaseOrder.po_id, staff), /Not permitted/);
  assert.equal(s.reviewPurchaseOrder(db, purchaseOrder.po_id, manager), true);
  assert.equal(s.listPurchaseOrders(db)[0].status, 'Reviewed');
});

test('NFR-10 load: 1,000 BoMs and 10,000 transactions stay correct and fast', () => {
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) s.createBom(db, bom({ bom_id: `L-${i}`, bom_name: `Part ${i}`, balance: 5000, safety_stock_level: 10 }), staff.user_id);
  for (let i = 0; i < 10000; i++) s.recordTransaction(db, { bom_id: `L-${i % 1000}`, txn_type: i % 2 ? 'OUT' : 'IN', quantity: 3 }, staff.user_id);
  assert.equal(s.listBoms(db).length, 1000);
  assert.equal(s.getBom(db, 'L-0').current_balance, 5030); // 10 IN of 3 each
  assert.equal(s.getBom(db, 'L-1').current_balance, 4970); // 10 OUT of 3 each
  const listStart = Date.now();
  s.listBoms(db, { search: 'Part 9' });
  assert.ok(Date.now() - listStart < 2000, 'NFR-02 search ≤ 2 s');
  assert.ok(Date.now() - t0 < 60000);
});
