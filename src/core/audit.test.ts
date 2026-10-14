import { test } from "node:test";
import assert from "node:assert/strict";
import { auditActionLabel, auditSummary } from "./audit.ts";
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

test("the week starts on Saturday", () => {
  assert.equal(weekStart("2026-10-17"), "2026-10-17"); // Saturday
  assert.equal(weekStart("2026-10-14"), "2026-10-10"); // Wednesday
  assert.equal(weekStart("2026-10-16"), "2026-10-10"); // Friday
  assert.equal(weekStart("2026-03-01"), "2026-02-28"); // Sunday, across a month end
});
