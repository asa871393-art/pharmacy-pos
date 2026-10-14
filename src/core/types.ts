// Shared domain types. Money is integer dinars; dates are 'YYYY-MM-DD'.

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

/** Roles allowed to add products and change stock; every signed-in user may view inventory. */
export const INVENTORY_ROLES: Role[] = ["admin", "chief_pharmacist", "pharmacist", "storekeeper"];

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
