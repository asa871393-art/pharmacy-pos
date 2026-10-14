// In-memory store with the same demo data as src-tauri/migrations/demo_seed.sql.
// Used when the screens run in a normal browser (npm run dev) so they can be tried without the desktop app.

import { addDays, availableQty, sellableBatches } from "../core/fefo.ts";
import { computeTotals, settle } from "../core/totals.ts";
import {
  INVENTORY_ROLES,
  type AdjustBatchInput,
  type Batch,
  type Category,
  type InventoryItem,
  type NewProduct,
  type NewSupplier,
  type PurchaseInvoice,
  type PurchaseResult,
  type ProductHit,
  type ReceiveBatchInput,
  type Role,
  type SaleDraft,
  type SaleResult,
  type SearchMode,
  type Supplier,
  type User,
} from "../core/types.ts";
import { localToday, type PharmacyRepo } from "./repo.ts";

interface DemoProduct {
  id: string;
  tradeName: string;
  tradeNameAr?: string;
  /** Seeded products leave this out and are filed under Rx/OTC; added products set it (null = none). */
  categoryId?: string | null;
  ingredients: { inn: string; ar: string; cls: string }[];
  strength: string;
  form: string;
  packSize: number;
  price: number;
  rx: boolean;
  key: string;
  barcode?: string;
}

const categories: Category[] = [
  { id: "cat-rx", nameAr: "أدوية بوصفة" },
  { id: "cat-otc", nameAr: "أدوية بدون وصفة" },
];

// Same as reorder_rules in demo_seed.sql.
const reorderLevels: Record<string, number> = { "p-panadol-extra": 60, "p-amoxil-500": 25, "p-ventolin": 15 };

// Same suppliers as demo_seed.sql.
const suppliers: Supplier[] = [
  { id: "s-a", name: "المورد أ (تجريبي)", phone: null, paymentTermsDays: 30, balance: 0 },
  { id: "s-b", name: "المورد ب (تجريبي)", phone: null, paymentTermsDays: 45, balance: 0 },
];

const ing = {
  metformin: { inn: "Metformin", ar: "ميتفورمين", cls: "biguanide" },
  paracetamol: { inn: "Paracetamol", ar: "باراسيتامول", cls: "analgesic" },
  caffeine: { inn: "Caffeine", ar: "كافيين", cls: "stimulant" },
  amoxicillin: { inn: "Amoxicillin", ar: "أموكسيسيلين", cls: "penicillin" },
  clavulanate: { inn: "Clavulanic acid", ar: "حمض الكلافولانيك", cls: "beta-lactamase inhibitor" },
  bisoprolol: { inn: "Bisoprolol", ar: "بيسوبرولول", cls: "beta blocker" },
  esomeprazole: { inn: "Esomeprazole", ar: "إيسوميبرازول", cls: "proton pump inhibitor" },
  salbutamol: { inn: "Salbutamol", ar: "سالبيوتامول", cls: "beta agonist" },
  ibuprofen: { inn: "Ibuprofen", ar: "إيبوبروفين", cls: "nsaid" },
};

