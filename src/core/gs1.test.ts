import { test } from "node:test";
import assert from "node:assert/strict";
import { gs1DateToIso, gtinLookupKeys, looksLikeScan, parseScan } from "./gs1.ts";

const GS = "\u001d";

test("parses raw DataMatrix element string with GS separators", () => {
  const r = parseScan("0106281086001234" + "17270831" + "10GL554" + GS + "21SN0001");
  assert.equal(r.kind, "gs1");
  if (r.kind !== "gs1") return;
  assert.equal(r.data.gtin, "06281086001234");
  assert.equal(r.data.expiry, "2027-08-31");
  assert.equal(r.data.batch, "GL554");
  assert.equal(r.data.serial, "SN0001");
});

test("handles symbology identifier prefix", () => {
  const r = parseScan("]d20106281086001234172708311" + "0B2311");
  assert.equal(r.kind, "gs1");
  if (r.kind !== "gs1") return;
  assert.equal(r.data.expiry, "2027-08-31");
  assert.equal(r.data.batch, "B2311");
});

test("parses human-readable parenthesised form", () => {
  const r = parseScan("(01)06281086001234(17)270800(10)PX0921");
  assert.equal(r.kind, "gs1");
  if (r.kind !== "gs1") return;
  assert.equal(r.data.expiry, "2027-08-31", "day 00 means end of month");
  assert.equal(r.data.batch, "PX0921");
});

test("plain EAN-13 is returned as a plain code", () => {
  assert.deepEqual(parseScan(" 2000000000015 "), { kind: "plain", code: "2000000000015" });
});

test("GS1 date conversion edge cases", () => {
  assert.equal(gs1DateToIso("280200"), "2028-02-29"); // leap year end of month
  assert.equal(gs1DateToIso("271301"), undefined);
  assert.equal(gs1DateToIso("270231"), undefined);
});

test("GTIN lookup keys include the 13-digit form", () => {
  assert.deepEqual(gtinLookupKeys("06281086001234"), ["06281086001234", "6281086001234"]);
});

test("distinguishes scans from typed searches", () => {
  assert.equal(looksLikeScan("2000000000015"), true);
  assert.equal(looksLikeScan("0106281086001234172708311"), true);
  assert.equal(looksLikeScan("panadol"), false);
  assert.equal(looksLikeScan("ميتفورمين 850"), false);
});
