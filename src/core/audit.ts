// How audit log entries read on screen: an Arabic name per action, a one-line summary, and the before/after rows of
// the detail view. The payload shapes are the ones written next to each append_audit call in src-tauri/src/lib.rs;
// changes are stored as { from: {...}, to: {...} } (older entries may hold plain numbers in from/to).

import { PERMISSIONS, ROLE_LABEL } from "./permissions.ts";
import { formatIqd } from "./totals.ts";
import type { AuditCategory, Role } from "./types.ts";

/** Quick filters of the audit screen, in the order shown. */
export const AUDIT_CATEGORIES: { id: AuditCategory; label: string }[] = [
  { id: "inventory", label: "تعديلات المخزون" },
  { id: "users", label: "إدارة المستخدمين" },
  { id: "prices", label: "تغيير الأسعار" },
  { id: "login", label: "تسجيل الدخول" },
  { id: "sales", label: "المبيعات" },
  { id: "settings", label: "الإعدادات" },
];

export const AUDIT_ACTIONS: Record<string, string> = {
  "user.setup": "إعداد حساب المدير",
  "user.login": "تسجيل دخول",
  "user.create": "إضافة موظف",
  "user.role": "تغيير الدور والصلاحيات",
  "user.status": "تفعيل/تعطيل حساب",
  "user.password_reset": "إعادة تعيين كلمة المرور",
  "sale.create": "بيع",
  "receipt.reprint": "إعادة طباعة إيصال",
  "product.create": "إضافة صنف",
  "product.update": "تعديل بيانات صنف",
  "product.price": "تغيير سعر البيع",
  "batch.receive": "استلام دفعة",
  "batch.adjust": "تصحيح جرد",
  "purchase.post": "ترحيل فاتورة شراء",
  "supplier.create": "إضافة مورد",
  "settings.sales": "إعدادات البيع",
  "settings.receipt": "إعدادات الإيصال",
};

export const auditActionLabel = (action: string) => AUDIT_ACTIONS[action] ?? action;

// ── Fields ──

const FIELDS: Record<string, string> = {
  tradeName: "الاسم التجاري",
  tradeNameAr: "الاسم بالعربية",
  category: "التصنيف",
  dosageForm: "الشكل الدوائي",
  strength: "التركيز",
  packSize: "حجم العبوة",
  requiresRx: "بوصفة طبية",
  price: "سعر البيع",
  barcode: "الباركود",
  reorderLevel: "حد إعادة الطلب",
  qty: "الكمية",
  unitCost: "تكلفة الوحدة",
  active: "الحساب",
  role: "الدور",
  overrides: "الصلاحيات الخاصة",
  maxDiscountPct: "حد الخصم",
  name: "الاسم",
  address: "العنوان",
  phone: "الهاتف",
  footer: "التذييل",
  paper: "الورق",
  // Details stored next to the change.
  reason: "السبب",
  source: "المصدر",
  invoiceNo: "رقم الفاتورة",
  batchNo: "الدفعة",
  expiryDate: "تاريخ الانتهاء",
  username: "اسم المستخدم",
  fullName: "الاسم الكامل",
  total: "القيمة",
  discount: "الخصم",
  lines: "عدد الأسطر",
  payment: "الدفع",
  rxNo: "رقم الوصفة",
};

export const fieldLabel = (key: string) => FIELDS[key] ?? key;

const MONEY = new Set(["price", "unitCost", "total", "discount"]);
const PERMISSION_LABEL: Record<string, string> = Object.fromEntries(PERMISSIONS.map((p) => [p.id, p.label]));

