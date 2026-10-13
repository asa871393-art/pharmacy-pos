// Invoice arithmetic in integer dinars.

import type { PaymentMethod } from "./types.ts";

export interface LineInput {
  unitPrice: number;
  qty: number;
  discount: number;
}

export interface Totals {
  subtotal: number;
  lineDiscounts: number;
  invoiceDiscount: number;
  total: number;
}

export function lineTotal(l: LineInput): number {
  return Math.max(0, l.unitPrice * l.qty - l.discount);
}

export function computeTotals(lines: LineInput[], invoiceDiscount = 0): Totals {
  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
  const lineDiscounts = lines.reduce((s, l) => s + Math.min(l.discount, l.unitPrice * l.qty), 0);
  const afterLines = subtotal - lineDiscounts;
  const inv = Math.min(Math.max(0, invoiceDiscount), afterLines);
  return { subtotal, lineDiscounts, invoiceDiscount: inv, total: afterLines - inv };
}

export interface PaymentInput {
  method: PaymentMethod;
  amount: number;
}

export interface Settlement {
  paid: number; // amount applied to the invoice
  tendered: number; // what the customer handed over
  change: number; // cash returned
  remaining: number; // still unpaid
  onCredit: number;
}

/**
 * Applies payments to a total. Only cash can produce change; card and credit are capped at what is still owed.
 */
export function settle(total: number, payments: PaymentInput[]): Settlement {
  let remaining = total;
  let tendered = 0;
  let change = 0;
  let onCredit = 0;
  const ordered = [...payments].sort((a, b) => (a.method === "cash" ? 1 : 0) - (b.method === "cash" ? 1 : 0));
  for (const p of ordered) {
    if (p.amount <= 0) continue;
    tendered += p.amount;
    if (p.method === "cash") {
      const applied = Math.min(p.amount, remaining);
      change += p.amount - applied;
      remaining -= applied;
    } else {
      const applied = Math.min(p.amount, remaining);
      if (p.method === "credit") onCredit += applied;
      remaining -= applied;
    }
  }
  return { paid: total - remaining, tendered, change, remaining, onCredit };
}

const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
export function formatIqd(n: number): string {
  return fmt.format(n);
}
