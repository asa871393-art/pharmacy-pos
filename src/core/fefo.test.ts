import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateFefo, availableQty, expiryStatus, InsufficientStockError } from "./fefo.ts";
import type { Batch } from "./types.ts";

const today = "2026-10-13";
const b = (id: string, expiryDate: string, qtyOnHand: number, receivedAt = "2026-01-01"): Batch => ({
  id, productId: "p", batchNo: id.toUpperCase(), expiryDate, qtyOnHand, unitCost: 1000, sellPrice: 1500, receivedAt,
});

const batches = [b("late", "2027-12-31", 96), b("soon", "2026-11-30", 24), b("mid", "2027-06-30", 60), b("dead", "2026-10-08", 5), b("empty", "2026-10-20", 0)];

test("draws from the soonest-expiring sellable batch first", () => {
  const r = allocateFefo(batches, 10, { today });
  assert.deepEqual(r.allocations.map((a) => [a.batchId, a.qty]), [["soon", 10]]);
  assert.equal(r.overridesFefo, false);
});

test("spills over into the next batch", () => {
  const r = allocateFefo(batches, 30, { today });
  assert.deepEqual(r.allocations.map((a) => [a.batchId, a.qty]), [["soon", 24], ["mid", 6]]);
});

test("never sells expired or empty batches", () => {
  assert.equal(availableQty(batches, { today }), 180);
  assert.throws(() => allocateFefo(batches, 181, { today }), InsufficientStockError);
});

test("a batch expiring today is not sellable", () => {
  assert.equal(availableQty([b("x", today, 3)], { today }), 0);
});

test("minimum days left excludes near batches", () => {
  const r = allocateFefo(batches, 5, { today, minDaysLeft: 60 });
  assert.equal(r.allocations[0].batchId, "mid");
});

test("preferred batch goes first and is flagged as a FEFO override", () => {
  const r = allocateFefo(batches, 70, { today, preferredBatchId: "late" });
  assert.deepEqual(r.allocations.map((a) => [a.batchId, a.qty]), [["late", 70]]);
  assert.equal(r.overridesFefo, true);
});

test("preferring the FEFO batch itself is not an override", () => {
  assert.equal(allocateFefo(batches, 1, { today, preferredBatchId: "soon" }).overridesFefo, false);
});

test("ties on expiry fall back to oldest received", () => {
  const r = allocateFefo([b("new", "2027-01-31", 5, "2026-09-01"), b("old", "2027-01-31", 5, "2026-03-01")], 1, { today });
  assert.equal(r.allocations[0].batchId, "old");
});

test("rejects non-positive or fractional quantities", () => {
  assert.throws(() => allocateFefo(batches, 0, { today }), RangeError);
  assert.throws(() => allocateFefo(batches, 1.5, { today }), RangeError);
});

test("expiry status tiers", () => {
  assert.equal(expiryStatus("2026-10-13", today), "expired");
  assert.equal(expiryStatus("2026-11-05", today), "critical");
  assert.equal(expiryStatus("2026-12-31", today), "warning");
  assert.equal(expiryStatus("2027-03-01", today), "watch");
  assert.equal(expiryStatus("2028-01-01", today), "ok");
});
