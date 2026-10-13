import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { allocateFefo, InsufficientStockError } from "../core/fefo.ts";
import { gtinLookupKeys, looksLikeScan, parseScan } from "../core/gs1.ts";
import { computeTotals, formatIqd, settle, type PaymentInput } from "../core/totals.ts";
import type { Allocation, Batch, ProductHit, SaleResult, SearchMode } from "../core/types.ts";
import { localToday, repo } from "../data/index.ts";
import { ExpiryTag } from "./ExpiryTag.tsx";
import { Receipt, type ReceiptLine } from "./Receipt.tsx";

interface CartLine {
  product: ProductHit;
  batches: Batch[];
  qty: number;
  discount: number;
  preferredBatchId?: string;
  allocations: Allocation[];
  overridesFefo: boolean;
}

type PayMode = "cash" | "card" | "split";

const MODES: { id: SearchMode; label: string; key?: string }[] = [
  { id: "trade", label: "الاسم التجاري" },
  { id: "generic", label: "المادة الفعالة" },
  { id: "alternatives", label: "البدائل", key: "F4" },
];

const PAY_LABEL: Record<PayMode, string> = { cash: "نقدي", card: "بطاقة", split: "بطاقة + نقدي" };

function toInt(s: string): number {
  const n = Number(s.replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function PosScreen({ userId }: { userId: string }) {
  const today = localToday();
  const searchRef = useRef<HTMLInputElement>(null);
  const tenderedRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("trade");
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [hitsLabel, setHitsLabel] = useState("");
  const [active, setActive] = useState(0);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [invoiceDiscount, setInvoiceDiscount] = useState("");
  const [payMode, setPayMode] = useState<PayMode>("cash");
  const [tendered, setTendered] = useState("");
  const [cardAmount, setCardAmount] = useState("");

  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastSale, setLastSale] = useState<{ sale: SaleResult; lines: ReceiptLine[]; method: string } | null>(null);

  // ── Search (typed text is debounced; scans are handled on Enter) ──
  useEffect(() => {
    const q = query.trim();
    if (!q || looksLikeScan(q)) {
      if (!q) {
        setHits([]);
        setHitsLabel("");
      }
      return;
    }
    const t = setTimeout(async () => {
      try {
        const found = await repo.search(q, mode);
        setHits(found);
        setActive(0);
        setHitsLabel(`${found.length} نتيجة`);
      } catch (e) {
        setMessage({ kind: "error", text: String(e) });
      }
    }, 150);
    return () => clearTimeout(t);
  }, [query, mode]);

  // ── Cart ──
  function allocateLine(line: Omit<CartLine, "allocations" | "overridesFefo">): CartLine {
    const r = allocateFefo(line.batches, line.qty, { today, preferredBatchId: line.preferredBatchId });
    return { ...line, allocations: r.allocations, overridesFefo: r.overridesFefo };
  }

  function explain(e: unknown, name: string): string {
    if (e instanceof InsufficientStockError) {
      return e.available === 0 ? `${name}: لا توجد كمية صالحة للبيع` : `${name}: المتوفر للبيع ${e.available} فقط`;
    }
    return e instanceof Error ? e.message : String(e);
  }

  async function addProduct(hit: ProductHit, scan?: { batchNo?: string; expiry?: string }) {
    if (scan?.expiry && scan.expiry <= today) {
      setMessage({ kind: "error", text: `هذه العبوة من ${hit.tradeName} منتهية الصلاحية (${scan.expiry}). لا تُباع.` });
      return;
    }
    try {
      const batches = await repo.batches(hit.id);
      const existing = cart.find((l) => l.product.id === hit.id);
      const scanned = scan?.batchNo ? batches.find((b) => b.batchNo === scan.batchNo) : undefined;
      const line = allocateLine({
        product: hit,
        batches,
        qty: (existing?.qty ?? 0) + 1,
        discount: existing?.discount ?? 0,
        preferredBatchId: scanned?.id ?? existing?.preferredBatchId,
      });
      setCart(existing ? cart.map((l) => (l.product.id === hit.id ? line : l)) : [...cart, line]);
      setMessage(
        hit.requiresRx ? { kind: "info", text: `${hit.tradeName} يُصرف بوصفة طبية — تحقّق من الوصفة.` } : null,
      );
      setQuery("");
      setLastSale(null);
    } catch (e) {
      setMessage({ kind: "error", text: explain(e, hit.tradeName) });
    }
    searchRef.current?.focus();
  }

  function setQty(productId: string, qty: number) {
    if (qty <= 0) return removeLine(productId);
    const current = cart.find((l) => l.product.id === productId);
    if (!current) return;
    try {
      const line = allocateLine({ ...current, qty });
      setCart(cart.map((l) => (l.product.id === productId ? line : l)));
      setMessage(null);
    } catch (e) {
      setMessage({ kind: "error", text: explain(e, current.product.tradeName) });
    }
  }

  function setDiscount(productId: string, value: string) {
    setCart(cart.map((l) => (l.product.id === productId ? { ...l, discount: toInt(value) } : l)));
  }

  function removeLine(productId: string) {
    setCart(cart.filter((l) => l.product.id !== productId));
  }

  async function handleScan(raw: string) {
    const scan = parseScan(raw);
    const codes =
      scan.kind === "gs1" ? gtinLookupKeys(scan.data.gtin ?? "") : [scan.code, ...gtinLookupKeys(scan.code).slice(1)];
    const hit = await repo.findByCode(codes);
    if (!hit) {
      setMessage({ kind: "error", text: `باركود غير معروف: ${scan.kind === "gs1" ? scan.data.gtin : scan.code}` });
      setQuery("");
      return;
    }
    await addProduct(hit, scan.kind === "gs1" ? { batchNo: scan.data.batch, expiry: scan.data.expiry } : undefined);
  }

  async function showAlternatives(hit: ProductHit) {
    const alts = await repo.alternatives(hit.id);
    setHits(alts);
    setActive(0);
    setHitsLabel(alts.length ? `بدائل ${hit.tradeName} بنفس المادة والتركيز` : `لا توجد بدائل مسجّلة لـ ${hit.tradeName}`);
  }

  // ── Money ──
  const lineInputs = cart.map((l) => ({ unitPrice: l.product.price, qty: l.qty, discount: l.discount }));
  const totals = computeTotals(lineInputs, toInt(invoiceDiscount));
  const payments: PaymentInput[] =
    payMode === "cash"
      ? [{ method: "cash", amount: tendered ? toInt(tendered) : totals.total }]
      : payMode === "card"
        ? [{ method: "card", amount: totals.total }]
        : [
            { method: "card", amount: Math.min(toInt(cardAmount), totals.total) },
            { method: "cash", amount: tendered ? toInt(tendered) : Math.max(0, totals.total - toInt(cardAmount)) },
          ];
  const settlement = settle(totals.total, payments);
  const canComplete = cart.length > 0 && settlement.remaining === 0 && !busy;

  async function complete() {
    if (!canComplete) return;
    setBusy(true);
    try {
      const sale = await repo.postSale({
        lines: cart.map((l) => ({
          productId: l.product.id,
          unitPrice: l.product.price,
          discount: l.discount,
          allocations: l.allocations,
          fefoOverrideReason: l.overridesFefo ? "دفعة محددة بالمسح أو يدوياً" : undefined,
        })),
        invoiceDiscount: toInt(invoiceDiscount),
        payments,
        userId,
      });
      const lines: ReceiptLine[] = cart.map((l) => ({
        name: l.product.tradeName,
        qty: l.qty,
        unitPrice: l.product.price,
        total: Math.max(0, l.product.price * l.qty - l.discount),
        batches: l.allocations.map((a) => a.batchNo).join("، "),
      }));
      setLastSale({ sale, lines, method: PAY_LABEL[payMode] });
      setCart([]);
      setTendered("");
      setCardAmount("");
      setInvoiceDiscount("");
      setPayMode("cash");
      setMessage(null);
      if (query.trim()) setHits(await repo.search(query.trim(), mode));
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      searchRef.current?.focus();
    }
  }

  // ── Keyboard shortcuts ──
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    const map: Record<string, () => void> = {
      F2: () => searchRef.current?.focus(),
      F4: () => {
        setMode("alternatives");
        searchRef.current?.focus();
      },
      F9: () => {
        setPayMode("cash");
        setTimeout(() => tenderedRef.current?.focus(), 0);
      },
      F10: () => setPayMode("card"),
      F12: () => void complete(),
    };
    const fn = map[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", onKey);
    searchRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function onSearchKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(0, hits.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Escape") {
      setQuery("");
    } else if (e.key === "Enter") {
      e.preventDefault();
      const q = query.trim();
      if (!q) return;
      if (looksLikeScan(q)) void handleScan(q);
      else if (hits[active]) void addProduct(hits[active]);
    }
  }

  return (
    <main className="pos">
      <section className="panel search-panel" aria-label="البحث">
        <div className="search-head">
          <label htmlFor="pos-search" className="label">
            امسح الباركود أو ابحث <kbd>F2</kbd>
          </label>
          <div className="search-box">
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20 L16 16" />
            </svg>
            <input
              id="pos-search"
              ref={searchRef}
              value={query}
              autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              placeholder="اسم تجاري، مادة فعالة، أو باركود"
            />
          </div>
          <div role="group" aria-label="نوع البحث" className="chips">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`chip ${mode === m.id ? "on" : ""}`}
                aria-pressed={mode === m.id}
                onClick={() => {
                  setMode(m.id);
                  searchRef.current?.focus();
                }}
              >
                {m.label} {m.key && <kbd className="soft">{m.key}</kbd>}
              </button>
            ))}
          </div>
        </div>
        {hitsLabel && <div className="hits-label">{hitsLabel}</div>}
        <ul className="hits">
          {hits.map((h, i) => (
            <li key={h.id} className={`hit ${i === active ? "active" : ""} ${h.stock === 0 ? "out" : ""}`}>
              <button type="button" className="hit-main" onClick={() => void addProduct(h)} onMouseEnter={() => setActive(i)}>
                <span className="hit-row">
                  <bdi className="hit-name">{h.tradeName}</bdi>
                  <bdi className="num">{formatIqd(h.price)}</bdi>
                </span>
                <span className="hit-sub">
                  <bdi>{h.generic}</bdi> · {h.form} · {h.packSize}
                </span>
                <span className="tags">
                  {h.stock > 0 ? <span className="tag ok">متوفر {h.stock}</span> : <span className="tag bad">نفد</span>}
                  {h.nearestExpiry && <ExpiryTag date={h.nearestExpiry} today={today} />}
                  {h.requiresRx && <span className="tag info">وصفة</span>}
                </span>
              </button>
              <button type="button" className="link-btn" onClick={() => void showAlternatives(h)}>
                بدائل
              </button>
            </li>
          ))}
        </ul>
        <div className="search-foot">
          للتجربة: امسح أو اكتب <bdi className="num">2000000000046</bdi> (Panadol Extra) أو
          <bdi className="num"> (01)02000000000077(17)301231(10)B2311</bdi>
        </div>
      </section>

      <section className="panel cart-panel" aria-label="سلة البيع">
        <div className="cart-head">
          <h2>فاتورة جديدة</h2>
          <span className="muted">{cart.length} صنف</span>
        </div>
        {message && (
          <div role={message.kind === "error" ? "alert" : "status"} className={`banner ${message.kind}`}>
            <span>{message.text}</span>
            <button type="button" className="link-btn" onClick={() => setMessage(null)} aria-label="إغلاق التنبيه">
              ×
            </button>
          </div>
        )}
        {lastSale && (
          <div role="status" className="banner success">
            <span>
              تم البيع · فاتورة <bdi className="num">{lastSale.sale.invoiceNo}</bdi> · الإجمالي{" "}
              <bdi className="num">{formatIqd(lastSale.sale.total)}</bdi>
              {lastSale.sale.change > 0 && (
                <>
                  {" "}· الباقي للعميل <bdi className="num">{formatIqd(lastSale.sale.change)}</bdi>
                </>
              )}
            </span>
            <button type="button" className="btn" onClick={() => window.print()}>
              طباعة الإيصال
            </button>
          </div>
        )}
        <div className="table-wrap">
          <table className="cart">
            <thead>
              <tr>
                <th>الصنف</th>
                <th>الدفعة · الصلاحية (FEFO)</th>
                <th>الكمية</th>
                <th>السعر</th>
                <th>خصم</th>
                <th>الإجمالي</th>
                <th>
                  <span className="sr-only">حذف</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {cart.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">
                    السلة فارغة — امسح باركود صنف أو ابحث عنه
                  </td>
                </tr>
              )}
              {cart.map((l) => (
                <tr key={l.product.id}>
                  <td>
                    <div className="strong"><bdi>{l.product.tradeName}</bdi></div>
                    <div className="muted small"><bdi>{l.product.generic}</bdi> · {l.product.strength}</div>
                  </td>
                  <td>
                    {l.allocations.map((a) => (
                      <div key={a.batchId} className="alloc">
                        <bdi className="num">{a.batchNo}</bdi> <ExpiryTag date={a.expiryDate} today={today} />
                        {l.allocations.length > 1 && <span className="muted small"> × {a.qty}</span>}
                      </div>
                    ))}
                    {l.overridesFefo && <span className="tag warn">ليست الأقرب انتهاءً</span>}
                  </td>
                  <td>
                    <div className="qty">
                      <button type="button" aria-label="إنقاص" onClick={() => setQty(l.product.id, l.qty - 1)}>−</button>
                      <input
                        aria-label={`كمية ${l.product.tradeName}`}
                        className="num"
                        value={l.qty}
                        onChange={(e) => setQty(l.product.id, toInt(e.target.value))}
                      />
                      <button type="button" aria-label="زيادة" onClick={() => setQty(l.product.id, l.qty + 1)}>+</button>
                    </div>
                  </td>
                  <td className="num">{formatIqd(l.product.price)}</td>
                  <td>
                    <input
                      aria-label={`خصم ${l.product.tradeName}`}
                      className="num small-input"
                      value={l.discount || ""}
                      placeholder="0"
                      onChange={(e) => setDiscount(l.product.id, e.target.value)}
                    />
                  </td>
                  <td className="num strong">{formatIqd(Math.max(0, l.product.price * l.qty - l.discount))}</td>
                  <td>
                    <button type="button" className="icon-btn" aria-label={`حذف ${l.product.tradeName}`} onClick={() => removeLine(l.product.id)}>
                      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 6 L18 18 M18 6 L6 18" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="cart-foot">
          يختار النظام الدفعة الأقرب انتهاءً تلقائياً. مسح باركود GS1 لعبوة محددة يصرف من دفعتها مع تنبيه.
        </div>
      </section>

      <aside className="panel pay-panel" aria-label="الدفع">
        <div className="sum"><span>المجموع</span><bdi className="num">{formatIqd(totals.subtotal)}</bdi></div>
        <div className="sum"><span>خصومات الأسطر</span><bdi className="num">{formatIqd(totals.lineDiscounts)}</bdi></div>
        <div className="sum">
          <label htmlFor="inv-disc">خصم على الفاتورة</label>
          <input id="inv-disc" className="num small-input" value={invoiceDiscount} placeholder="0" onChange={(e) => setInvoiceDiscount(e.target.value)} />
        </div>
        <div className="grand">
          <span>المطلوب</span>
          <span>
            <bdi className="num big">{formatIqd(totals.total)}</bdi> <span className="muted">د.ع</span>
          </span>
        </div>
        <div role="radiogroup" aria-label="طريقة الدفع" className="pay-grid">
          {(Object.keys(PAY_LABEL) as PayMode[]).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={payMode === m} className={`pay ${payMode === m ? "on" : ""}`} onClick={() => setPayMode(m)}>
              {PAY_LABEL[m]}
              {m === "cash" && <kbd>F9</kbd>}
              {m === "card" && <kbd>F10</kbd>}
            </button>
          ))}
          <button type="button" className="pay" disabled title="يتطلب ملف العميل — المرحلة التالية">
            آجل / ذمة
          </button>
        </div>
        {payMode === "split" && (
          <>
            <label htmlFor="card-amt" className="label">مبلغ البطاقة</label>
            <input id="card-amt" className="num field" value={cardAmount} placeholder="0" onChange={(e) => setCardAmount(e.target.value)} />
          </>
        )}
        {payMode !== "card" && (
          <>
            <label htmlFor="tendered" className="label">النقد المستلم</label>
            <input
              id="tendered"
              ref={tenderedRef}
              className="num field"
              value={tendered}
              placeholder={formatIqd(payMode === "split" ? Math.max(0, totals.total - toInt(cardAmount)) : totals.total)}
              onChange={(e) => setTendered(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void complete();
              }}
            />
          </>
        )}
        <div className="sum">
          <span>{settlement.remaining > 0 ? "المتبقي" : "الباقي للعميل"}</span>
          <bdi className={`num strong ${settlement.remaining > 0 ? "bad-text" : ""}`}>
            {formatIqd(settlement.remaining > 0 ? settlement.remaining : settlement.change)}
          </bdi>
        </div>
        <button type="button" className="complete" disabled={!canComplete} onClick={() => void complete()}>
          {busy ? "جارٍ الحفظ…" : "إتمام البيع"} <kbd>F12</kbd>
        </button>
      </aside>

      <footer className="shortcuts">
        <span><kbd>F2</kbd> بحث</span>
        <span><kbd>F4</kbd> بدائل</span>
        <span><kbd>↑ ↓</kbd> تنقّل في النتائج</span>
        <span><kbd>Enter</kbd> إضافة</span>
        <span><kbd>F9</kbd> نقدي</span>
        <span><kbd>F10</kbd> بطاقة</span>
        <span><kbd>F12</kbd> إتمام</span>
        <span><kbd>Esc</kbd> مسح البحث</span>
      </footer>

      {lastSale && <Receipt sale={lastSale.sale} lines={lastSale.lines} method={lastSale.method} />}
    </main>
  );
}
