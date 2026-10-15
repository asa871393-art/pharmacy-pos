import { useEffect, useState, type FormEvent } from "react";
import { addDays, daysBetween, DEFAULT_THRESHOLDS } from "../core/fefo.ts";
import { formatIqd } from "../core/totals.ts";
import type { Category, DeviceInfo, InventoryBatch, InventoryItem, User } from "../core/types.ts";
import { localToday, repo } from "../data/index.ts";
import { ExpiryTag } from "../pos/ExpiryTag.tsx";
import { errorText, Field, Modal, toInt } from "../ui/Modal.tsx";
import { TransfersPanel } from "./TransfersPanel.tsx";

type Filter = "all" | "low" | "expiring" | "expired" | "out";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "الكل" },
  { id: "low", label: "مخزون منخفض" },
  { id: "expiring", label: "قريب الانتهاء" },
  { id: "expired", label: "فيه منتهي" },
  { id: "out", label: "نفد" },
];

const FORMS = ["قرص", "كبسول", "شراب", "حقن", "بخاخ", "كريم", "مرهم", "قطرة", "تحاميل", "أكياس"];

const isOut = (i: InventoryItem) => i.stock === 0;
const isLow = (i: InventoryItem) => isOut(i) || (i.reorderLevel !== null && i.stock <= i.reorderLevel);
const isExpiring = (i: InventoryItem, today: string) =>
  i.nearestExpiry !== null && daysBetween(today, i.nearestExpiry) <= DEFAULT_THRESHOLDS.warning;

function matchesFilter(i: InventoryItem, f: Filter, today: string): boolean {
  switch (f) {
    case "low":
      return isLow(i);
    case "expiring":
      return isExpiring(i, today);
    case "expired":
      return i.expiredQty > 0;
    case "out":
      return isOut(i);
    default:
      return true;
  }
}

