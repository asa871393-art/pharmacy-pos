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
await page.waitForSelector("#login-user");
await page.screenshot({ path: "screenshots/0-login.png" });
await page.fill("#login-user", "pharm");
await page.fill("#login-pass", "demo1234");
await page.keyboard.press("Enter");
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

// Augmentin is prescription-only: the sale cannot complete until the prescription is entered.
await page.fill("#rx-no", "RX-2026-0042");
await page.fill("#rx-by", "د. سارة الجبوري");

await page.fill("#tendered", "200000");
await page.keyboard.press("F12");
await page.waitForSelector(".banner.success");
await page.screenshot({ path: "screenshots/4-sold.png" });

// Inventory: stock reflects the sale, filters, a new product and its first batch
await page.getByRole("button", { name: "المخزون" }).click();
await page.waitForSelector(".inv-table tbody tr");
await page.screenshot({ path: "screenshots/5-inventory.png" });
await page.getByRole("button", { name: /مخزون منخفض/ }).click();
await page.screenshot({ path: "screenshots/6-inventory-low.png" });
await page.getByRole("button", { name: /^الكل/ }).click();

await page.getByRole("button", { name: "+ صنف جديد" }).click();
await page.fill("#np-name", "Zyrtec 10 mg");
await page.fill("#np-name-ar", "زيرتك");
await page.fill("#np-strength", "10 mg");
await page.fill("#np-pack", "10");
await page.fill("#np-price", "5000");
await page.selectOption("#np-cat", "cat-otc");
await page.fill("#np-barcode", "6281000000017");
await page.fill("#np-reorder", "20");
await page.screenshot({ path: "screenshots/7-new-product.png" });
await page.getByRole("button", { name: "حفظ الصنف" }).click();

// Saving opens the batches dialog so the first stock can be received straight away
await page.waitForSelector("#rc-batch");
await page.fill("#rc-batch", "ZY001");
await page.fill("#rc-exp", "2028-06-30");
await page.fill("#rc-qty", "40");
await page.fill("#rc-cost", "3500");
await page.getByRole("button", { name: "استلام", exact: true }).click();
await page.waitForSelector(".modal .banner.success");
await page.screenshot({ path: "screenshots/8-received.png" });

await browser.close();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("screenshots saved");
