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
await page.keyboard.press("Escape");

// Purchasing: a credit invoice with a GS1 scan (batch and expiry filled in) and a typed search
await page.getByRole("button", { name: "المشتريات" }).click();
await page.selectOption("#pur-supplier", "s-a");
await page.fill("#pur-no", "A-2026-118");
await page.fill("#pur-search", "(01)02000000000046(17)290630(10)PX2001");
await page.keyboard.press("Enter");
await page.waitForSelector(".pur-table tbody tr input");
await page.getByLabel("كمية Panadol Extra").fill("48");
await page.getByLabel("سعر شراء Panadol Extra").fill("2200");
await page.fill("#pur-search", "brufen");
await page.waitForSelector(".pur-results button");
await page.keyboard.press("Enter");
await page.getByLabel("رقم تشغيلة Brufen 400 mg").fill("BR610");
await page.getByLabel("تاريخ انتهاء Brufen 400 mg").fill("2028-11-30");
await page.getByLabel("كمية Brufen 400 mg").fill("60");
await page.getByLabel("سعر شراء Brufen 400 mg").fill("2450");
await page.getByLabel("سعر بيع Brufen 400 mg").fill("3750");
await page.screenshot({ path: "screenshots/9-purchase.png" });
await page.getByRole("button", { name: /ترحيل الفاتورة/ }).click();
await page.waitForSelector(".pur-panel .banner.success");
await page.screenshot({ path: "screenshots/10-purchase-posted.png" });

// Reports: a pharmacist sees the stock reports; the admin also sees sales, profit and prescriptions
await page.getByRole("button", { name: "التقارير", exact: true }).click();
await page.waitForSelector(".rep .tile.hero");
await page.screenshot({ path: "screenshots/11-report-expiry.png" });
await page.getByRole("tab", { name: "إعادة الطلب" }).click();
await page.waitForSelector(".rep-table tbody tr");
await page.screenshot({ path: "screenshots/12-report-reorder.png" });
await page.click(".logout");
await page.fill("#login-user", "admin");
await page.fill("#login-pass", "demo1234");
await page.keyboard.press("Enter");
await page.getByRole("button", { name: "التقارير", exact: true }).click();
await page.waitForSelector(".rep .tile.hero");
await page.screenshot({ path: "screenshots/13-report-sales.png" });
await page.getByRole("tab", { name: "سجل الوصفات الطبية" }).click();
await page.waitForSelector(".rep-table tbody tr");
await page.screenshot({ path: "screenshots/14-report-rx.png" });

// Employees (admin only)
await page.getByRole("button", { name: "الموظفين", exact: true }).click();
await page.waitForSelector(".users-table tbody tr");
await page.screenshot({ path: "screenshots/15-users.png" });
await page.locator(".users-table tbody tr", { hasText: "الكاشير" }).getByRole("button", { name: "الدور والصلاحيات" }).click();
await page.waitForSelector(".perm-list");
await page.screenshot({ path: "screenshots/16-user-access.png" });
await page.keyboard.press("Escape");

// Discount cap (admin only)
await page.getByRole("button", { name: "حد الخصم" }).click();
await page.fill("#cap-pct", "15");
await page.getByRole("button", { name: "حفظ", exact: true }).click();
await page.waitForSelector(".banner.success");

// Edit a product: its price and pack size
await page.getByRole("button", { name: "المخزون", exact: true }).click();
await page.locator(".inv-table tbody tr", { hasText: "Panadol Extra" }).first().click();
await page.getByRole("button", { name: "تعديل بيانات الصنف والسعر" }).click();
const price = Number(await page.inputValue("#np-price"));
await page.fill("#np-price", String(price + 250));
await page.fill("#np-pack", "20");
await page.screenshot({ path: "screenshots/17-product-edit.png" });
await page.getByRole("button", { name: "حفظ التعديلات" }).click();
await page.waitForSelector(".batch-summary");
await page.keyboard.press("Escape");