/** Stock of this device's branch (`device.branch`), and transfers to and from the other branches. */
export function InventoryScreen({ user, device }: { user: User; device: DeviceInfo }) {
  const today = localToday();
  const canEdit = user.permissions.modifyInventory;
  const [tab, setTab] = useState<"stock" | "transfers">("stock");
  const [items, setItems] = useState<InventoryItem[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<InventoryItem | null>(null);
  const [selected, setSelected] = useState<InventoryItem | null>(null);

  const reload = () => repo.inventory().then(setItems, (e) => setError(errorText(e)));
  useEffect(() => {
    void reload();
  }, []);

  function upsert(item: InventoryItem) {
    setItems((all) => {
      const rest = (all ?? []).filter((i) => i.id !== item.id);
      return [...rest, item].sort((a, b) => a.tradeName.localeCompare(b.tradeName));
    });
  }

  const q = query.trim().toLowerCase();
  const searched = (items ?? []).filter(
    (i) =>
      !q ||
      i.tradeName.toLowerCase().includes(q) ||
      (i.tradeNameAr ?? "").includes(q) ||
      (i.barcode ?? "").includes(q),
  );
  const shown = searched.filter((i) => matchesFilter(i, filter, today));

  return (
    <main className="inv">
      <section className="panel inv-panel" aria-labelledby="inv-title">
        <div className="inv-head">
          <h2 id="inv-title">المخزون · {device.branch.name}</h2>
          {canEdit && (
            <div role="tablist" aria-label="أقسام المخزون" className="chips">
              <button type="button" role="tab" className={`chip ${tab === "stock" ? "on" : ""}`} aria-selected={tab === "stock"} onClick={() => setTab("stock")}>
                الأصناف
              </button>
              <button type="button" role="tab" className={`chip ${tab === "transfers" ? "on" : ""}`} aria-selected={tab === "transfers"} onClick={() => setTab("transfers")}>
                التحويل بين الفروع
              </button>
            </div>
          )}
          <span className="muted">{items ? `${items.length} صنف` : "جارٍ التحميل…"}</span>
          {canEdit && tab === "stock" && (
            <button type="button" className="btn primary" onClick={() => setAdding(true)}>
              + صنف جديد
            </button>
          )}
        </div>
        {tab === "transfers" ? (
          <TransfersPanel device={device} items={items ?? []} onStockChanged={() => void reload()} />
        ) : (
          <>
            <div className="inv-tools">
              <div className="search-box">
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M20 20 L16 16" />
                </svg>
                <input
                  id="inv-search"
                  aria-label="بحث في المخزون"
                  value={query}
                  autoComplete="off"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                  placeholder="اسم الصنف أو الباركود"
                />
              </div>
              <div role="group" aria-label="تصفية" className="chips">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={`chip ${filter === f.id ? "on" : ""}`}
                    aria-pressed={filter === f.id}
                    onClick={() => setFilter(f.id)}
                  >
                    {f.label} <span className="num">{searched.filter((i) => matchesFilter(i, f.id, today)).length}</span>
                  </button>
                ))}
              </div>
            </div>
            {error && (
              <div role="alert" className="banner error">
                <span>{error}</span>
              </div>
            )}
            <div className="table-wrap">
              <table className="cart inv-table">
                <thead>
                  <tr>
                    <th>الباركود</th>
                    <th>الصنف</th>
                    <th>التصنيف</th>
                    <th>المخزون</th>
                    <th>سعر البيع</th>
                    <th>أقرب انتهاء (FEFO)</th>
                    <th>
                      <span className="sr-only">الدفعات</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items && shown.length === 0 && (
                    <tr>
                      <td colSpan={7} className="empty">
                        {items.length === 0 ? "لا توجد أصناف بعد" : "لا توجد أصناف تطابق البحث أو التصفية"}
                      </td>
                    </tr>
                  )}
                  {shown.map((i) => (
                    <tr key={i.id} onClick={() => setSelected(i)} className="clickable">
                      <td>{i.barcode ? <bdi className="num">{i.barcode}</bdi> : <span className="muted">—</span>}</td>
                      <td>
                        <div className="strong">
                          <bdi>{i.tradeName}</bdi>
                          {i.requiresRx && <span className="tag info">وصفة</span>}
                        </div>
                        <div className="muted small">
                          {i.tradeNameAr && <><bdi>{i.tradeNameAr}</bdi> · </>}
                          {i.form} · <bdi>{i.strength}</bdi> · عبوة {i.packSize}
                        </div>
                      </td>
                      <td>{i.category ?? <span className="muted">—</span>}</td>
                      <td>
                        <div className="stock-cell">
                          <bdi className="num strong">{i.stock}</bdi>
                          {isOut(i) ? (
                            <span className="tag bad">نفد</span>
                          ) : isLow(i) ? (
                            <span className="tag warn" title={`حد إعادة الطلب ${i.reorderLevel}`}>منخفض</span>
                          ) : null}
                          {i.expiredQty > 0 && <span className="tag bad">منتهي {i.expiredQty}</span>}
                        </div>
                      </td>
                      <td className="num">{formatIqd(i.price)}</td>
                      <td>{i.nearestExpiry ? <ExpiryTag date={i.nearestExpiry} today={today} /> : <span className="muted">—</span>}</td>
                      <td>
                        <button
                          type="button"
                          className="link-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(i);
                          }}
                        >
                          {canEdit ? "الدفعات والكميات" : "الدفعات"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="cart-foot">
              {canEdit
                ? "اضغط على صنف لعرض دفعاته، واستلام دفعة جديدة، أو تصحيح الكمية بعد الجرد."
                : "عرض فقط: ليست لديك صلاحية تعديل المخزون."}
            </div>
          </>
        )}
      </section>

      {adding && (
        <ProductDialog
          onClose={() => setAdding(false)}
          onSaved={(item) => {
            upsert(item);
            setAdding(false);
            setSelected(item); // straight on to receiving its first batch
          }}
        />
      )}
      {editing && (
        <ProductDialog
          item={editing}
          onClose={() => {
            setSelected(editing);
            setEditing(null);
          }}
          onSaved={(item) => {
            upsert(item);
            setEditing(null);
            setSelected(item);
          }}
        />
      )}
      {selected && (
        <BatchesDialog
          item={selected}
          canEdit={canEdit}
          today={today}
          onClose={() => setSelected(null)}
          onEdit={() => {
            setEditing(selected);
            setSelected(null);
          }}
          onChanged={(item) => {
            upsert(item);
            setSelected(item);
          }}
        />
      )}
    </main>
  );
}

// ── Dialogs ──

