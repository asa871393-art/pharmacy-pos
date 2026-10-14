// How audit log entries read on screen: an Arabic name per action and a one-line summary of the JSON stored with it.
// The payload shapes are the ones written next to each append_audit call in src-tauri/src/lib.rs.

import { ROLE_LABEL } from "./permissions.ts";
import { formatIqd } from "./totals.ts";
import type { Role } from "./types.ts";

/** Filter groups: an action belongs to the group before its dot ("sale.create" → "sale"). */
export const AUDIT_GROUPS: { id: string; label: string }[] = [
  { id: "user", label: "الموظفون وتسجيل الدخول" },
  { id: "sale", label: "المبيعات" },
  { id: "receipt", label: "إعادة طباعة الإيصالات" },
  { id: "product", label: "الأصناف والأسعار" },
  { id: "batch", label: "الدفعات والجرد" },
  { id: "purchase", label: "فواتير الشراء" },
  { id: "supplier", label: "الموردون" },
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
  "product.price": "تغيير سعر البيع",
  "batch.receive": "استلام دفعة",
  "batch.adjust": "تصحيح جرد",
  "purchase.post": "ترحيل فاتورة شراء",
  "supplier.create": "إضافة مورد",
  "settings.receipt": "إعدادات الإيصال",
};

export const auditActionLabel = (action: string) => AUDIT_ACTIONS[action] ?? action;

const iqd = (n: unknown) => `${formatIqd(Number(n) || 0)} د.ع`;
const role = (r: unknown) => ROLE_LABEL[r as Role] ?? String(r ?? "—");

const RECEIPT_FIELDS: Record<string, string> = { name: "الاسم", address: "العنوان", phone: "الهاتف", footer: "التذييل", paper: "الورق" };

/** One line describing what the entry changed. */
export function auditSummary(action: string, payload: string): string {
  let p: Record<string, any>;
  try {
    p = JSON.parse(payload) ?? {};
  } catch {
    return payload;
  }
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
    case "product.price":
      parts.push(`من ${iqd(p.from)} إلى ${iqd(p.to)}`, "عند ترحيل فاتورة شراء");
      break;
    case "batch.receive":
      parts.push(`${p.qty} وحدة`, `الدفعة ${p.batchNo}`);
      break;
    case "batch.adjust":
      parts.push(`الكمية من ${p.from} إلى ${p.to}`);
      if (p.reason) parts.push(`السبب: ${p.reason}`);
      break;
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
      parts.push(p.active ? "تفعيل الحساب" : "تعطيل الحساب");
      break;
    case "settings.receipt": {
      const changed = Object.keys(RECEIPT_FIELDS).filter((k) => p.from?.[k] !== p.to?.[k]);
      parts.push(changed.length ? `تغيير ${changed.map((k) => RECEIPT_FIELDS[k]).join("، ")}` : "بدون تغيير");
      break;
    }
    default:
      if (Object.keys(p).length) parts.push(payload);
  }
  return parts.join(" · ");
}
