// Roles and permissions. Same table as role_default in src-tauri/src/lib.rs, which enforces it;
// the screens use it only to show or hide controls.

import type { Role } from "./types.ts";

export const ROLES: { id: Role; label: string }[] = [
  { id: "admin", label: "مدير" },
  { id: "chief_pharmacist", label: "صيدلاني مسؤول" },
  { id: "pharmacist", label: "صيدلاني" },
  { id: "cashier", label: "كاشير" },
  { id: "storekeeper", label: "أمين مخزن" },
];

export const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.id, r.label])) as Record<Role, string>;

export type Permission = "giveDiscount" | "dispenseRx" | "viewReports" | "modifyInventory";

export type Permissions = Record<Permission, boolean>;

/** Per-user exceptions: true grants, false denies, null/undefined follows the role. */
export type PermissionOverrides = Partial<Record<Permission, boolean | null>>;

export const PERMISSIONS: { id: Permission; label: string; hint: string }[] = [
  { id: "giveDiscount", label: "إعطاء خصم", hint: "ضمن الحد الأقصى للخصم، إلا للمدير والصيدلاني المسؤول" },
  { id: "dispenseRx", label: "صرف أدوية الوصفة", hint: "بيع الأدوية التي لا تُصرف إلا بوصفة طبية" },
  { id: "viewReports", label: "عرض التقارير", hint: "المبيعات والأرباح وسجل الوصفات" },
  { id: "modifyInventory", label: "تعديل المخزون", hint: "الأصناف والدفعات والمشتريات والموردون" },
];

const DEFAULTS: Record<Permission, Role[]> = {
  giveDiscount: ["admin", "chief_pharmacist", "pharmacist", "cashier"],
  dispenseRx: ["admin", "chief_pharmacist", "pharmacist"],
  viewReports: ["admin", "chief_pharmacist"],
  modifyInventory: ["admin", "chief_pharmacist", "pharmacist", "storekeeper"],
};

export function roleDefault(role: Role, p: Permission): boolean {
  return DEFAULTS[p].includes(role);
}

/** Admins have everything; others get the override if set, else the role default. */
export function resolvePermissions(role: Role, overrides: PermissionOverrides = {}): Permissions {
  const get = (p: Permission) => role === "admin" || (overrides[p] ?? roleDefault(role, p));
  return { giveDiscount: get("giveDiscount"), dispenseRx: get("dispenseRx"), viewReports: get("viewReports"), modifyInventory: get("modifyInventory") };
}

/** Keeps only real exceptions (different from the role default); admins keep none. */
export function normalizeOverrides(role: Role, overrides: PermissionOverrides): PermissionOverrides {
  if (role === "admin") return {};
  const out: PermissionOverrides = {};
  for (const { id } of PERMISSIONS) {
    const v = overrides[id];
    if (v !== null && v !== undefined && v !== roleDefault(role, id)) out[id] = v;
  }
  return out;
}
