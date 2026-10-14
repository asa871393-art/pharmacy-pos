// The phone scanner page (src-tauri/assets/scan.html) is plain HTML served by the app. A syntax error in its scripts
// leaves the phone with a page that does nothing, so check they parse and keep the on-screen error reporting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../src-tauri/assets/scan.html", import.meta.url), "utf8");
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test("every inline script on the phone page parses", () => {
  assert.ok(inline.length >= 2);
  for (const [i, src] of inline.entries()) assert.doesNotThrow(() => new Function(src), `inline script ${i}`);
});

test("errors are reported on screen before the scanner library loads", () => {
  const firstHandler = html.indexOf('addEventListener("error"');
  const library = html.indexOf('src="/scan/html5-qrcode.min.js"');
  assert.ok(firstHandler > 0 && firstHandler < library, "error handler must be installed before the library");
  assert.match(html, /html5-qrcode\.min\.js" onerror=/, "a failed library load is reported");
  assert.doesNotMatch(html, /https?:\/\/(unpkg|cdn|cdnjs)/, "nothing is loaded from the internet");
});
