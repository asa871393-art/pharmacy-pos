import { invoke } from "@tauri-apps/api/core";
import type { Batch, ProductHit, SaleDraft, SaleResult, SearchMode } from "../core/types.ts";
import type { PharmacyRepo } from "./repo.ts";

export const tauriRepo: PharmacyRepo = {
  kind: "sqlite",
  search: (query: string, mode: SearchMode) => invoke<ProductHit[]>("search_products", { query, mode }),
  findByCode: (codes: string[]) => invoke<ProductHit | null>("find_by_code", { codes }),
  alternatives: (productId: string) => invoke<ProductHit[]>("alternatives", { productId }),
  batches: (productId: string) => invoke<Batch[]>("product_batches", { productId }),
  postSale: (draft: SaleDraft) => invoke<SaleResult>("post_sale", { draft }),
};
