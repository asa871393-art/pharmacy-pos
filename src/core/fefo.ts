// FEFO — First Expired, First Out.
// Given a product's batches, decide which batches a sale draws from.

import type { Allocation, Batch } from "./types.ts";

export class InsufficientStockError extends Error {
  readonly available: number;
  readonly requested: number;
  constructor(requested: number, available: number) {
    super(`الكمية المطلوبة ${requested} أكبر من المتوفر للبيع ${available}`);
    this.name = "InsufficientStockError";
    this.requested = requested;
    this.available = available;
  }
}

export interface FefoOptions {
  /** Today's date 'YYYY-MM-DD'. A batch is sellable only if it expires AFTER today + minDaysLeft. */
  today: string;
  /** Refuse batches with fewer days left than this (default 0: sellable until the day before expiry). */
  minDaysLeft?: number;
  /** A batch the pharmacist scanned or picked by hand; it is drawn from first. */
  preferredBatchId?: string;
}

export interface FefoResult {
  allocations: Allocation[];
  /** True when a preferred batch was used while a sooner-expiring sellable batch exists. */
  overridesFefo: boolean;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + "T00:00:00Z");
  const b = Date.parse(toIso + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

export function sellableBatches(batches: Batch[], opts: FefoOptions): Batch[] {
  const cutoff = addDays(opts.today, opts.minDaysLeft ?? 0);
  return batches
    .filter((b) => b.qtyOnHand > 0 && b.expiryDate > cutoff)
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.receivedAt.localeCompare(b.receivedAt));
}

export function availableQty(batches: Batch[], opts: FefoOptions): number {
  return sellableBatches(batches, opts).reduce((sum, b) => sum + b.qtyOnHand, 0);
}

export function allocateFefo(batches: Batch[], qty: number, opts: FefoOptions): FefoResult {
  if (!Number.isInteger(qty) || qty <= 0) throw new RangeError("الكمية يجب أن تكون عدداً صحيحاً أكبر من صفر");
  let ordered = sellableBatches(batches, opts);
  let overridesFefo = false;

  if (opts.preferredBatchId) {
    const idx = ordered.findIndex((b) => b.id === opts.preferredBatchId);
    if (idx > 0) {
      overridesFefo = true;
      const [preferred] = ordered.splice(idx, 1);
      ordered = [preferred, ...ordered];
    }
  }

  const available = ordered.reduce((s, b) => s + b.qtyOnHand, 0);
  if (available < qty) throw new InsufficientStockError(qty, available);

  const allocations: Allocation[] = [];
  let remaining = qty;
  for (const b of ordered) {
    if (remaining === 0) break;
    const take = Math.min(b.qtyOnHand, remaining);
    allocations.push({ batchId: b.id, batchNo: b.batchNo, expiryDate: b.expiryDate, qty: take, unitCost: b.unitCost });
    remaining -= take;
  }
  return { allocations, overridesFefo };
}

export type ExpiryStatus = "expired" | "critical" | "warning" | "watch" | "ok";

export interface ExpiryThresholds {
  critical: number;
  warning: number;
  watch: number;
}

export const DEFAULT_THRESHOLDS: ExpiryThresholds = { critical: 30, warning: 90, watch: 180 };

export function expiryStatus(expiryDate: string, today: string, t: ExpiryThresholds = DEFAULT_THRESHOLDS): ExpiryStatus {
  const days = daysBetween(today, expiryDate);
  if (days <= 0) return "expired";
  if (days <= t.critical) return "critical";
  if (days <= t.warning) return "warning";
  if (days <= t.watch) return "watch";
  return "ok";
}
