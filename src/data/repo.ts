import type { PermissionOverrides } from "../core/permissions.ts";
import type {
  AdjustBatchInput,
  AuditCategory,
  AuditReport,
  AuthStatus,
  Batch,
  Branch,
  BranchInput,
  DeviceInfo,
  Category,
  ExpiryReport,
  FirewallState,
  InventoryBatch,
  InventoryItem,
  NewProduct,
  NewSupplier,
  NewUser,
  PhoneScan,
  PhoneScannerInfo,
  ProductHit,
  PurchaseInvoice,
  PurchaseResult,
  Receipt,
  ReceiptSettings,
  RecentSale,
  ReceiveBatchInput,
  ReorderRow,
  ReportFilter,
  Role,
  RxReport,
  SaleSettings,
  SyncSettings,
  SyncSettingsInput,
  SyncStatus,
  SaleDraft,
  SaleResult,
  SalesReport,
  SearchMode,
  Supplier,
  Transfer,
  TransferRequest,
  TransferShipment,
  User,
  UserRef,
  UserRow,
} from "../core/types.ts";

/** Everything the screens need from storage. Two implementations: SQLite in the desktop app, memory in the browser demo. */
export interface PharmacyRepo {
  readonly kind: "sqlite" | "demo";
  authStatus(): Promise<AuthStatus>;
  /** First run only: sets the admin password and signs in; `branchId` puts this device on that branch. */
  setupAdmin(password: string, branchId?: string): Promise<User>;
  /** `branchId`: the branch picked at sign-in. Moving the device to another branch needs an admin. */
  login(username: string, password: string, branchId?: string): Promise<User>;
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
  // Inventory writes need the modifyInventory permission; each returns the product's updated row.
  addProduct(product: NewProduct): Promise<InventoryItem>;
  /** Replaces the product's details; changes are audit-logged with before and after values. */
  updateProduct(productId: string, product: NewProduct): Promise<InventoryItem>;
  receiveBatch(batch: ReceiveBatchInput): Promise<InventoryItem>;
  adjustBatch(adjustment: AdjustBatchInput): Promise<InventoryItem>;
  suppliers(): Promise<Supplier[]>;
  addSupplier(supplier: NewSupplier): Promise<Supplier>;
  /** Posts a supplier invoice in one transaction; its stock is sellable at once. */
  postPurchaseInvoice(invoice: PurchaseInvoice): Promise<PurchaseResult>;
  // Reports (read-only). Money and prescription reports need viewReports; stock reports modifyInventory or viewReports.
  reportUsers(): Promise<UserRef[]>;
  reportSales(filter: ReportFilter): Promise<SalesReport>;
  reportExpiry(filter: ReportFilter, withinDays: number): Promise<ExpiryReport>;
  /** One branch; this device's when left out. */
  reportReorder(categoryId?: string, branchId?: string): Promise<ReorderRow[]>;
  reportPrescriptions(filter: ReportFilter): Promise<RxReport>;
  /** Admin only. `filter.cashierId` is the user who acted. */
  reportAudit(filter: ReportFilter, category?: AuditCategory): Promise<AuditReport>;
  /** Saves an exported file for the user; returns where it went. */
  saveExport(fileName: string, content: string): Promise<string>;
  // Employees (admin only). Each change returns the updated row.
  listUsers(): Promise<UserRow[]>;
  createUser(user: NewUser): Promise<UserRow>;
  /** Sets the role and the per-user permission overrides together. */
  updateUserRole(userId: string, role: Role, overrides: PermissionOverrides): Promise<UserRow>;
  /** Sets the account active or inactive (the wanted state, not a flip). */
  toggleUserStatus(userId: string, active: boolean): Promise<UserRow>;
  resetUserPassword(userId: string, password: string): Promise<UserRow>;
  // Phone scanner (desktop app only).
  /** Link, QR code and status for pairing a phone; null where there is no scanner server (browser demo). */
  phoneScanner(): Promise<PhoneScannerInfo | null>;
  /** Calls `handler` for every barcode scanned on a paired phone; returns a function that stops listening. */
  onPhoneScan(handler: (scan: PhoneScan) => void): Promise<() => void>;
  phoneScannerFirewall(): Promise<FirewallState>;
  /** Adds the firewall rule; Windows asks for administrator approval. */
  allowPhoneScannerFirewall(): Promise<FirewallState>;
  // Cloud sync. The status is for everyone; settings are admin only.
  syncStatus(): Promise<SyncStatus>;
  /** Calls `handler` on every status change; returns a function that stops listening. */
  onSyncStatus(handler: (status: SyncStatus) => void): Promise<() => void>;
  /** Sync now, including changes the cloud refused before. */
  syncNow(): Promise<void>;
  syncSettings(): Promise<SyncSettings>;
  saveSyncSettings(settings: SyncSettingsInput): Promise<SyncSettings>;
  // Sale settings: the discount cap.
  saleSettings(): Promise<SaleSettings>;
  /** Admin only. */
  saveSaleSettings(settings: SaleSettings): Promise<SaleSettings>;
  // Receipts.
  receiptSettings(): Promise<ReceiptSettings>;
  /** Admin only. */
  saveReceiptSettings(settings: ReceiptSettings): Promise<ReceiptSettings>;
  /** `reprint` marks the receipt as a copy and records it in the audit log. Cashiers get only their own sales. */
  saleReceipt(saleId: string, reprint: boolean): Promise<Receipt>;
  /** Today's sales on this device, newest first (cashiers: their own). */
  recentSales(): Promise<RecentSale[]>;
  // Branches. Open to everyone (the sign-in screen needs it).
  deviceInfo(): Promise<DeviceInfo>;
  /** Admin only: adds a branch (no id) or edits one. */
  saveBranch(branch: BranchInput): Promise<Branch>;
  // Transfers between branches; need modifyInventory. Each returns the transfer as it now stands.
  /** Transfers into or out of this device's branch, open ones first. */
  transfers(): Promise<Transfer[]>;
  /** This branch asks another for stock; nothing moves until it ships. */
  requestTransfer(request: TransferRequest): Promise<Transfer>;
  /** Sends stock from this branch (FEFO); it leaves this branch at once. */
  shipTransfer(shipment: TransferShipment): Promise<Transfer>;
  /** Puts a shipped transfer on this branch's shelf. */
  receiveTransfer(transferId: string): Promise<Transfer>;
  /** Withdraws or declines a request that has not shipped. */
  cancelTransfer(transferId: string): Promise<Transfer>;
}

export function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
