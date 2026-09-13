// Loads sample BoMs and a few movements so the demo follows the BRD §8 happy path. Safe to re-run.
const { openDatabase } = require('../src/db');
const s = require('../src/services');
const db = openDatabase();
const staff = s.authenticate(db, 'staff', 'staff123');
const demo = [
  ['B-1001', 'Steel bracket 40mm', 'Component', 12.5, 180, 50],
  ['B-1002', 'M6 hex bolt (box 100)', 'Component', 4.2, 25, 30],
  ['B-1003', 'Aluminium sheet 2mm', 'Raw Material', 210, 12, 10],
  ['B-1004', 'Corrugated carton L', 'Packaging', 1.8, 400, 100],
  ['B-1005', 'Motor sub-assembly', 'Sub-assembly', 890, 6, 5],
  ['B-1006', 'Cutting fluid 5L', 'Consumable', 32, 9, 8],
];
let added = 0;
for (const [bom_id, bom_name, category, price, balance, safety_stock_level] of demo) {
  if (s.getBom(db, bom_id)) continue;
  s.createBom(db, { bom_id, bom_name, category, price, balance, safety_stock_level }, staff.user_id); added++;
}
if (added) {
  s.recordTransaction(db, { bom_id: 'B-1001', txn_type: 'OUT', quantity: 40 }, staff.user_id);
  s.recordTransaction(db, { bom_id: 'B-1004', txn_type: 'IN', quantity: 50 }, staff.user_id);
}
console.log(`Seeded ${added} BoMs. Low stock: ${s.listLowStock(db).length}, open POs: ${s.listPurchaseOrders(db).length}`);