const products: DemoProduct[] = [
  { id: "p-glucophage-850", tradeName: "Glucophage 850 mg", ingredients: [ing.metformin], strength: "850 mg", form: "قرص", packSize: 30, price: 6250, rx: true, key: "metformin:850mg", barcode: "2000000000015" },
  { id: "p-metformin-850", tradeName: "Metformin 850 (محلي)", ingredients: [ing.metformin], strength: "850 mg", form: "قرص", packSize: 30, price: 4000, rx: true, key: "metformin:850mg", barcode: "2000000000022" },
  { id: "p-glucophage-xr", tradeName: "Glucophage XR 750 mg", ingredients: [ing.metformin], strength: "750 mg", form: "قرص ممتد المفعول", packSize: 30, price: 7500, rx: true, key: "metformin:750mg:xr", barcode: "2000000000039" },
  { id: "p-panadol-extra", tradeName: "Panadol Extra", ingredients: [ing.paracetamol, ing.caffeine], strength: "500 mg + 65 mg", form: "قرص", packSize: 24, price: 3000, rx: false, key: "caffeine:65mg|paracetamol:500mg", barcode: "2000000000046" },
  { id: "p-panadol-500", tradeName: "Panadol 500 mg", ingredients: [ing.paracetamol], strength: "500 mg", form: "قرص", packSize: 24, price: 2000, rx: false, key: "paracetamol:500mg", barcode: "2000000000053" },
  { id: "p-fevadol-500", tradeName: "Fevadol 500 mg", ingredients: [ing.paracetamol], strength: "500 mg", form: "قرص", packSize: 20, price: 1750, rx: false, key: "paracetamol:500mg", barcode: "2000000000060" },
  { id: "p-augmentin-1g", tradeName: "Augmentin 1 g", ingredients: [ing.amoxicillin, ing.clavulanate], strength: "875 mg + 125 mg", form: "قرص", packSize: 14, price: 18500, rx: true, key: "amoxicillin:875mg|clavulanic acid:125mg", barcode: "2000000000077" },
  { id: "p-amoxil-500", tradeName: "Amoxil 500 mg", ingredients: [ing.amoxicillin], strength: "500 mg", form: "كبسول", packSize: 20, price: 4500, rx: true, key: "amoxicillin:500mg", barcode: "2000000000084" },
  { id: "p-concor-5", tradeName: "Concor 5 mg", ingredients: [ing.bisoprolol], strength: "5 mg", form: "قرص", packSize: 30, price: 9000, rx: true, key: "bisoprolol:5mg", barcode: "2000000000091" },
  { id: "p-nexium-40", tradeName: "Nexium 40 mg", ingredients: [ing.esomeprazole], strength: "40 mg", form: "قرص", packSize: 14, price: 15000, rx: true, key: "esomeprazole:40mg", barcode: "2000000000107" },
  { id: "p-ventolin", tradeName: "Ventolin Inhaler", ingredients: [ing.salbutamol], strength: "100 mcg/dose", form: "بخاخ", packSize: 1, price: 7000, rx: true, key: "salbutamol:100mcg", barcode: "2000000000114" },
  { id: "p-brufen-400", tradeName: "Brufen 400 mg", ingredients: [ing.ibuprofen], strength: "400 mg", form: "قرص", packSize: 30, price: 3500, rx: false, key: "ibuprofen:400mg", barcode: "2000000000121" },
];

function seedBatches(today: string): Batch[] {
  const row = (id: string, productId: string, batchNo: string, days: number, unitCost: number, sellPrice: number, qty: number): Batch => ({
    id, productId, batchNo, expiryDate: addDays(today, days), qtyOnHand: qty, unitCost, sellPrice, receivedAt: "2026-01-01",
  });
  return [
    row("b-gl-554", "p-glucophage-850", "GL554", 300, 5000, 6250, 46),
    row("b-gl-601", "p-glucophage-850", "GL601", 520, 5050, 6250, 30),
    row("b-mf-220", "p-metformin-850", "MF220", 400, 2900, 4000, 120),
    row("b-px-0921", "p-panadol-extra", "PX0921", 48, 2050, 3000, 24),
    row("b-px-1104", "p-panadol-extra", "PX1104", 260, 2100, 3000, 60),
    row("b-px-1210", "p-panadol-extra", "PX1210", 440, 2150, 3000, 96),
    row("b-pn-300", "p-panadol-500", "PN300", 600, 1400, 2000, 80),
    row("b-fv-77", "p-fevadol-500", "FV77", 150, 1200, 1750, 40),
    row("b-au-2311", "p-augmentin-1g", "B2311", 170, 14800, 18500, 18),
    row("b-am-009", "p-amoxil-500", "AM009", -5, 2900, 4500, 4),
    row("b-am-014", "p-amoxil-500", "AM014", 22, 2900, 4500, 18),
    row("b-cn-118", "p-concor-5", "CN118", 470, 7200, 9000, 25),
    row("b-nx-40a", "p-nexium-40", "NX40A", 135, 11800, 15000, 42),
    row("b-vt-501", "p-ventolin", "VT501", 75, 5400, 7000, 9),
    row("b-br-400", "p-brufen-400", "BR400", 380, 2400, 3500, 55),
  ];
}

