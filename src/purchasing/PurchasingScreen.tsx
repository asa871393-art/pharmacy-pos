import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { addDays } from "../core/fefo.ts";
import { gtinLookupKeys, looksLikeScan, parseScan } from "../core/gs1.ts";
import { formatIqd } from "../core/totals.ts";
import type { ProductHit, PurchasePayment, PurchaseResult, Supplier, User } from "../core/types.ts";
import { localToday, repo } from "../data/index.ts";
import { ExpiryTag } from "../pos/ExpiryTag.tsx";
import { errorText, Field, Modal, toInt } from "../ui/Modal.tsx";

/** One batch received. Inputs are kept as typed text; numbers are read with toInt. */
interface Line {
  key: number;
  product: ProductHit;
  batchNo: string;
  expiryDate: string;
  qty: string;
  unitCost: string;
  sellPrice: string;
}

const PAYMENT_LABEL: Record<PurchasePayment, string> = { cash: "نقداً", credit: "آجل" };

let nextKey = 1;

function lineTotal(l: Line): number {
  return toInt(l.qty) * toInt(l.unitCost);
}

/** What is still missing on a line, or "" when it can be posted. */
function lineProblem(l: Line, today: string): string {
  if (!l.batchNo.trim()) return "رقم التشغيلة";
  if (!l.expiryDate) return "تاريخ الانتهاء";
  if (l.expiryDate <= today) return "منتهي الصلاحية";
  if (toInt(l.qty) <= 0) return "الكمية";
  if (l.unitCost.trim() === "") return "سعر الشراء";
  if (toInt(l.sellPrice) <= 0) return "سعر البيع";
  return "";
}

