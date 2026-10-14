// In-memory store with the same demo data as src-tauri/migrations/demo_seed.sql.
// Used when the screens run in a normal browser (npm run dev) so they can be tried without the desktop app.

import { addDays, availableQty, daysBetween, sellableBatches } from "../core/fefo.ts";
import { computeTotals, settle } from "../core/totals.ts";
import { normalizeOverrides, resolvePermissions, ROLES, type Permission, type PermissionOverrides } from "../core/permissions.ts";
import {
  type AdjustBatchInput,
  type Batch,
  type Category,
  type ExpiryReport,
  type ExpiryRow,
  type InventoryItem,
  type NewProduct,
  type NewSupplier,
  type NewUser,
  type PurchaseInvoice,
  type PrescriberRow,
  type PurchaseResult,
  type Receipt,
  type ReceiptSettings,
  type RecentSale,
  type ProductHit,
  type ReceiveBatchInput,
  type ReorderRow,
  type ReportFilter,
  type Role,
  type RxReport,
  type RxRow,
  type SaleDraft,
  type SaleResult,
  type SalesReport,
  type SalesRow,
  type SearchMode,
  type Supplier,
  type User,
  type UserRow,
  type WriteOffRow,
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

const categoryOf = (p: DemoProduct) => (p.categoryId === undefined ? (p.rx ? "cat-rx" : "cat-otc") : p.categoryId);

// Same as reorder_rules in demo_seed.sql.
const reorderLevels: Record<string, number> = { "p-panadol-extra": 60, "p-amoxil-500": 25, "p-ventolin": 15 };
const maxLevels: Record<string, number> = { "p-panadol-extra": 200, "p-amoxil-500": 80, "p-ventolin": 50 };

// What the reports read: every sale and every stock write-off made in this session.
interface DemoSale {
  id: string;
  invoiceNo: string;
  cashierId: string;
  day: string;
  soldAt: string;
  invoiceDiscount: number;
  lines: { productId: string; qty: number; unitPrice: number; cost: number; discount: number; batches: string }[];
  prescription: { rxNo: string; prescriber: string; verifiedBy: string } | null;
  total: number;
  // What each method actually covered (card and credit first, then cash), and the change.
  payments: { method: "cash" | "card" | "credit"; amount: number }[];
  change: number;
}

// Same order as post_sale: card and credit are capped at what is owed, cash goes last and may give change.
function applyPayments(total: number, payments: { method: "cash" | "card" | "credit"; amount: number }[]) {
  let remaining = total;
  const applied: DemoSale["payments"] = [];
  const ordered = payments.filter((p) => p.amount > 0).sort((a, b) => Number(a.method === "cash") - Number(b.method === "cash"));
  for (const p of ordered) {
    const take = Math.min(p.amount, remaining);
    remaining -= take;
    if (take > 0) applied.push({ method: p.method, amount: take });
  }
  return applied;
}

interface DemoWriteOff {
  day: string;
  productId: string;
  batchNo: string;
  qty: number;
  unitCost: number;
  reason: string;
  userId: string;
}

// Same defaults as migrations/0004_receipt_settings.sql.
const receiptSettings: ReceiptSettings = {
  name: "نظام الصيدلية",
  address: "",
  phone: "",
  footer: "شكراً لزيارتكم · الأدوية لا تُرد بعد فتح العبوة",
  paper: "80",
};

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

// Demo accounts, one per role that sells. All start with DEMO_PASSWORD; the login screen shows it in demo mode.
export const DEMO_PASSWORD = "demo1234";

interface DemoUser {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  active: boolean;
  password: string; // demo only: kept in memory as typed, never persisted
  overrides: PermissionOverrides;
  lastLogin: string | null;
}

const demoUser = (id: string, username: string, fullName: string, role: Role): DemoUser => ({
  id, username, fullName, role, active: true, password: DEMO_PASSWORD, overrides: {}, lastLogin: null,
});

const users: DemoUser[] = [
  demoUser("u-admin", "admin", "مدير النظام", "admin"),
  demoUser("u-pharm", "pharm", "الصيدلاني", "pharmacist"),
  demoUser("u-cash", "cash", "الكاشير", "cashier"),
];

const toUser = (u: DemoUser): User => ({
  id: u.id, username: u.username, fullName: u.fullName, role: u.role, permissions: resolvePermissions(u.role, u.overrides),
});

const toRow = (u: DemoUser): UserRow => ({
  ...toUser(u), active: u.active, hasPassword: true, lastLogin: u.lastLogin, overrides: { ...u.overrides },
});

const DENIED: Record<Permission, string> = {
  giveDiscount: "ليست لديك صلاحية لإعطاء خصم",
  dispenseRx: "الفاتورة تحتوي دواءً بوصفة طبية ويجب أن يصرفها صيدلاني",
  viewReports: "ليست لديك صلاحية لعرض هذا التقرير",
  modifyInventory: "ليست لديك صلاحية لتعديل المخزون",
};

// Same rules as post_sale in src-tauri/src/lib.rs.
const MAX_DISCOUNT_PCT = 10;
const UNLIMITED_DISCOUNT_ROLES: Role[] = ["admin", "chief_pharmacist"];

export function createDemoRepo(): PharmacyRepo {
  const today = localToday();
  const batches = seedBatches(today);
  let counter = 0;
  let currentId: string | null = null;
  // Looked up on every call, so a deactivated account stops working at once (as in the desktop app).
  const signedIn = () => users.find((u) => u.id === currentId && u.active) ?? null;
  const postedInvoices = new Set<string>(); // supplierId|invoiceNo
  const sales: DemoSale[] = [];
  const writeOffs: DemoWriteOff[] = [];

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
    const categoryId = categoryOf(p);
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

  // Same checks as require_permission / require_admin in src-tauri/src/lib.rs: any one of `perms` is enough.
  const requirePermission = (...perms: Permission[]) => {
    const u = signedIn();
    if (!u) throw new Error("الحساب غير موجود أو معطّل، سجّل الدخول من جديد");
    const p = resolvePermissions(u.role, u.overrides);
    if (!perms.some((x) => p[x])) throw new Error(DENIED[perms[0]]);
    return u;
  };
  const requireAdmin = () => {
    const u = signedIn();
    if (!u) throw new Error("الحساب غير موجود أو معطّل، سجّل الدخول من جديد");
    if (u.role !== "admin") throw new Error("إدارة الموظفين للمدير فقط");
    return u;
  };
  const otherActiveAdmins = (except: string) => users.filter((u) => u.role === "admin" && u.active && u.id !== except).length;
  const userById = (id: string) => {
    const u = users.find((x) => x.id === id);
    if (!u) throw new Error("الموظف غير موجود");
    return u;
  };
  const checkPassword = (pw: string) => {
    if ([...pw].length < 8) throw new Error("كلمة المرور يجب ألا تقل عن 8 أحرف");
  };
  const checkRole = (role: string) => {
    if (!ROLES.some((r) => r.id === role)) throw new Error("الدور غير معروف");
  };
  const checkRange = (f: ReportFilter) => {
    if (!isIsoDate(f.from) || !isIsoDate(f.to)) throw new Error("تاريخ البداية أو النهاية غير صالح");
    if (f.from > f.to) throw new Error("تاريخ البداية بعد تاريخ النهاية");
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
    requirePermission("modifyInventory");
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
      const u = signedIn();
      return { needsSetup: false, user: u ? toUser(u) : null };
    },
    async setupAdmin() {
      throw new Error("تم إعداد كلمة المرور مسبقاً، سجّل الدخول");
    },
    async login(username: string, password: string) {
      const u = users.find((x) => x.username === username.trim().toLowerCase() && x.active);
      if (!u || password !== u.password) throw new Error("اسم المستخدم أو كلمة المرور غير صحيحة");
      currentId = u.id;
      u.lastLogin = new Date().toLocaleString("sv-SE").slice(0, 19);
      return toUser(u);
    },
    async logout() {
      currentId = null;
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
      const user = signedIn();
      if (!user) throw new Error("الحساب غير موجود أو معطّل، سجّل الدخول من جديد");
      const perms = resolvePermissions(user.role, user.overrides);
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
      if (discount > 0 && !perms.giveDiscount) throw new Error(DENIED.giveDiscount);
      if (!UNLIMITED_DISCOUNT_ROLES.includes(user.role) && discount * 100 > totals.subtotal * MAX_DISCOUNT_PCT) {
        throw new Error(`الخصم يتجاوز الحد المسموح (${MAX_DISCOUNT_PCT}٪ من المجموع)، يحتاج موافقة المدير`);
      }
      if (needsRx) {
        if (!perms.dispenseRx) throw new Error(DENIED.dispenseRx);
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
      const costOf = (l: SaleDraft["lines"][number]) =>
        l.allocations.reduce((sum, a) => sum + a.qty * batches.find((x) => x.id === a.batchId)!.unitCost, 0);
      counter += 1;
      sales.push({
        id: `demo-${counter}`,
        invoiceNo: `MB-${today.slice(0, 4)}-${String(counter).padStart(6, "0")}`,
        cashierId: user.id,
        day: today,
        soldAt: new Date().toISOString(),
        invoiceDiscount: draft.invoiceDiscount,
        lines: draft.lines.map((l) => ({
          productId: l.productId,
          qty: l.allocations.reduce((sum, a) => sum + a.qty, 0),
          unitPrice: l.unitPrice,
          cost: costOf(l),
          discount: l.discount,
          batches: l.allocations.map((a) => a.batchNo).join("، "),
        })),
        prescription: needsRx ? { ...draft.prescription!, verifiedBy: user.id } : null,
        total: totals.total,
        payments: applyPayments(totals.total, draft.payments),
        change: s.change,
      });
      for (const l of draft.lines) for (const a of l.allocations) batches.find((x) => x.id === a.batchId)!.qtyOnHand -= a.qty;
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
      if (!signedIn()) throw new Error("سجّل الدخول أولاً");
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
      requirePermission("modifyInventory");
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
      requirePermission("modifyInventory");
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
      requirePermission("modifyInventory");
      if (!input.reason.trim()) throw new Error("سبب التعديل مطلوب");
      if (input.newQty < 0) throw new Error("الكمية لا تكون سالبة");
      const b = batches.find((x) => x.id === input.batchId);
      if (!b) throw new Error("الدفعة غير موجودة");
      if (input.newQty === b.qtyOnHand) throw new Error("الكمية الجديدة مساوية للحالية");
      if (input.newQty < b.qtyOnHand) {
        writeOffs.push({
          day: today,
          productId: b.productId,
          batchNo: b.batchNo,
          qty: b.qtyOnHand - input.newQty,
          unitCost: b.unitCost,
          reason: input.reason.trim(),
          userId: signedIn()!.id,
        });
      }
      b.qtyOnHand = input.newQty;
      return toInventory(productById(b.productId));
    },
    async suppliers() {
      if (!signedIn()) throw new Error("سجّل الدخول أولاً");
      return [...suppliers].sort((a, b) => a.name.localeCompare(b.name));
    },
    async addSupplier(input: NewSupplier) {
      requirePermission("modifyInventory");
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

    // Reports: same definitions as the report_* commands in src-tauri/src/lib.rs.
    async reportUsers() {
      requirePermission("viewReports");
      return users.map((u) => ({ id: u.id, fullName: u.fullName })).sort((a, b) => a.fullName.localeCompare(b.fullName));
    },
    async reportSales(f: ReportFilter): Promise<SalesReport> {
      requirePermission("viewReports");
      checkRange(f);
      // One row per sale line; the invoice discount is shared over the sale's lines by value.
      const items = sales
        .filter((s) => s.day >= f.from && s.day <= f.to && (!f.cashierId || s.cashierId === f.cashierId))
        .flatMap((s) => {
          const linesTotal = s.lines.reduce((sum, l) => sum + l.qty * l.unitPrice - l.discount, 0);
          return s.lines
            .filter((l) => !f.categoryId || categoryOf(productById(l.productId)) === f.categoryId)
            .map((l) => {
              const lineTotal = l.qty * l.unitPrice - l.discount;
              const disc = l.discount + (linesTotal > 0 ? (s.invoiceDiscount * lineTotal) / linesTotal : 0);
              const gross = l.qty * l.unitPrice;
              return { sale: s, productId: l.productId, qty: l.qty, gross, disc, cost: l.cost };
            });
        });
      type Item = (typeof items)[number];
      const group = (keyOf: (i: Item) => string, labelOf: (i: Item) => string): SalesRow[] => {
        const map = new Map<string, SalesRow & { sales: Set<string>; d: number; n: number; p: number }>();
        for (const i of items) {
          const key = keyOf(i);
          const row = map.get(key) ?? { key, label: labelOf(i), invoices: 0, units: 0, discounts: 0, net: 0, profit: 0, sales: new Set(), d: 0, n: 0, p: 0 };
          row.sales.add(i.sale.id);
          row.units += i.qty;
          row.d += i.disc;
          row.n += i.gross - i.disc;
          row.p += i.gross - i.disc - i.cost;
          map.set(key, row);
        }
        return [...map.values()].map(({ sales: s, d, n, p, ...row }) => ({
          ...row,
          invoices: s.size,
          discounts: Math.round(d),
          net: Math.round(n),
          profit: Math.round(p),
        }));
      };
      const gross = items.reduce((s, i) => s + i.gross, 0);
      const discounts = Math.round(items.reduce((s, i) => s + i.disc, 0));
      const cost = items.reduce((s, i) => s + i.cost, 0);
      return {
        totals: {
          invoices: new Set(items.map((i) => i.sale.id)).size,
          units: items.reduce((s, i) => s + i.qty, 0),
          gross,
          discounts,
          net: gross - discounts,
          cost,
          profit: gross - discounts - cost,
        },
        byCashier: group((i) => i.sale.cashierId, (i) => users.find((u) => u.id === i.sale.cashierId)?.fullName ?? "—").sort((a, b) => b.net - a.net),
        byDay: group((i) => i.sale.day, (i) => i.sale.day).sort((a, b) => a.key.localeCompare(b.key)),
        topProducts: group((i) => i.productId, (i) => productById(i.productId).tradeName).sort((a, b) => b.net - a.net).slice(0, 20),
      };
    },
    async reportExpiry(f: ReportFilter, withinDays: number): Promise<ExpiryReport> {
      requirePermission("modifyInventory", "viewReports");
      checkRange(f);
      if (!(withinDays >= 0 && withinDays <= 730)) throw new Error("مدة التنبيه بين ٠ و٧٣٠ يوماً");
      const horizon = addDays(today, withinDays);
      const rows: ExpiryRow[] = batches
        .filter((b) => b.qtyOnHand > 0 && b.expiryDate <= horizon)
        .filter((b) => !f.categoryId || categoryOf(productById(b.productId)) === f.categoryId)
        .map((b) => {
          const p = productById(b.productId);
          return {
            batchId: b.id,
            product: p.tradeName,
            category: categories.find((c) => c.id === categoryOf(p))?.nameAr ?? null,
            batchNo: b.batchNo,
            expiryDate: b.expiryDate,
            daysLeft: daysBetween(today, b.expiryDate),
            qty: b.qtyOnHand,
            unitCost: b.unitCost,
            value: b.qtyOnHand * b.unitCost,
          };
        })
        .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.product.localeCompare(b.product));
      const offs: WriteOffRow[] = writeOffs
        .filter((w) => w.day >= f.from && w.day <= f.to)
        .filter((w) => !f.categoryId || categoryOf(productById(w.productId)) === f.categoryId)
        .map((w) => ({
          day: w.day,
          product: productById(w.productId).tradeName,
          batchNo: w.batchNo,
          qty: w.qty,
          value: w.qty * w.unitCost,
          reason: w.reason,
          user: users.find((u) => u.id === w.userId)?.fullName ?? null,
        }))
        .reverse();
      const expired = rows.filter((r) => r.daysLeft <= 0);
      const near = rows.filter((r) => r.daysLeft > 0);
      const sum = (rs: { qty: number; value: number }[], k: "qty" | "value") => rs.reduce((s, r) => s + r[k], 0);
      return {
        expiredQty: sum(expired, "qty"),
        expiredValue: sum(expired, "value"),
        nearQty: sum(near, "qty"),
        nearValue: sum(near, "value"),
        batches: rows,
        writeOffs: offs,
        writtenOffValue: sum(offs, "value"),
      };
    },
    async reportReorder(categoryId?: string): Promise<ReorderRow[]> {
      requirePermission("modifyInventory", "viewReports");
      const monthAgo = addDays(today, -30);
      return products
        .filter((p) => !categoryId || categoryOf(p) === categoryId)
        .map((p) => {
          const inv = toInventory(p);
          const sold = sales
            .filter((s) => s.day > monthAgo)
            .flatMap((s) => s.lines)
            .filter((l) => l.productId === p.id)
            .reduce((s, l) => s + l.qty, 0);
          const maxQty = maxLevels[p.id] ?? 0;
          const level = reorderLevels[p.id] ?? null;
          const target = maxQty > 0 ? maxQty : level && level > 0 ? level * 2 : Math.max(sold, 1);
          const latest = batches.filter((b) => b.productId === p.id).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
          return {
            productId: p.id,
            product: p.tradeName,
            barcode: p.barcode ?? null,
            category: inv.category,
            stock: inv.stock,
            reorderLevel: level,
            sold30d: sold,
            daysOfCover: sold > 0 ? Math.floor((inv.stock * 30) / sold) : null,
            suggestedQty: Math.max(target - inv.stock, 0),
            supplier: level !== null ? suppliers.find((s) => s.id === "s-a")?.name ?? null : null,
            lastCost: latest?.unitCost ?? null,
          };
        })
        .filter((r) => r.stock === 0 || (r.reorderLevel !== null && r.stock <= r.reorderLevel))
        .sort(
          (a, b) =>
            Number(a.stock > 0) - Number(b.stock > 0) ||
            (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity) ||
            a.stock - b.stock,
        );
    },
    async reportPrescriptions(f: ReportFilter): Promise<RxReport> {
      requirePermission("viewReports");
      checkRange(f);
      const rows: RxRow[] = sales
        .filter((s) => s.prescription && s.day >= f.from && s.day <= f.to && (!f.cashierId || s.cashierId === f.cashierId))
        .filter((s) => !f.categoryId || s.lines.some((l) => categoryOf(productById(l.productId)) === f.categoryId))
        .map((s) => {
          const rxLines = s.lines.filter((l) => productById(l.productId).rx);
          return {
            saleId: s.id,
            invoiceNo: s.invoiceNo,
            soldAt: `${s.day} ${new Date(s.soldAt).toTimeString().slice(0, 8)}`,
            rxNo: s.prescription!.rxNo,
            prescriber: s.prescription!.prescriber,
            pharmacist: users.find((u) => u.id === s.prescription!.verifiedBy)?.fullName ?? null,
            items: rxLines.map((l) => `${productById(l.productId).tradeName} ×${l.qty}`).join("، "),
            rxTotal: rxLines.reduce((sum, l) => sum + l.qty * l.unitPrice - l.discount, 0),
          };
        })
        .reverse();
      const byDoc = new Map<string, PrescriberRow>();
      for (const s of sales.filter((x) => rows.some((r) => r.saleId === x.id))) {
        const name = s.prescription!.prescriber;
        const row = byDoc.get(name.toLowerCase()) ?? { prescriber: name, prescriptions: 0, units: 0 };
        row.prescriptions += 1;
        row.units += s.lines.filter((l) => productById(l.productId).rx).reduce((sum, l) => sum + l.qty, 0);
        byDoc.set(name.toLowerCase(), row);
      }
      return {
        rows,
        byPrescriber: [...byDoc.values()].sort((a, b) => b.prescriptions - a.prescriptions || a.prescriber.localeCompare(b.prescriber)),
      };
    },
    async saveExport(fileName: string, content: string) {
      // A browser can only offer the file as a download.
      const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return `مجلد التنزيلات (${fileName})`;
    },

    // Employees: same rules as the user commands in src-tauri/src/lib.rs.
    async listUsers() {
      requireAdmin();
      return [...users]
        .sort((a, b) => Number(b.active) - Number(a.active) || a.fullName.localeCompare(b.fullName))
        .map(toRow);
    },
    async createUser(input: NewUser) {
      requireAdmin();
      const username = input.username.trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error("اسم المستخدم من ٣ إلى ٣٢ حرفاً لاتينياً صغيراً أو رقماً أو . _ -");
      const fullName = input.fullName.trim();
      if (!fullName || [...fullName].length > 80) throw new Error("الاسم الكامل مطلوب (حتى ٨٠ حرفاً)");
      checkRole(input.role);
      checkPassword(input.password);
      if (users.some((u) => u.username === username)) throw new Error(`اسم المستخدم ${username} مستخدم مسبقاً`);
      const u: DemoUser = {
        ...demoUser(`u-demo-${Date.now()}`, username, fullName, input.role),
        password: input.password,
        overrides: normalizeOverrides(input.role, input.overrides ?? {}),
      };
      users.push(u);
      return toRow(u);
    },
    async updateUserRole(userId: string, role: Role, overrides: PermissionOverrides) {
      const me = requireAdmin();
      checkRole(role);
      const u = userById(userId);
      if (u.role === "admin" && role !== "admin") {
        if (u.id === me.id) throw new Error("لا يمكنك إزالة صلاحية المدير عن حسابك");
        if (u.active && otherActiveAdmins(u.id) === 0) throw new Error("يجب أن يبقى مدير واحد نشط على الأقل");
      }
      u.role = role;
      u.overrides = normalizeOverrides(role, overrides);
      return toRow(u);
    },
    async toggleUserStatus(userId: string, active: boolean) {
      const me = requireAdmin();
      const u = userById(userId);
      if (!active) {
        if (u.id === me.id) throw new Error("لا يمكنك تعطيل حسابك");
        if (u.role === "admin" && otherActiveAdmins(u.id) === 0) throw new Error("يجب أن يبقى مدير واحد نشط على الأقل");
      }
      u.active = active;
      return toRow(u);
    },
    async resetUserPassword(userId: string, password: string) {
      requireAdmin();
      checkPassword(password);
      const u = userById(userId);
      u.password = password;
      return toRow(u);
    },

    // No scanner server in a browser tab.
    async phoneScanner() {
      return null;
    },
    async onPhoneScan() {
      return () => {};
    },

    // Receipts: same rules as the receipt commands in src-tauri/src/lib.rs.
    async receiptSettings() {
      if (!signedIn()) throw new Error("سجّل الدخول أولاً");
      return { ...receiptSettings };
    },
    async saveReceiptSettings(s: ReceiptSettings) {
      requireAdmin();
      const next = { name: s.name.trim(), address: s.address.trim(), phone: s.phone.trim(), footer: s.footer.trim(), paper: s.paper };
      if (!next.name) throw new Error("اسم الصيدلية مطلوب");
      if ([...next.name].length > 60 || [...next.address].length > 120 || [...next.phone].length > 40 || [...next.footer].length > 200) {
        throw new Error("نص طويل جداً لعرض الإيصال");
      }
      if (!["80", "58", "a4"].includes(next.paper)) throw new Error("مقاس الورق غير معروف");
      Object.assign(receiptSettings, next);
      return { ...receiptSettings };
    },
    async saleReceipt(saleId: string, reprint: boolean): Promise<Receipt> {
      const me = signedIn();
      if (!me) throw new Error("سجّل الدخول أولاً");
      const s = sales.find((x) => x.id === saleId);
      if (!s) throw new Error("الفاتورة غير موجودة");
      if (s.cashierId !== me.id && !resolvePermissions(me.role, me.overrides).viewReports) {
        throw new Error("لا يمكنك طباعة فاتورة كاشير آخر");
      }
      const subtotal = s.lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
      const cash = s.payments.filter((p) => p.method === "cash").reduce((sum, p) => sum + p.amount, 0);
      return {
        saleId: s.id,
        invoiceNo: s.invoiceNo,
        soldAt: new Date(s.soldAt).toLocaleString("sv-SE").slice(0, 16),
        cashier: users.find((u) => u.id === s.cashierId)?.fullName ?? null,
        lines: s.lines.map((l) => ({
          name: productById(l.productId).tradeName,
          qty: l.qty,
          unitPrice: l.unitPrice,
          discount: l.discount,
          total: l.qty * l.unitPrice - l.discount,
          batches: l.batches,
        })),
        subtotal,
        discount: subtotal - s.total,
        total: s.total,
        payments: s.payments,
        cashTendered: cash > 0 || s.change > 0 ? cash + s.change : 0,
        change: s.change,
        prescription: s.prescription
          ? {
              rxNo: s.prescription.rxNo,
              prescriber: s.prescription.prescriber,
              pharmacist: users.find((u) => u.id === s.prescription!.verifiedBy)?.fullName ?? null,
            }
          : null,
        copy: reprint,
        settings: { ...receiptSettings },
      };
    },
    async recentSales(): Promise<RecentSale[]> {
      const me = signedIn();
      if (!me) throw new Error("سجّل الدخول أولاً");
      const all = resolvePermissions(me.role, me.overrides).viewReports;
      return sales
        .filter((s) => s.day === today && (all || s.cashierId === me.id))
        .map((s) => ({
          saleId: s.id,
          invoiceNo: s.invoiceNo,
          time: new Date(s.soldAt).toTimeString().slice(0, 5),
          cashier: users.find((u) => u.id === s.cashierId)?.fullName ?? null,
          items: s.lines.reduce((sum, l) => sum + l.qty, 0),
          total: s.total,
        }))
        .reverse();
    },
  };
}