// Audit log (admin only): every change above, with quick filters and the full record of one entry
await page.getByRole("button", { name: "التقارير", exact: true }).click();
await page.getByRole("tab", { name: "سجل التدقيق" }).click();
await page.waitForSelector(".rep-table tbody tr td.n");
await page.screenshot({ path: "screenshots/18-audit-log-all.png" });
await page.getByRole("button", { name: "تغيير الأسعار" }).click();
await page.waitForFunction(() =>
  [...document.querySelectorAll(".rep-table tbody tr")].every((tr) => /تغيير سعر البيع|استلام دفعة/.test(tr.textContent ?? "")),
);
await page.screenshot({ path: "screenshots/18-audit-prices.png" });
await page.getByRole("button", { name: "إدارة المستخدمين" }).click();
await page.getByRole("button", { name: "تعديلات المخزون" }).click();
await page.waitForSelector(".rep-table tbody tr td.n");
await page.locator(".rep-table tbody tr", { hasText: "تعديل بيانات صنف" }).getByRole("button", { name: /عرض العملية/ }).click();
await page.waitForSelector(".audit-diff");
await page.screenshot({ path: "screenshots/19-audit-entry.png" });
await page.keyboard.press("Escape");

// Branches: ship stock from the main branch to Karrada, move this device to Karrada at sign-in, receive it there
await page.getByRole("button", { name: "المخزون", exact: true }).click();
await page.getByRole("tab", { name: "التحويل بين الفروع" }).click();
await page.getByRole("button", { name: "شحن إلى فرع" }).click();
await page.selectOption("#tr-branch", "br-karrada");
await page.selectOption("#tr-product", "p-brufen-400");
await page.fill("#tr-qty", "10");
await page.getByRole("button", { name: "إضافة", exact: true }).click();
await page.screenshot({ path: "screenshots/20-transfer-ship.png" });
await page.getByRole("button", { name: "شحن", exact: true }).click();
await page.waitForSelector(".inv-panel .banner.success");
await page.screenshot({ path: "screenshots/21-transfer-shipped.png" });

await page.click(".logout");
await page.waitForSelector("#login-branch");
await page.fill("#login-user", "admin");
await page.fill("#login-pass", "demo1234");
await page.selectOption("#login-branch", "br-karrada");
await page.screenshot({ path: "screenshots/22-login-branch.png" });
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.querySelector(".branch-chip")?.textContent?.includes("فرع الكرادة"));
await page.getByRole("button", { name: "المخزون", exact: true }).click();
await page.getByRole("tab", { name: "التحويل بين الفروع" }).click();
await page.locator(".inv-table tbody tr", { hasText: "وارد من الفرع الرئيسي" }).getByRole("button", { name: "استلام" }).click();
await page.waitForSelector(".inv-panel .banner.success");
await page.screenshot({ path: "screenshots/23-transfer-received.png" });

// A request from Karrada to the main branch: nothing moves until the main branch ships it
await page.getByRole("button", { name: "طلب مخزون من فرع" }).click();
await page.selectOption("#tr-product", "p-panadol-extra");
await page.fill("#tr-qty", "12");
await page.getByRole("button", { name: "إضافة", exact: true }).click();
await page.getByRole("button", { name: "إرسال الطلب" }).click();
await page.waitForSelector(".inv-panel .banner.success");

// Reports across branches
await page.getByRole("button", { name: "التقارير", exact: true }).click();
await page.getByRole("tab", { name: "المبيعات والأرباح" }).click();
await page.waitForSelector(".rep .tile.hero");
await page.locator(".rep-filters select").first().selectOption("");
await page.waitForSelector(".rep .tile.hero");
await page.screenshot({ path: "screenshots/24-report-all-branches.png" });

// Only an admin moves a device to another branch
await page.click(".logout");
await page.fill("#login-user", "pharm");
await page.fill("#login-pass", "demo1234");
await page.selectOption("#login-branch", "br-main");
await page.keyboard.press("Enter");
await page.waitForSelector(".login .banner.error");
await page.screenshot({ path: "screenshots/25-login-branch-refused.png" });

await browser.close();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("screenshots saved");
