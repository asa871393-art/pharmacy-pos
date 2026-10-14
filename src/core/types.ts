// Shared domain types. Money is integer dinars; dates are 'YYYY-MM-DD'.

import type { PermissionOverrides, Permissions } from "./permissions.ts";

export type SearchMode = "trade" | "generic" | "alternatives";

export interface ProductHit {
  id: string;
  tradeName: string;
  generic: string; // e.g. "Metformin" or "Paracetamol + Caffeine"
  strength: string;
  form: string;
  packSize: number;
  price: number;
  stock: number; // sellable (non-expired) quantity
  nearestExpiry: string | null; // earliest sellable expiry
  requiresRx: boolean;
  compositionKey: string;
  drugClasses: string[];
}

export interface Batch {
  id: string;
  productId: string;
  batchNo: string;
  expiryDate: string;
  qtyOnHand: number;
  unitCost: number;
  sellPrice: number;
  receivedAt: string;
}

export interface Allocation {
  batchId: string;
  batchNo: string;
  expiryDate: string;
  qty: number;
  unitCost: number;
}

export type PaymentMethod = "cash" | "card" | "credit";

export interface SaleLineDraft {
  productId: string;
  unitPrice: number;
  discount: number; // line discount in dinars
  allocations: Allocation[];
  fefoOverrideReason?: string;
}

export interface Prescription {
  rxNo: string;
  prescriber: string; // doctor who wrote it
}

/** The seller is whoever is signed in; the backend takes it from the session, not from the draft. */
export interface SaleDraft {
  lines: SaleLineDraft[];
  invoiceDiscount: number;
  payments: { method: PaymentMethod; amount: number; reference?: string }[];
  patientId?: string;
  /** Required when any line is a prescription-only medicine. */
  prescription?: Prescription;
}

export type Role = "admin" | "chief_pharmacist" | "pharmacist" | "cashier" | "storekeeper";

export interface User {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  /** Effective permissions at sign-in: role defaults with any per-user overrides. The backend re-checks each call. */
  permissions: Permissions;
}

/** For pick lists such as the report's cashier filter. */
export interface UserRef {
  id: string;
  fullName: string;
}

/** A row of the employees screen (admin only). */
export interface UserRow extends User {
  active: boolean;
  hasPassword: boolean;
  lastLogin: string | null; // local "YYYY-MM-DD HH:MM:SS"
  overrides: PermissionOverrides;
}

export interface NewUser {
  username: string;
  fullName: string;
  password: string;
  role: Role;
  overrides?: PermissionOverrides;
}

export interface AuthStatus {
  /** No password has been set yet (first run): the admin must choose one. */
  needsSetup: boolean;
  user: User | null;
}

export interface SaleResult {
  saleId: string;
  invoiceNo: string;
  total: number;
  paid: number;
  change: number;
  createdAt: string;
}

// ── Inventory ──

export interface InventoryItem {
  id: string;
  barcode: string | null;
  tradeName: string;
  tradeNameAr: string | null;
  category: string | null;
  form: string;
  strength: string;
  packSize: number;
  price: number;
  requiresRx: boolean;
  stock: number; // sellable (non-expired) quantity
  expiredQty: number; // still on the shelf in expired batches
  nearestExpiry: string | null; // next batch FEFO will sell
  reorderLevel: number | null; // at or below this the item is low
}

export interface InventoryBatch {
  id: string;
  batchNo: string;
  expiryDate: string;
  qtyOnHand: number;
  unitCost: number;
  sellPrice: number;
  status: string;
  receivedAt: string;
}

export interface Category {
  id: string;
  nameAr: string;
}

export interface NewProduct {
  tradeName: string;
  tradeNameAr?: string;
  categoryId?: string;
  dosageForm: string;
  strength: string;
  packSize: number;
  price: number;
  requiresRx: boolean;
  barcode?: string;
  reorderLevel?: number;
}

/** Goods received as a new batch. */
export interface ReceiveBatchInput {
  productId: string;
  batchNo: string;
  expiryDate: string;
  qty: number;
  unitCost: number;
}

/** Stock count: sets a batch to the counted quantity. */
export interface AdjustBatchInput {
  batchId: string;
  newQty: number;
  reason: string;
}

// ── Purchasing ──

export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  paymentTermsDays: number;
  balance: number; // what the pharmacy owes them
}

export interface NewSupplier {
  name: string;
  phone?: string;
  paymentTermsDays?: number;
}

/** "cash": paid on delivery. "credit": added to what we owe the supplier. */
export type PurchasePayment = "cash" | "credit";

/** One batch received. The same product delivered in two batches is two lines. */
export interface PurchaseLine {
  productId: string;
  batchNo: string;
  expiryDate: string;
  qty: number;
  unitCost: number; // purchase price per unit
  sellPrice: number; // retail price; becomes the product's selling price
}

export interface PurchaseInvoice {
  supplierId: string;
  supplierInvoiceNo: string;
  invoiceDate: string;
  payment: PurchasePayment;
  lines: PurchaseLine[];
}

export interface PurchaseResult {
  invoiceId: string;
  total: number;
  units: number;
  batchesCreated: number;
  batchesUpdated: number;
  priceChanges: string[]; // products whose selling price changed
  dueDate: string | null;
  supplierBalance: number;
}

// ── Reports ──

/** Local calendar days, both ends included. */
export interface ReportFilter {
  from: string;
  to: string;
  cashierId?: string;
  categoryId?: string;
}

export interface SalesTotals {
  invoices: number;
  units: number;
  gross: number; // before discounts
  discounts: number; // line discounts + each invoice's discount shared over its lines
  net: number;
  cost: number; // batch cost of the stock sold
  profit: number;
}

/** Grouped by cashier, day or product; `key` is the id or the date. */
export interface SalesRow {
  key: string;
  label: string;
  invoices: number;
  units: number;
  discounts: number;
  net: number;
  profit: number;
}

export interface SalesReport {
  totals: SalesTotals;
  byCashier: SalesRow[];
  byDay: SalesRow[];
  topProducts: SalesRow[];
}

export interface ExpiryRow {
  batchId: string;
  product: string;
  category: string | null;
  batchNo: string;
  expiryDate: string;
  daysLeft: number; // negative once expired
  qty: number;
  unitCost: number;
  value: number;
}

export interface WriteOffRow {
  day: string;
  product: string;
  batchNo: string;
  qty: number;
  value: number;
  reason: string | null;
  user: string | null;
}

export interface ExpiryReport {
  expiredQty: number;
  expiredValue: number;
  nearQty: number;
  nearValue: number;
  batches: ExpiryRow[];
  writeOffs: WriteOffRow[];
  writtenOffValue: number;
}

export interface ReorderRow {
  productId: string;
  product: string;
  barcode: string | null;
  category: string | null;
  stock: number;
  reorderLevel: number | null;
  sold30d: number;
  daysOfCover: number | null; // at the last 30 days' pace; null when nothing sold
  suggestedQty: number;
  supplier: string | null;
  lastCost: number | null;
}

export interface RxRow {
  saleId: string;
  invoiceNo: string;
  soldAt: string; // local "YYYY-MM-DD HH:MM:SS"
  rxNo: string;
  prescriber: string;
  pharmacist: string | null;
  items: string; // prescription-only items with quantities
  rxTotal: number;
}

export interface PrescriberRow {
  prescriber: string;
  prescriptions: number;
  units: number;
}

export interface RxReport {
  rows: RxRow[];
  byPrescriber: PrescriberRow[];
}