/** Adds a product, or edits `item`. Edits are audit-logged field by field, with the price change as its own entry. */
function ProductDialog({
  item,
  onClose,
  onSaved,
}: {
  item?: InventoryItem;
  onClose: () => void;
  onSaved: (item: InventoryItem) => void;
}) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [f, setF] = useState({
    tradeName: item?.tradeName ?? "",
    tradeNameAr: item?.tradeNameAr ?? "",
    categoryId: item?.categoryId ?? "",
    dosageForm: item?.form ?? "قرص",
    strength: item?.strength ?? "",
    packSize: String(item?.packSize ?? 1),
    price: item ? String(item.price) : "",
    barcode: item?.barcode ?? "",
    reorderLevel: item?.reorderLevel != null ? String(item.reorderLevel) : "",
    requiresRx: item?.requiresRx ?? false,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    repo.categories().then(setCategories, (e) => setError(errorText(e)));
  }, []);

  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const product = {
      tradeName: f.tradeName,
      tradeNameAr: f.tradeNameAr || undefined,
      categoryId: f.categoryId || undefined,
      dosageForm: f.dosageForm,
      strength: f.strength,
      packSize: toInt(f.packSize),
      price: toInt(f.price),
      requiresRx: f.requiresRx,
      barcode: f.barcode || undefined,
      reorderLevel: f.reorderLevel ? toInt(f.reorderLevel) : undefined,
    };
    try {
      onSaved(await (item ? repo.updateProduct(item.id, product) : repo.addProduct(product)));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={item ? `تعديل بيانات ${item.tradeName}` : "صنف جديد"} onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        {error && <div role="alert" className="banner error"><span>{error}</span></div>}
        <div className="form-grid">
          <Field id="np-name" label="الاسم التجاري *">
            <input id="np-name" className="field" value={f.tradeName} onChange={set("tradeName")} autoFocus required />
          </Field>
          <Field id="np-name-ar" label="الاسم بالعربية">
            <input id="np-name-ar" className="field" value={f.tradeNameAr} onChange={set("tradeNameAr")} />
          </Field>
          <Field id="np-form" label="الشكل الدوائي *">
            <input id="np-form" className="field" list="np-forms" value={f.dosageForm} onChange={set("dosageForm")} required />
            <datalist id="np-forms">
              {FORMS.map((x) => <option key={x} value={x} />)}
            </datalist>
          </Field>
          <Field id="np-strength" label="التركيز *">
            <input id="np-strength" className="field" dir="ltr" placeholder="500 mg" value={f.strength} onChange={set("strength")} required />
          </Field>
          <Field id="np-pack" label="حجم العبوة">
            <input id="np-pack" className="field num" inputMode="numeric" value={f.packSize} onChange={set("packSize")} />
          </Field>
          <Field id="np-price" label="سعر البيع (د.ع) *" hint={item ? "تغيير السعر يُسجَّل في سجل التدقيق" : undefined}>
            <input id="np-price" className="field num" inputMode="numeric" value={f.price} onChange={set("price")} required />
          </Field>
          <Field id="np-cat" label="التصنيف">
            <select id="np-cat" className="field" value={f.categoryId} onChange={set("categoryId")}>
              <option value="">بدون تصنيف</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
            </select>
          </Field>
          <Field id="np-barcode" label="الباركود" hint={item ? "٨ إلى ١٤ رقماً؛ إفراغه يحذف الباركود" : "٨ إلى ١٤ رقماً"}>
            <input id="np-barcode" className="field num" inputMode="numeric" value={f.barcode} onChange={set("barcode")} />
          </Field>
          <Field id="np-reorder" label="حد إعادة الطلب" hint="يظهر الصنف «منخفض» عند بلوغه؛ اتركه فارغاً بلا حد">
            <input id="np-reorder" className="field num" inputMode="numeric" value={f.reorderLevel} onChange={set("reorderLevel")} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={f.requiresRx} onChange={(e) => setF({ ...f, requiresRx: e.target.checked })} />
          يُصرف بوصفة طبية فقط
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>إلغاء</button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? "جارٍ الحفظ…" : item ? "حفظ التعديلات" : "حفظ الصنف"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function BatchesDialog({
  item,
  canEdit,
  today,
  onClose,
  onEdit,
  onChanged,
}: {
  item: InventoryItem;
  canEdit: boolean;
  today: string;
  onClose: () => void;
  onEdit: () => void;
  onChanged: (item: InventoryItem) => void;
}) {
  const [batches, setBatches] = useState<InventoryBatch[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<{ id: string; qty: string; reason: string } | null>(null);
  const [rcv, setRcv] = useState({ batchNo: "", expiryDate: "", qty: "", unitCost: "" });
  const [busy, setBusy] = useState(false);

  const load = () => repo.inventoryBatches(item.id).then(setBatches, (e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, [item.id]);

  async function run(action: () => Promise<InventoryItem>, done: string) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      onChanged(await action());
      await load();
      setNotice(done);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveAdjust(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const ok = await run(
      () => repo.adjustBatch({ batchId: editing.id, newQty: toInt(editing.qty), reason: editing.reason }),
      "تم تعديل الكمية وتسجيل الحركة",
    );
    if (ok) setEditing(null);
  }

  async function receive(e: FormEvent) {
    e.preventDefault();
    const ok = await run(
      () =>
        repo.receiveBatch({
          productId: item.id,
          batchNo: rcv.batchNo,
          expiryDate: rcv.expiryDate,
          qty: toInt(rcv.qty),
          unitCost: toInt(rcv.unitCost),
        }),
      `تم استلام الدفعة ${rcv.batchNo.trim()}`,
    );
    if (ok) setRcv({ batchNo: "", expiryDate: "", qty: "", unitCost: "" });
  }

  return (
    <Modal title={item.tradeName} onClose={onClose} wide>
      <div className="modal-body">
        <div className="batch-summary">
          <span>المتوفر للبيع <bdi className="num strong">{item.stock}</bdi></span>
          {item.expiredQty > 0 && <span className="tag bad">منتهي على الرف {item.expiredQty}</span>}
          {item.reorderLevel !== null && <span className="muted">حد إعادة الطلب <bdi className="num">{item.reorderLevel}</bdi></span>}
          <span className="muted">سعر البيع <bdi className="num">{formatIqd(item.price)}</bdi> د.ع</span>
          {canEdit && (
            <button type="button" className="btn" onClick={onEdit}>
              تعديل بيانات الصنف والسعر
            </button>
          )}
        </div>
        {error && <div role="alert" className="banner error"><span>{error}</span></div>}
        {notice && <div role="status" className="banner success"><span>{notice}</span></div>}

        <div className="table-wrap">
          <table className="cart">
            <thead>
              <tr>
                <th>الدفعة</th>
                <th>الانتهاء</th>
                <th>الكمية</th>
                <th>تكلفة الوحدة</th>
                {canEdit && <th><span className="sr-only">تعديل</span></th>}
              </tr>
            </thead>
            <tbody>
              {batches && batches.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">لا توجد دفعات فيها كمية</td>
                </tr>
              )}
              {batches?.map((b) =>
                editing?.id === b.id ? (
                  <tr key={b.id}>
                    <td colSpan={5}>
                      <form className="adjust-form" onSubmit={saveAdjust}>
                        <span>
                          <bdi className="num strong">{b.batchNo}</bdi> · الحالية <bdi className="num">{b.qtyOnHand}</bdi>
                        </span>
                        <label className="sr-only" htmlFor="adj-qty">الكمية بعد الجرد</label>
                        <input
                          id="adj-qty"
                          className="small-input num"
                          inputMode="numeric"
                          value={editing.qty}
                          autoFocus
                          onChange={(e) => setEditing({ ...editing, qty: e.target.value })}
                        />
                        <label className="sr-only" htmlFor="adj-reason">السبب</label>
                        <input
                          id="adj-reason"
                          className="small-input reason"
                          placeholder="السبب: جرد، تالف، إتلاف منتهي…"
                          value={editing.reason}
                          onChange={(e) => setEditing({ ...editing, reason: e.target.value })}
                        />
                        <button type="submit" className="btn primary" disabled={busy}>حفظ</button>
                        <button type="button" className="btn" onClick={() => setEditing(null)}>إلغاء</button>
                      </form>
                    </td>
                  </tr>
                ) : (
                  <tr key={b.id}>
                    <td><bdi className="num">{b.batchNo}</bdi></td>
                    <td><ExpiryTag date={b.expiryDate} today={today} /></td>
                    <td className="num strong">{b.qtyOnHand}</td>
                    <td className="num">{formatIqd(b.unitCost)}</td>
                    {canEdit && (
                      <td>
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => setEditing({ id: b.id, qty: String(b.qtyOnHand), reason: "" })}
                        >
                          تعديل الكمية
                        </button>
                      </td>
                    )}
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>

        {canEdit && (
          <form className="receive-form" onSubmit={receive}>
            <h4>استلام دفعة جديدة</h4>
            <div className="form-grid four">
              <Field id="rc-batch" label="رقم الدفعة">
                <input id="rc-batch" className="field num" value={rcv.batchNo} onChange={(e) => setRcv({ ...rcv, batchNo: e.target.value })} required />
              </Field>
              <Field id="rc-exp" label="تاريخ الانتهاء">
                <input
                  id="rc-exp"
                  type="date"
                  className="field num"
                  min={addDays(today, 1)}
                  value={rcv.expiryDate}
                  onChange={(e) => setRcv({ ...rcv, expiryDate: e.target.value })}
                  required
                />
              </Field>
              <Field id="rc-qty" label="الكمية">
                <input id="rc-qty" className="field num" inputMode="numeric" value={rcv.qty} onChange={(e) => setRcv({ ...rcv, qty: e.target.value })} required />
              </Field>
              <Field id="rc-cost" label="تكلفة الوحدة (د.ع)">
                <input id="rc-cost" className="field num" inputMode="numeric" value={rcv.unitCost} onChange={(e) => setRcv({ ...rcv, unitCost: e.target.value })} required />
              </Field>
            </div>
            <div className="modal-actions">
              <button type="submit" className="btn primary" disabled={busy}>استلام</button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
