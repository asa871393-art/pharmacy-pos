import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE128_PATTERNS, code128Values, code128Widths } from "./code128.ts";

test("pattern table is the standard 107 symbols", () => {
  assert.equal(CODE128_PATTERNS.length, 107);
  for (const [i, p] of CODE128_PATTERNS.entries()) {
    const modules = [...p].reduce((s, d) => s + Number(d), 0);
    assert.equal(modules, i === 106 ? 13 : 11, `symbol ${i}`);
  }
  assert.equal(new Set(CODE128_PATTERNS).size, 107, "no duplicates");
});

test("checksum is start + weighted data values mod 103", () => {
  // "MB-2026-000001": M=45 B=34 -=13 2=18 0=16 6=22 1=17.
  const v = code128Values("MB-2026-000001");
  const data = [45, 34, 13, 18, 16, 18, 22, 13, 16, 16, 16, 16, 16, 17];
  assert.deepEqual(v.slice(1, -2), data);
  const sum = data.reduce((s, x, i) => s + x * (i + 1), 104);
  assert.equal(v.at(-2), sum % 103);
  assert.deepEqual([v[0], v.at(-1)], [104, 106]);
});

test("widths start with a bar and cover every module", () => {
  const w = code128Widths("AB");
  assert.equal(w.length, 6 * 4 + 7);
  assert.equal(w.reduce((s, x) => s + x, 0), 11 * 4 + 13);
});

test("rejects characters outside set B", () => {
  assert.throws(() => code128Values("فاتورة"), RangeError);
});