export function PurchasingScreen({ user }: { user: User }) {
  const today = localToday();
  const canPost = user.permissions.modifyInventory;

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(today);
  const [payment, setPayment] = useState<PurchasePayment>("credit");
  const [addingSupplier, setAddingSupplier] = useState(false);

  const [lines, setLines] = useState<Line[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusBatchOf = useRef<number | null>(null);

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState<{ result: PurchaseResult; supplier: string; invoiceNo: string } | null>(null);

  useEffect(() => {
    repo.suppliers().then(setSuppliers, (e) => setError(errorText(e)));
  }, []);

  // Typed search is debounced; scans are handled on Enter.
  useEffect(() => {
    const q = query.trim();
    if (!q || looksLikeScan(q)) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        setHits(await repo.search(q, "trade"));
        setActive(0);
      } catch (e) {
        setError(errorText(e));
      }
    }, 150);
    return () => clearTimeout(t);
  }, [query]);

  // After a line is added, put the cursor in its batch field.
  useEffect(() => {
    if (focusBatchOf.current === null) return;
    document.getElementById(`pl-batch-${focusBatchOf.current}`)?.focus();
    focusBatchOf.current = null;
  }, [lines]);

  async function addLine(product: ProductHit, scan?: { batchNo?: string; expiry?: string }) {
    // Suggest the purchase price of the most recently received batch.
    let lastCost = "";
    try {
      const batches = await repo.batches(product.id);
      const latest = [...batches].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
      if (latest) lastCost = String(latest.unitCost);
    } catch {
      // No suggestion; the field stays empty.
    }
    const key = nextKey++;
    focusBatchOf.current = scan?.batchNo ? null : key;
    setLines((ls) => [
      ...ls,
      {
        key,
        product,
        batchNo: scan?.batchNo ?? "",
        expiryDate: scan?.expiry ?? "",
        qty: "",
        unitCost: lastCost,
        sellPrice: String(product.price),
      },
    ]);
    setQuery("");
    setHits([]);
    setPosted(null);
    if (scan?.batchNo) setTimeout(() => document.getElementById(`pl-qty-${key}`)?.focus(), 0);
  }

  async function handleScan(raw: string) {
    const scan = parseScan(raw);
    const code = scan.kind === "gs1" ? scan.data.gtin ?? "" : scan.code;
    const codes = scan.kind === "gs1" ? gtinLookupKeys(code) : [scan.code, ...gtinLookupKeys(scan.code).slice(1)];
    const hit = await repo.findByCode(codes);
    if (!hit) {
      setError(`باركود غير معروف: ${code}. أضف الصنف من شاشة المخزون أولاً.`);
      setQuery("");
      return;
    }
    setError("");
    await addLine(hit, scan.kind === "gs1" ? { batchNo: scan.data.batch, expiry: scan.data.expiry } : undefined);
  }

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
      else if (hits[active]) void addLine(hits[active]);
    }
  }

  function update(key: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  const supplier = suppliers.find((s) => s.id === supplierId);
  const total = lines.reduce((s, l) => s + lineTotal(l), 0);
  const units = lines.reduce((s, l) => s + toInt(l.qty), 0);
  const problems = lines.map((l) => lineProblem(l, today));
  const missing = !supplierId ? "اختر المورد" : !invoiceNo.trim() ? "أدخل رقم فاتورة الشراء" : lines.length === 0 ? "أضف صنفاً" : "";
  const incomplete = problems.filter(Boolean).length;
  const canSubmit = canPost && !busy && !missing && incomplete === 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || !supplier) return;
    setBusy(true);
    setError("");
    try {
      const result = await repo.postPurchaseInvoice({
        supplierId,
        supplierInvoiceNo: invoiceNo,
        invoiceDate,
        payment,
        lines: lines.map((l) => ({
          productId: l.product.id,
          batchNo: l.batchNo,
          expiryDate: l.expiryDate,
          qty: toInt(l.qty),
          unitCost: toInt(l.unitCost),
          sellPrice: toInt(l.sellPrice),
        })),
      });
      setPosted({ result, supplier: supplier.name, invoiceNo: invoiceNo.trim() });
      setLines([]);
      setInvoiceNo("");
      setSuppliers(await repo.suppliers()); // new balance
      searchRef.current?.focus();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!canPost) {
    return (
      <main className="pur">
        <section className="panel pur-panel">
          <div className="inv-head">
            <h2>المشتريات</h2>
          </div>
          <p className="empty-note">إدخال فواتير الشراء يتطلب صلاحية تعديل المخزون.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="pur">
      <form
        className="panel pur-panel"
        onSubmit={submit}
        aria-labelledby="pur-title"
        // Enter in a field (a scanner sends one after every code) must never post the invoice; only the button does.
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") e.preventDefault();
        }}
      >
        <div className="inv-head">
          <h2 id="pur-title">فاتورة شراء جديدة</h2>
          <span className="muted">استلام بضاعة من المورد وإضافتها للمخزون</span>
        </div>

        <div className="pur-header">
          <Field id="pur-supplier" label="المورد">
            <div className="field-row">
              <select id="pur-supplier" className="field" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">اختر المورد…</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <button type="button" className="btn" onClick={() => setAddingSupplier(true)}>+ مورد</button>
            </div>
          </Field>
          <Field id="pur-no" label="رقم فاتورة الشراء">
            <input id="pur-no" className="field num" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} autoComplete="off" />
          </Field>
          <Field id="pur-date" label="تاريخ الفاتورة">
            <input id="pur-date" type="date" className="field num" max={today} value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </Field>
          <div className="form-field">
            <span className="label" id="pur-pay-label">حالة الدفع</span>
            <div role="radiogroup" aria-labelledby="pur-pay-label" className="seg">
              {(Object.keys(PAYMENT_LABEL) as PurchasePayment[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={payment === p}
                  className={`seg-btn ${payment === p ? "on" : ""}`}
                  onClick={() => setPayment(p)}
                >
                  {PAYMENT_LABEL[p]}
                </button>
              ))}
            </div>
          </div>
          {supplier && (
            <p className="pur-supplier-note muted small">
              {payment === "credit"
                ? <>يُستحق السداد في <bdi className="num">{addDays(invoiceDate || today, supplier.paymentTermsDays)}</bdi> ({supplier.paymentTermsDays} يوماً) · </>
                : <>يُسدَّد عند الاستلام · </>}
              الرصيد الحالي للمورد <bdi className="num">{formatIqd(supplier.balance)}</bdi> د.ع
            </p>
          )}
        </div>

        <div className="pur-search">
          <div className="search-box">
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20 L16 16" />
            </svg>
            <input
              id="pur-search"
              ref={searchRef}
              aria-label="إضافة صنف للفاتورة"
              value={query}
              autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              placeholder="امسح باركود العبوة أو اكتب اسم الصنف"
              role="combobox"
              aria-expanded={hits.length > 0}
              aria-controls="pur-results"
            />
          </div>
          {hits.length > 0 && (
            <ul id="pur-results" className="pur-results" role="listbox">
              {hits.map((h, i) => (
                <li key={h.id} role="option" aria-selected={i === active}>
                  <button type="button" className={i === active ? "active" : ""} onMouseEnter={() => setActive(i)} onClick={() => void addLine(h)}>
                    <bdi className="strong">{h.tradeName}</bdi>
                    <span className="muted small"> · {h.form} · المخزون {h.stock} · سعر البيع {formatIqd(h.price)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <span className="muted small">مسح باركود GS1 يملأ رقم التشغيلة وتاريخ الانتهاء تلقائياً.</span>
        </div>

        {error && (
          <div role="alert" className="banner error">
            <span>{error}</span>
            <button type="button" className="link-btn" onClick={() => setError("")} aria-label="إغلاق التنبيه">×</button>
          </div>
        )}
        {posted && (
          <div role="status" className="banner success">
            <span>
              تم ترحيل الفاتورة <bdi className="num">{posted.invoiceNo}</bdi> من {posted.supplier} · الإجمالي{" "}
              <bdi className="num">{formatIqd(posted.result.total)}</bdi> د.ع · <bdi className="num">{posted.result.units}</bdi> وحدة ·
              دفعات جديدة {posted.result.batchesCreated}، مضافة لدفعات موجودة {posted.result.batchesUpdated}
              {posted.result.priceChanges.length > 0 && <> · تغيّر سعر البيع: {posted.result.priceChanges.join("، ")}</>}
              {posted.result.dueDate && <> · يُستحق <bdi className="num">{posted.result.dueDate}</bdi></>}
              . المخزون متاح للبيع الآن.
            </span>
          </div>
        )}

        <div className="table-wrap">
          <table className="cart pur-table">
            <thead>
              <tr>
                <th>الصنف</th>
                <th>رقم التشغيلة</th>
                <th>تاريخ الانتهاء</th>
                <th>الكمية</th>
                <th>سعر الشراء</th>
                <th>سعر البيع</th>
                <th>إجمالي السطر</th>
                <th><span className="sr-only">حذف</span></th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">لا توجد أصناف بعد — امسح باركود عبوة أو ابحث عن الصنف</td>
                </tr>
              )}
              {lines.map((l, i) => {
                const cost = toInt(l.unitCost);
                const sell = toInt(l.sellPrice);
                const margin = cost > 0 && sell > 0 ? Math.round(((sell - cost) / sell) * 100) : null;
                const name = l.product.tradeName;
                return (
                  <tr key={l.key} className={problems[i] ? "incomplete" : ""}>
                    <td>
                      <div className="strong"><bdi>{name}</bdi></div>
                      <div className="muted small">
                        {l.product.form} · <bdi>{l.product.strength}</bdi>
                        {problems[i] && <span className="tag warn">ينقص: {problems[i]}</span>}
                      </div>
                    </td>
                    <td>
                      <input
                        id={`pl-batch-${l.key}`}
                        aria-label={`رقم تشغيلة ${name}`}
                        className="small-input num"
                        value={l.batchNo}
                        onChange={(e) => update(l.key, { batchNo: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        type="date"
                        aria-label={`تاريخ انتهاء ${name}`}
                        className="small-input num date-input"
                        min={addDays(today, 1)}
                        value={l.expiryDate}
                        onChange={(e) => update(l.key, { expiryDate: e.target.value })}
                      />
                      {l.expiryDate && <div><ExpiryTag date={l.expiryDate} today={today} /></div>}
                    </td>
                    <td>
                      <input
                        id={`pl-qty-${l.key}`}
                        aria-label={`كمية ${name}`}
                        className="small-input num"
                        inputMode="numeric"
                        value={l.qty}
                        placeholder="0"
                        onChange={(e) => update(l.key, { qty: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`سعر شراء ${name}`}
                        className="small-input num"
                        inputMode="numeric"
                        value={l.unitCost}
                        placeholder="0"
                        onChange={(e) => update(l.key, { unitCost: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`سعر بيع ${name}`}
                        className="small-input num"
                        inputMode="numeric"
                        value={l.sellPrice}
                        onChange={(e) => update(l.key, { sellPrice: e.target.value })}
                      />
                      <div className="small">
                        {sell !== l.product.price && sell > 0 && (
                          <span className="tag info" title={`السعر الحالي ${formatIqd(l.product.price)}`}>سعر جديد</span>
                        )}
                        {margin !== null &&
                          (margin < 0 ? <span className="tag bad">أقل من الكلفة</span> : <span className="muted">هامش {margin}٪</span>)}
                      </div>
                    </td>
                    <td className="num strong">{formatIqd(lineTotal(l))}</td>
                    <td>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`حذف ${name}`}
                        onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M6 6 L18 18 M18 6 L6 18" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="pur-foot">
          <div className="pur-totals">
            <span>الأسطر <bdi className="num strong">{lines.length}</bdi></span>
            <span>الوحدات <bdi className="num strong">{units}</bdi></span>
            <span className="pur-total">
              إجمالي الفاتورة <bdi className="num big">{formatIqd(total)}</bdi> <span className="muted">د.ع</span>
            </span>
          </div>
          <div className="pur-submit">
            {(missing || incomplete > 0) && (
              <span className="muted small">{missing || `أكمل ${incomplete} ${incomplete === 1 ? "سطراً" : "أسطر"}`}</span>
            )}
            <button type="submit" className="complete" disabled={!canSubmit}>
              {busy ? "جارٍ الترحيل…" : `ترحيل الفاتورة (${PAYMENT_LABEL[payment]})`}
            </button>
          </div>
        </div>
      </form>

      {addingSupplier && (
        <AddSupplierDialog
          onClose={() => setAddingSupplier(false)}
          onSaved={(s) => {
            setSuppliers((all) => [...all, s].sort((a, b) => a.name.localeCompare(b.name)));
            setSupplierId(s.id);
            setAddingSupplier(false);
          }}
        />
      )}
    </main>
  );
}

function AddSupplierDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (s: Supplier) => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [terms, setTerms] = useState("30");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSaved(await repo.addSupplier({ name, phone: phone || undefined, paymentTermsDays: toInt(terms) }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="مورد جديد" onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        {error && <div role="alert" className="banner error"><span>{error}</span></div>}
        <div className="form-grid">
          <Field id="ns-name" label="اسم المورد *">
            <input id="ns-name" className="field" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
          </Field>
          <Field id="ns-phone" label="الهاتف">
            <input id="ns-phone" className="field num" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field id="ns-terms" label="مدة السداد (يوم)" hint="لفواتير الآجل">
            <input id="ns-terms" className="field num" inputMode="numeric" value={terms} onChange={(e) => setTerms(e.target.value)} />
          </Field>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>إلغاء</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "جارٍ الحفظ…" : "حفظ المورد"}</button>
        </div>
      </form>
    </Modal>
  );
}