// Demo accounts, one per role that sells. All use DEMO_PASSWORD; the login screen shows it in demo mode.
export const DEMO_PASSWORD = "demo1234";
const users: User[] = [
  { id: "u-admin", username: "admin", fullName: "مدير النظام", role: "admin" },
  { id: "u-pharm", username: "pharm", fullName: "الصيدلاني", role: "pharmacist" },
  { id: "u-cash", username: "cash", fullName: "الكاشير", role: "cashier" },
];

// Same rules as post_sale in src-tauri/src/lib.rs.
const MAX_DISCOUNT_PCT = 10;
const UNLIMITED_DISCOUNT_ROLES: Role[] = ["admin", "chief_pharmacist"];
const RX_ROLES: Role[] = ["admin", "chief_pharmacist", "pharmacist"];

export function createDemoRepo(): PharmacyRepo {
  const today = localToday();
  const batches = seedBatches(today);
  let counter = 0;
  let current: User | null = null;
  const postedInvoices = new Set<string>(); // supplierId|invoiceNo

  const toHit = (p: DemoProduct): ProductHit => {
    const own = batches.filter((b) => b.productId === p.id);
    const sellable = sellableBatches(own, { today });
    return {
      id: p.id,
      tradeName: p.tradeName,
      generic: p.ingredients.map((i) => i.inn).join(" + "),
      strength: p.strength,
      form: p.form,
      packSize: p.packSize,
      price: p.price,
      stock: availableQty(own, { today }),
      nearestExpiry: sellable[0]?.expiryDate ?? null,
      requiresRx: p.rx,
      compositionKey: p.key,
      drugClasses: p.ingredients.map((i) => i.cls),
    };
  };

  const toInventory = (p: DemoProduct): InventoryItem => {
    const own = batches.filter((b) => b.productId === p.id);
    const categoryId = p.categoryId === undefined ? (p.rx ? "cat-rx" : "cat-otc") : p.categoryId;
    return {
      id: p.id,
      barcode: p.barcode ?? null,
      tradeName: p.tradeName,
      tradeNameAr: p.tradeNameAr ?? null,
      category: categories.find((c) => c.id === categoryId)?.nameAr ?? null,
      form: p.form,
      strength: p.strength,
      packSize: p.packSize,
      price: p.price,
      requiresRx: p.rx,
      stock: availableQty(own, { today }),
      expiredQty: own.filter((b) => b.expiryDate <= today).reduce((s, b) => s + b.qtyOnHand, 0),
      nearestExpiry: sellableBatches(own, { today })[0]?.expiryDate ?? null,
      reorderLevel: reorderLevels[p.id] ?? null,
    };
  };

  // Same checks as the inventory commands in src-tauri/src/lib.rs.
  const requireInventoryRole = () => {
    if (!current) throw new Error("سجّل الدخول أولاً");
    if (!INVENTORY_ROLES.includes(current.role)) throw new Error("ليست لديك صلاحية لتعديل المخزون");
    return current;
  };
  const productById = (id: string) => {
    const p = products.find((x) => x.id === id);
    if (!p) throw new Error("صنف غير موجود أو موقوف");
    return p;
  };
  const isIsoDate = (d: string) => {
    const t = Date.parse(d + "T00:00:00Z");
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
  };

  // Same rules as post_purchase_invoice in src-tauri/src/lib.rs: validate every line, then write.
  const postPurchase = (inv: PurchaseInvoice): PurchaseResult => {
    requireInventoryRole();
    const supplier = suppliers.find((s) => s.id === inv.supplierId);
    if (!supplier) throw new Error("اختر المورد");
    const invoiceNo = inv.supplierInvoiceNo.trim();
    if (!invoiceNo) throw new Error("رقم فاتورة الشراء مطلوب");
    if (postedInvoices.has(`${supplier.id}|${invoiceNo}`)) throw new Error(`الفاتورة ${invoiceNo} من ${supplier.name} مُرحّلة مسبقاً`);
    if (!isIsoDate(inv.invoiceDate)) throw new Error("تاريخ الفاتورة غير صالح");
    if (inv.invoiceDate > today) throw new Error("تاريخ الفاتورة في المستقبل");
    if (inv.payment !== "cash" && inv.payment !== "credit") throw new Error("حالة الدفع يجب أن تكون نقداً أو آجلاً");
    if (inv.lines.length === 0) throw new Error("أضف صنفاً واحداً على الأقل");

    const seen = new Set<string>();
    const prices = new Map<string, number>();
    inv.lines.forEach((l, i) => {
      const n = i + 1;
      const p = products.find((x) => x.id === l.productId);
      if (!p) throw new Error(`السطر ${n}: صنف غير موجود أو موقوف`);
      const at = `السطر ${n} (${p.tradeName})`;
      const batchNo = l.batchNo.trim();
      if (!batchNo) throw new Error(`${at}: رقم التشغيلة مطلوب`);
      if (!isIsoDate(l.expiryDate)) throw new Error(`${at}: تاريخ الانتهاء غير صالح`);
      if (l.expiryDate <= today) throw new Error(`${at}: لا يُستلم مخزون منتهي الصلاحية`);
      if (!(l.qty > 0)) throw new Error(`${at}: الكمية يجب أن تكون أكبر من صفر`);
      if (l.unitCost < 0) throw new Error(`${at}: سعر الشراء لا يكون سالباً`);
      if (!(l.sellPrice > 0)) throw new Error(`${at}: سعر البيع يجب أن يكون أكبر من صفر`);
      if (seen.has(`${p.id}|${batchNo}`)) throw new Error(`${at}: التشغيلة ${batchNo} مكررة في الفاتورة، اجمع الكمية في سطر واحد`);
      seen.add(`${p.id}|${batchNo}`);
      if (prices.has(p.id) && prices.get(p.id) !== l.sellPrice) throw new Error(`${p.tradeName}: سعر البيع مختلف بين أسطر الفاتورة`);
      prices.set(p.id, l.sellPrice);
      const shelf = batches.find((b) => b.productId === p.id && b.batchNo === batchNo);
      if (shelf && shelf.expiryDate !== l.expiryDate) {
        throw new Error(`التشغيلة ${batchNo} مسجّلة بتاريخ انتهاء ${shelf.expiryDate}، والفاتورة تذكر ${l.expiryDate}. تحقّق من العبوة`);
      }
    });

    let created = 0;
    let updated = 0;
    for (const l of inv.lines) {
      const batchNo = l.batchNo.trim();
      const shelf = batches.find((b) => b.productId === l.productId && b.batchNo === batchNo);
      if (shelf) {
        const qty = shelf.qtyOnHand + l.qty;
        shelf.unitCost = Math.floor((shelf.qtyOnHand * shelf.unitCost + l.qty * l.unitCost + Math.floor(qty / 2)) / qty);
        shelf.qtyOnHand = qty;
        shelf.sellPrice = l.sellPrice;
        updated += 1;
      } else {
        batches.push({
          id: `b-demo-${Date.now()}-${created}`,
          productId: l.productId,
          batchNo,
          expiryDate: l.expiryDate,
          qtyOnHand: l.qty,
          unitCost: l.unitCost,
          sellPrice: l.sellPrice,
          receivedAt: new Date().toISOString(),
        });
        created += 1;
      }
    }
    const priceChanges: string[] = [];
    for (const [id, price] of prices) {
      const p = productById(id);
      if (p.price !== price) {
        p.price = price;
        priceChanges.push(p.tradeName);
      }
    }
    const total = inv.lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
    let dueDate: string | null = null;
    if (inv.payment === "credit") {
      supplier.balance += total;
      dueDate = addDays(inv.invoiceDate, supplier.paymentTermsDays);
    }
    postedInvoices.add(`${supplier.id}|${invoiceNo}`);
    return {
      invoiceId: `pi-demo-${postedInvoices.size}`,
      total,
      units: inv.lines.reduce((s, l) => s + l.qty, 0),
      batchesCreated: created,
      batchesUpdated: updated,
      priceChanges: priceChanges.sort(),
      dueDate,
      supplierBalance: supplier.balance,
    };
  };

  const norm = (s: string) => s.toLowerCase();
  const matchesTrade = (p: DemoProduct, t: string) => norm(p.tradeName).includes(t) || norm(p.strength).includes(t);
  const matchesGeneric = (p: DemoProduct, t: string) =>
    norm(p.strength).includes(t) || p.ingredients.some((i) => norm(i.inn).includes(t) || i.ar.includes(t));
  const sortHits = (hits: ProductHit[]) =>
    hits.sort((a, b) => Number(b.stock > 0) - Number(a.stock > 0) || a.tradeName.localeCompare(b.tradeName));

  return {
    kind: "demo",
    async authStatus() {
      return { needsSetup: false, user: current };
    },
    async setupAdmin() {
      throw new Error("تم إعداد كلمة المرور مسبقاً، سجّل الدخول");
    },
    async login(username: string, password: string) {
      const u = users.find((x) => x.username === username.trim());
      if (!u || password !== DEMO_PASSWORD) throw new Error("اسم المستخدم أو كلمة المرور غير صحيحة");
      current = u;
      return u;
    },
    async logout() {
      current = null;
    },
    async search(query: string, mode: SearchMode) {
      const tokens = query.trim().split(/\s+/).filter(Boolean).map(norm);
      if (tokens.length === 0) return [];
      const match = (p: DemoProduct) =>
        tokens.every((t) => (mode === "trade" ? matchesTrade(p, t) : mode === "generic" ? matchesGeneric(p, t) : matchesTrade(p, t) || matchesGeneric(p, t)));
      let found = products.filter(match);
      if (mode === "alternatives") {
        const keys = new Set(found.map((p) => p.key));
        found = products.filter((p) => keys.has(p.key));
      }
      return sortHits(found.map(toHit));
    },
    async findByCode(codes: string[]) {
      const p = products.find((x) => x.barcode !== undefined && codes.includes(x.barcode));
      return p ? toHit(p) : null;
    },
    async alternatives(productId: string) {
      const key = products.find((p) => p.id === productId)?.key;
      return sortHits(products.filter((p) => p.key === key && p.id !== productId).map(toHit));
    },
    async batches(productId: string) {
      return batches.filter((b) => b.productId === productId && b.qtyOnHand > 0).map((b) => ({ ...b }));
    },
    async postSale(draft: SaleDraft): Promise<SaleResult> {
      const user = current;
      if (!user) throw new Error("سجّل الدخول أولاً");
      if (draft.lines.length === 0) throw new Error("الفاتورة فارغة");
      let needsRx = false;
      const lines = draft.lines.map((l) => {
        const p = products.find((x) => x.id === l.productId);
        if (!p) throw new Error("صنف غير موجود أو موقوف، حدّث السلة");
        if (l.unitPrice !== p.price) throw new Error(`سعر ${p.tradeName} أصبح ${p.price} د.ع، حدّث السلة`);
        const qty = l.allocations.reduce((s, a) => s + a.qty, 0);
        if (qty <= 0 || l.allocations.some((a) => a.qty <= 0)) throw new Error("كمية غير صالحة في أحد الأسطر");
        if (l.discount < 0 || l.discount > p.price * qty) throw new Error(`خصم غير صالح على ${p.tradeName}`);
        needsRx ||= p.rx;
        return { unitPrice: p.price, qty, discount: l.discount };
      });
      const totals = computeTotals(lines, 0);
      if (draft.invoiceDiscount < 0 || draft.invoiceDiscount > totals.total) throw new Error("خصم الفاتورة غير صالح");
      totals.invoiceDiscount = draft.invoiceDiscount;
      totals.total -= draft.invoiceDiscount;
      const discount = totals.lineDiscounts + totals.invoiceDiscount;
      if (!UNLIMITED_DISCOUNT_ROLES.includes(user.role) && discount * 100 > totals.subtotal * MAX_DISCOUNT_PCT) {
        throw new Error(`الخصم يتجاوز الحد المسموح (${MAX_DISCOUNT_PCT}٪ من المجموع)، يحتاج موافقة المدير`);
      }
      if (needsRx) {
        if (!RX_ROLES.includes(user.role)) throw new Error("الفاتورة تحتوي دواءً بوصفة طبية ويجب أن يصرفها صيدلاني");
        if (!draft.prescription?.rxNo.trim() || !draft.prescription.prescriber.trim()) {
          throw new Error("الفاتورة تحتوي دواءً بوصفة طبية: أدخل رقم الوصفة واسم الطبيب");
        }
      }
      const s = settle(totals.total, draft.payments);
      if (s.remaining > 0) throw new Error(`المبلغ المدفوع أقل من المطلوب بـ ${s.remaining} د.ع`);
      if (s.onCredit > 0 && !draft.patientId) throw new Error("البيع بالآجل يتطلب اختيار عميل");
      for (const l of draft.lines) {
        for (const a of l.allocations) {
          const b = batches.find((x) => x.id === a.batchId);
          if (!b || b.productId !== l.productId || b.qtyOnHand < a.qty) throw new Error(`الدفعة ${a.batchNo} لم تعد تكفي، حدّث السلة`);
        }
      }
      for (const l of draft.lines) for (const a of l.allocations) batches.find((x) => x.id === a.batchId)!.qtyOnHand -= a.qty;
      counter += 1;
      return {
        saleId: `demo-${counter}`,
        invoiceNo: `MB-${today.slice(0, 4)}-${String(counter).padStart(6, "0")}`,
        total: totals.total,
        paid: s.paid,
        change: s.change,
        createdAt: new Date().toISOString(),
      };
    },
    async inventory() {
      if (!current) throw new Error("سجّل الدخول أولاً");
      return products.map(toInventory).sort((a, b) => a.tradeName.localeCompare(b.tradeName));
    },
    async inventoryBatches(productId: string) {
      return batches
        .filter((b) => b.productId === productId && b.qtyOnHand > 0)
        .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.receivedAt.localeCompare(b.receivedAt))
        .map((b) => ({ ...b, status: "active" }));
    },
    async categories() {
      return categories;
    },
    async addProduct(input: NewProduct) {
      requireInventoryRole();
      const [name, form, strength] = [input.tradeName.trim(), input.dosageForm.trim(), input.strength.trim()];
      if (!name || !form || !strength) throw new Error("الاسم التجاري والشكل الدوائي والتركيز حقول مطلوبة");
      if (!(input.price > 0)) throw new Error("سعر البيع يجب أن يكون أكبر من صفر");
      if (!(input.packSize >= 1)) throw new Error("حجم العبوة يجب أن يكون ١ على الأقل");
      if (input.reorderLevel !== undefined && input.reorderLevel < 0) throw new Error("حد إعادة الطلب لا يكون سالباً");
      const barcode = input.barcode?.trim() || undefined;
      if (barcode) {
        if (!/^\d{8,14}$/.test(barcode)) throw new Error("الباركود يجب أن يكون من ٨ إلى ١٤ رقماً");
        const owner = products.find((p) => p.barcode === barcode);
        if (owner) throw new Error(`الباركود مسجّل مسبقاً للصنف ${owner.tradeName}`);
      }
      const categoryId = input.categoryId?.trim() || null;
      if (categoryId && !categories.some((c) => c.id === categoryId)) throw new Error("التصنيف غير موجود");
      const p: DemoProduct = {
        id: `p-demo-${Date.now()}`,
        tradeName: name,
        tradeNameAr: input.tradeNameAr?.trim() || undefined,
        categoryId,
        ingredients: [],
        strength,
        form,
        packSize: input.packSize,
        price: input.price,
        rx: input.requiresRx,
        key: "",
        barcode,
      };
      products.push(p);
      if (input.reorderLevel !== undefined) reorderLevels[p.id] = input.reorderLevel;
      return toInventory(p);
    },
    async receiveBatch(input: ReceiveBatchInput) {
      requireInventoryRole();
      const batchNo = input.batchNo.trim();
      if (!batchNo) throw new Error("رقم الدفعة مطلوب");
      if (!(input.qty > 0)) throw new Error("الكمية يجب أن تكون أكبر من صفر");
      if (input.unitCost < 0) throw new Error("سعر الشراء لا يكون سالباً");
      if (!isIsoDate(input.expiryDate)) throw new Error("تاريخ الانتهاء غير صالح");
      if (input.expiryDate <= today) throw new Error("لا يُستلم مخزون منتهي الصلاحية");
      const p = productById(input.productId);
      if (batches.some((b) => b.productId === p.id && b.batchNo === batchNo)) {
        throw new Error(`الدفعة ${batchNo} موجودة مسبقاً لهذا الصنف، عدّل كميتها بدلاً من ذلك`);
      }
      batches.push({
        id: `b-demo-${Date.now()}`,
        productId: p.id,
        batchNo,
        expiryDate: input.expiryDate,
        qtyOnHand: input.qty,
        unitCost: input.unitCost,
        sellPrice: p.price,
        receivedAt: new Date().toISOString(),
      });
      return toInventory(p);
    },
    async adjustBatch(input: AdjustBatchInput) {
      requireInventoryRole();
      if (!input.reason.trim()) throw new Error("سبب التعديل مطلوب");
      if (input.newQty < 0) throw new Error("الكمية لا تكون سالبة");
      const b = batches.find((x) => x.id === input.batchId);
      if (!b) throw new Error("الدفعة غير موجودة");
      if (input.newQty === b.qtyOnHand) throw new Error("الكمية الجديدة مساوية للحالية");
      b.qtyOnHand = input.newQty;
      return toInventory(productById(b.productId));
    },
    async suppliers() {
      if (!current) throw new Error("سجّل الدخول أولاً");
      return [...suppliers].sort((a, b) => a.name.localeCompare(b.name));
    },
    async addSupplier(input: NewSupplier) {
      requireInventoryRole();
      const name = input.name.trim();
      if (!name) throw new Error("اسم المورد مطلوب");
      const terms = input.paymentTermsDays ?? 30;
      if (!(terms >= 0 && terms <= 365)) throw new Error("مدة السداد بين ٠ و٣٦٥ يوماً");
      if (suppliers.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new Error(`المورد ${name} موجود مسبقاً`);
      const s: Supplier = { id: `s-demo-${Date.now()}`, name, phone: input.phone?.trim() || null, paymentTermsDays: terms, balance: 0 };
      suppliers.push(s);
      return s;
    },
    async postPurchaseInvoice(inv: PurchaseInvoice): Promise<PurchaseResult> {
      return postPurchase(inv);
    },
  };
}
