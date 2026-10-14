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
