import type {
  AdjustBatchInput,
  AuthStatus,
  Batch,
  Category,
  InventoryBatch,
  InventoryItem,
  NewProduct,
  ProductHit,
  ReceiveBatchInput,
  SaleDraft,
  SaleResult,
  SearchMode,
  User,
} from "../core/types.ts";

/** Everything the screens need from storage. Two implementations: SQLite in the desktop app, memory in the browser demo. */
export interface PharmacyRepo {
  readonly kind: "sqlite" | "demo";
  authStatus(): Promise<AuthStatus>;
  /** First run only: sets the admin password and signs in. */
  setupAdmin(password: string): Promise<User>;
  login(username: string, password: string): Promise<User>;
  logout(): Promise<void>;
  search(query: string, mode: SearchMode): Promise<ProductHit[]>;
  findByCode(codes: string[]): Promise<ProductHit | null>;
  alternatives(productId: string): Promise<ProductHit[]>;
  batches(productId: string): Promise<Batch[]>;
  /** Posted as the signed-in user. */
  postSale(draft: SaleDraft): Promise<SaleResult>;
  inventory(): Promise<InventoryItem[]>;
  /** All batches still holding stock, expired ones included, in FEFO order. */
  inventoryBatches(productId: string): Promise<InventoryBatch[]>;
  categories(): Promise<Category[]>;
  // Inventory writes need an INVENTORY_ROLES user; each returns the product's updated row.
  addProduct(product: NewProduct): Promise<InventoryItem>;
  receiveBatch(batch: ReceiveBatchInput): Promise<InventoryItem>;
  adjustBatch(adjustment: AdjustBatchInput): Promise<InventoryItem>;
}

export function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
