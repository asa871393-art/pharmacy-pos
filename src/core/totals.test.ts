import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTotals, formatIqd, settle } from "./totals.ts";

test("totals with line and invoice discounts", () => {
  const t = computeTotals(
    [
      { unitPrice: 18500, qty: 1, discount: 0 },
      { unitPrice: 3000, qty: 2, discount: 500 },
      { unitPrice: 6250, qty: 2, discount: 0 },
    ],
    1000,
  );
  assert.deepEqual(t, { subtotal: 37000, lineDiscounts: 500, invoiceDiscount: 1000, total: 35500 });
});

test("discounts never push a total below zero", () => {
  const t = computeTotals([{ unitPrice: 1000, qty: 1, discount: 5000 }], 9999);
  assert.equal(t.total, 0);
});

test("cash overpayment gives change", () => {
  assert.deepEqual(settle(14000, [{ method: "cash", amount: 15000 }]), { paid: 14000, tendered: 15000, change: 1000, remaining: 0, onCredit: 0 });
});

test("split card + cash: card applied first, change only from cash", () => {
  const s = settle(20000, [{ method: "cash", amount: 10000 }, { method: "card", amount: 12000 }]);
  assert.equal(s.change, 2000);
  assert.equal(s.remaining, 0);
});

test("partial cash with the rest on credit", () => {
  const s = settle(20000, [{ method: "cash", amount: 5000 }, { method: "credit", amount: 15000 }]);
  assert.equal(s.onCredit, 15000);
  assert.equal(s.remaining, 0);
  assert.equal(s.change, 0);
});

test("underpayment leaves a remaining balance", () => {
  assert.equal(settle(10000, [{ method: "cash", amount: 4000 }]).remaining, 6000);
});

test("formats dinars with thousands separators", () => {
  assert.equal(formatIqd(184500000), "184,500,000");
});
