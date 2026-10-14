import { test } from "node:test";
import assert from "node:assert/strict";
import { auditActionLabel, auditChanges, auditDetails, auditSummary } from "./audit.ts";
import { weekStart } from "./fefo.ts";

test("summarises a sale with its discount and prescription", () => {
  const p = JSON.stringify({ invoiceNo: "MB-2026-000004", total: 59000, lines: 2, discount: 1500, rxNo: "RX-1" });
  assert.equal(auditSummary("sale.create", p), "فاتورة MB-2026-000004 بقيمة 59,000 د.ع · 2 صنف · خصم 1,500 د.ع · وصفة RX-1");
  const plain = JSON.stringify({ invoiceNo: "MB-2026-000005", total: 3500, lines: 1, discount: 0, rxNo: null });
  assert.equal(auditSummary("sale.create", plain), "فاتورة MB-2026-000005 بقيمة 3,500 د.ع · 1 صنف");
});

test("summarises role, status, stock and settings changes", () => {
  const role = JSON.stringify({ from: { role: "cashier", overrides: {} }, to: { role: "pharmacist", overrides: { viewReports: true } } });
  assert.equal(auditSummary("user.role", role), "الدور من كاشير إلى صيدلاني · تعديل الصلاحيات الخاصة");
  assert.equal(auditSummary("user.status", '{"active":false}'), "تعطيل الحساب");
  assert.equal(auditSummary("batch.adjust", '{"from":10,"to":6,"reason":"تالف"}'), "الكمية من 10 إلى 6 · السبب: تالف");
  const receipt = JSON.stringify({ from: { name: "أ", paper: "80" }, to: { name: "أ", paper: "a4" } });
  assert.equal(auditSummary("settings.receipt", receipt), "تغيير الورق");
});

test("unknown actions and empty payloads stay readable", () => {
  assert.equal(auditSummary("user.login", "{}"), "");
  assert.equal(auditSummary("thing.new", '{"x":1}'), '{"x":1}');
  assert.equal(auditSummary("thing.new", "not json"), "not json");
  assert.equal(auditActionLabel("user.login"), "تسجيل دخول");
  assert.equal(auditActionLabel("thing.new"), "thing.new");
});

test("product edits list each changed field, old against new", () => {
  const p = JSON.stringify({ from: { packSize: 30, requiresRx: false, barcode: null }, to: { packSize: 20, requiresRx: true, barcode: "6281000000999" } });
  assert.deepEqual(
    auditChanges("product.update", p).map((c) => [c.label, c.before, c.after]),
    [["حجم العبوة", "30", "20"], ["بوصفة طبية", "لا", "نعم"], ["الباركود", "—", "6281000000999"]],
  );
  assert.equal(auditSummary("product.update", p), "تعديل حجم العبوة، بوصفة طبية، الباركود");
});

test("price, stock and cost changes read in dinars and units", () => {
  const price = JSON.stringify({ from: 3500, to: 3750, source: "manual" });
  assert.deepEqual(auditChanges("product.price", price).map((c) => [c.label, c.before, c.after]), [["سعر البيع", "3,500 د.ع", "3,750 د.ع"]]);
  assert.equal(auditSummary("product.price", price), "من 3,500 د.ع إلى 3,750 د.ع · تعديل يدوي");
  assert.deepEqual(auditDetails(price), [{ label: "المصدر", value: "تعديل يدوي" }]);

  const topUp = JSON.stringify({
    productId: "p", batchNo: "BR400", qty: 45, invoiceNo: "INV-1", from: { qty: 55, unitCost: 2400 }, to: { qty: 100, unitCost: 2490 },
  });
  assert.deepEqual(
    auditChanges("batch.receive", topUp).map((c) => [c.label, c.before, c.after]),
    [["الكمية", "55", "100"], ["تكلفة الوحدة", "2,400 د.ع", "2,490 د.ع"]],
  );
  assert.equal(auditSummary("batch.receive", topUp), "45 وحدة · الدفعة BR400 · الكمية من 55 إلى 100 · التكلفة من 2,400 د.ع إلى 2,490 د.ع · فاتورة الشراء INV-1");

  // A new batch has nothing before it.
  const fresh = JSON.stringify({ batchNo: "N1", qty: 12, from: null, to: { qty: 12, unitCost: 900 } });
  assert.deepEqual(auditChanges("batch.receive", fresh).map((c) => c.before), ["—", "—"]);

  const adjust = JSON.stringify({ from: { qty: 10 }, to: { qty: 6 }, reason: "تالف" });
  assert.equal(auditSummary("batch.adjust", adjust), "الكمية من 10 إلى 6 · السبب: تالف");
});

test("account, role and discount cap changes", () => {
  const status = JSON.stringify({ from: { active: true }, to: { active: false } });
  assert.equal(auditSummary("user.status", status), "تعطيل الحساب");
  assert.deepEqual(auditChanges("user.status", status).map((c) => [c.before, c.after]), [["مفعّل", "معطّل"]]);
  const role = JSON.stringify({ from: { role: "cashier", overrides: {} }, to: { role: "cashier", overrides: { giveDiscount: null, viewReports: true } } });
  assert.deepEqual(auditChanges("user.role", role).map((c) => [c.label, c.before, c.after]), [["الصلاحيات الخاصة", "حسب الدور", "عرض التقارير: مسموح"]]);
  const cap = JSON.stringify({ from: { maxDiscountPct: 10 }, to: { maxDiscountPct: 15 } });
  assert.equal(auditSummary("settings.sales", cap), "حد الخصم من 10٪ إلى 15٪");
});

test("the week starts on Saturday", () => {
  assert.equal(weekStart("2026-10-17"), "2026-10-17"); // Saturday
  assert.equal(weekStart("2026-10-14"), "2026-10-10"); // Wednesday
  assert.equal(weekStart("2026-10-16"), "2026-10-10"); // Friday
  assert.equal(weekStart("2026-03-01"), "2026-02-28"); // Sunday, across a month end
});
