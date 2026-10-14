// In-memory store with the same demo data as src-tauri/migrations/demo_seed.sql.
// Used when the screens run in a normal browser (npm run dev) so they can be tried without the desktop app.

import { addDays, availableQty, sellableBatches } from "../core/fefo.ts";
import { computeTotals, settle } from "../core/totals.ts";
import type { Batch, ProductHit, Role, SaleDraft, SaleResult, SearchMode, User } from "../core/types.ts";
import { localToday, type PharmacyRepo } from "./repo.ts";

interface DemoProduct {
  id: string;
  tradeName: string;
  ingredients: { inn: string; ar: string; cls: string }[];
  strength: string;
  form: string;
  packSize: number;
  price: number;
  rx: boolean;
  key: string;
  barcode: string;
}

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
      const p = products.find((x) => codes.includes(x.barcode));
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
  };
}
