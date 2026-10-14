import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOverrides, resolvePermissions } from "./permissions.ts";

test("role defaults", () => {
  assert.deepEqual(resolvePermissions("cashier"), { giveDiscount: true, dispenseRx: false, viewReports: false, modifyInventory: false });
  assert.deepEqual(resolvePermissions("pharmacist"), { giveDiscount: true, dispenseRx: true, viewReports: false, modifyInventory: true });
  assert.deepEqual(resolvePermissions("storekeeper"), { giveDiscount: false, dispenseRx: false, viewReports: false, modifyInventory: true });
});

test("overrides grant and deny; null follows the role", () => {
  const p = resolvePermissions("cashier", { dispenseRx: true, giveDiscount: false, viewReports: null });
  assert.equal(p.dispenseRx, true);
  assert.equal(p.giveDiscount, false);
  assert.equal(p.viewReports, false);
});

test("admins always have everything", () => {
  const p = resolvePermissions("admin", { dispenseRx: false, viewReports: false });
  assert.ok(Object.values(p).every(Boolean));
  assert.deepEqual(normalizeOverrides("admin", { dispenseRx: false }), {});
});

test("only real exceptions are kept", () => {
  assert.deepEqual(normalizeOverrides("pharmacist", { dispenseRx: true, viewReports: true, giveDiscount: null }), { viewReports: true });
});
