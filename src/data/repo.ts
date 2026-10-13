import type { Batch, ProductHit, SaleDraft, SaleResult, SearchMode } from "../core/types.ts";

/** Everything the screens need from storage. Two implementations: SQLite in the desktop app, memory in the browser demo. */
export interface PharmacyRepo {
  readonly kind: "sqlite" | "demo";
  search(query: string, mode: SearchMode): Promise<ProductHit[]>;
  findByCode(codes: string[]): Promise<ProductHit | null>;
  alternatives(productId: string): Promise<ProductHit[]>;
  batches(productId: string): Promise<Batch[]>;
  postSale(draft: SaleDraft): Promise<SaleResult>;
}

export function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
