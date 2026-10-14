import { invoke } from "@tauri-apps/api/core";
import type { AuthStatus, Batch, ProductHit, SaleDraft, SaleResult, SearchMode, User } from "../core/types.ts";
import type { PharmacyRepo } from "./repo.ts";

export const tauriRepo: PharmacyRepo = {
  kind: "sqlite",
  authStatus: () => invoke<AuthStatus>("auth_status"),
  setupAdmin: (password: string) => invoke<User>("setup_admin", { password }),
  login: (username: string, password: string) => invoke<User>("login", { username, password }),
  logout: () => invoke<void>("logout"),
  search: (query: string, mode: SearchMode) => invoke<ProductHit[]>("search_products", { query, mode }),
  findByCode: (codes: string[]) => invoke<ProductHit | null>("find_by_code", { codes }),
  alternatives: (productId: string) => invoke<ProductHit[]>("alternatives", { productId }),
  batches: (productId: string) => invoke<Batch[]>("product_batches", { productId }),
  postSale: (draft: SaleDraft) => invoke<SaleResult>("post_sale", { draft }),
};
