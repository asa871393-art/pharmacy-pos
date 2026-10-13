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

export interface SaleDraft {
  lines: SaleLineDraft[];
  invoiceDiscount: number;
  payments: { method: PaymentMethod; amount: number; reference?: string }[];
  patientId?: string;
  userId: string;
}

export interface SaleResult {
  saleId: string;
  invoiceNo: string;
  total: number;
  paid: number;
  change: number;
  createdAt: string;
}