/** A stored value as it reads on screen; "—" for nothing. */
export function formatValue(key: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (MONEY.has(key) && typeof v === "number") return `${formatIqd(v)} د.ع`;
  switch (key) {
    case "requiresRx":
      return v ? "نعم" : "لا";
    case "active":
      return v ? "مفعّل" : "معطّل";
    case "role":
      return ROLE_LABEL[v as Role] ?? String(v);
    case "maxDiscountPct":
      return `${v}٪`;
    case "paper":
      return v === "a4" ? "A4" : `${v} مم`;
    case "source":
      return v === "manual" ? "تعديل يدوي" : v === "purchase" ? "فاتورة شراء" : String(v);
    case "payment":
      return v === "credit" ? "آجل" : v === "cash" ? "نقداً" : String(v);
    case "overrides": {
      // Unset overrides are stored as null: the role decides.
      const entries = Object.entries(v as Record<string, boolean | null>).filter(([, on]) => typeof on === "boolean");
      return entries.length ? entries.map(([p, on]) => `${PERMISSION_LABEL[p] ?? p}: ${on ? "مسموح" : "ممنوع"}`).join("، ") : "حسب الدور";
    }
  }
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

// ── Payload ──

type Payload = Record<string, any>;

function parse(payload: string): Payload | null {
  try {
    const p = JSON.parse(payload);
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Old entries keep a single number in from/to; this is the field it stands for. */
const SCALAR_FIELD: Record<string, string> = { "product.price": "price", "batch.adjust": "qty" };

export interface AuditChange {
  key: string;
  label: string;
  before: string;
  after: string;
}

/** Fields the entry changed, old value against new. A creation (no "from") lists its values with "—" before. */
export function auditChanges(action: string, payload: string): AuditChange[] {
  const p = parse(payload);
  if (!p || !("to" in p)) return [];
  const { from, to } = p;
  if (!isObject(to) && !isObject(from)) {
    const key = SCALAR_FIELD[action] ?? "value";
    return [{ key, label: fieldLabel(key), before: formatValue(key, from), after: formatValue(key, to) }];
  }
  const before = isObject(from) ? from : {};
  const after = isObject(to) ? to : {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys
    .filter((k) => !isObject(from) || JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => ({ key: k, label: fieldLabel(k), before: formatValue(k, before[k]), after: formatValue(k, after[k]) }));
}

/** The rest of the payload (reason, invoice number…), without ids and the change itself. */
export function auditDetails(payload: string): { label: string; value: string }[] {
  const p = parse(payload);
  if (!p) return payload.trim() && payload !== "{}" ? [{ label: "البيانات", value: payload }] : [];
  return Object.entries(p)
    .filter(([k, v]) => k !== "from" && k !== "to" && !k.endsWith("Id") && v !== null && v !== "")
    .map(([k, v]) => ({ label: fieldLabel(k), value: formatValue(k, v) }));
}

const iqd = (n: unknown) => formatValue("price", Number(n) || 0);
const role = (r: unknown) => formatValue("role", r ?? "—");

/** One line describing what the entry changed. */
export function auditSummary(action: string, payload: string): string {
  const p = parse(payload);
  if (!p) return payload;
  const changes = () => auditChanges(action, payload);
  const parts: string[] = [];
  switch (action) {
    case "sale.create":
      parts.push(`فاتورة ${p.invoiceNo} بقيمة ${iqd(p.total)}`, `${p.lines} صنف`);
      if (p.discount > 0) parts.push(`خصم ${iqd(p.discount)}`);
      if (p.rxNo) parts.push(`وصفة ${p.rxNo}`);
      break;
    case "receipt.reprint":
      parts.push(`نسخة من الفاتورة ${p.invoiceNo}`);
      break;
    case "product.create":
      parts.push(`${p.tradeName} بسعر ${iqd(p.price)}`);
      if (p.barcode) parts.push(`باركود ${p.barcode}`);
      break;
    case "product.update":
      parts.push(`تعديل ${changes().map((c) => c.label).join("، ")}`);
      break;
    case "product.price":
      parts.push(`من ${iqd(p.from)} إلى ${iqd(p.to)}`);
      parts.push(p.source === "manual" ? "تعديل يدوي" : p.invoiceNo ? `فاتورة الشراء ${p.invoiceNo}` : "عند ترحيل فاتورة شراء");
      break;
    case "batch.receive": {
      parts.push(`${p.qty} وحدة`, `الدفعة ${p.batchNo}`);
      if (isObject(p.from) && isObject(p.to)) {
        parts.push(`الكمية من ${p.from.qty} إلى ${p.to.qty}`);
        if (p.from.unitCost !== p.to.unitCost) parts.push(`التكلفة من ${iqd(p.from.unitCost)} إلى ${iqd(p.to.unitCost)}`);
      }
      if (p.invoiceNo) parts.push(`فاتورة الشراء ${p.invoiceNo}`);
      break;
    }
    case "batch.adjust": {
      const [from, to] = isObject(p.from) ? [p.from.qty, p.to?.qty] : [p.from, p.to];
      parts.push(`الكمية من ${from} إلى ${to}`);
      if (p.reason) parts.push(`السبب: ${p.reason}`);
      break;
    }
    case "purchase.post":
      parts.push(`فاتورة المورد ${p.invoiceNo} بقيمة ${iqd(p.total)}`, `${p.lines} سطر`, p.payment === "credit" ? "آجل" : "نقداً");
      break;
    case "supplier.create":
      parts.push(String(p.name ?? ""));
      break;
    case "user.create":
      parts.push(`${p.fullName} (${p.username})`, `الدور: ${role(p.role)}`);
      break;
    case "user.role": {
      const from = p.from ?? {};
      const to = p.to ?? {};
      parts.push(from.role === to.role ? `الدور: ${role(to.role)}` : `الدور من ${role(from.role)} إلى ${role(to.role)}`);
      if (JSON.stringify(from.overrides ?? {}) !== JSON.stringify(to.overrides ?? {})) parts.push("تعديل الصلاحيات الخاصة");
      break;
    }
    case "user.status":
      parts.push((isObject(p.to) ? p.to.active : p.active) ? "تفعيل الحساب" : "تعطيل الحساب");
      break;
    case "settings.sales":
      parts.push(`حد الخصم من ${formatValue("maxDiscountPct", p.from?.maxDiscountPct)} إلى ${formatValue("maxDiscountPct", p.to?.maxDiscountPct)}`);
      break;
    case "settings.receipt": {
      const changed = changes();
      parts.push(changed.length ? `تغيير ${changed.map((c) => c.label).join("، ")}` : "بدون تغيير");
      break;
    }
    default:
      if (Object.keys(p).length) parts.push(payload);
  }
  return parts.join(" · ");
}
