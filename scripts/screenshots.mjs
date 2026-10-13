// Drives the POS screen in a real browser and saves screenshots (used by CI to check the UI).
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

mkdirSync("screenshots", { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto("http://localhost:4173/");
await page.waitForSelector("#pos-search");
await page.screenshot({ path: "screenshots/1-empty.png" });

// Typed search by active ingredient in Arabic
await page.getByRole("button", { name: "المادة الفعالة" }).click();
await page.fill("#pos-search", "ميتفورمين 850");
await page.waitForTimeout(400);
await page.screenshot({ path: "screenshots/2-search.png" });
await page.keyboard.press("Enter");

// Barcode scans: plain EAN and a GS1 string naming a specific batch
for (const code of ["2000000000046", "2000000000046", "(01)02000000000077(17)301231(10)B2311"]) {
  await page.fill("#pos-search", code);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
}
await page.getByLabel("كمية Panadol Extra").fill("30");
await page.waitForTimeout(200);
await page.screenshot({ path: "screenshots/3-cart.png" });

await page.fill("#tendered", "200000");
await page.keyboard.press("F12");
await page.waitForSelector(".banner.success");
await page.screenshot({ path: "screenshots/4-sold.png" });

await browser.close();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("screenshots saved");
