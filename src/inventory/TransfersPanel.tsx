// Stock transfers between branches, under Inventory. This branch can ship stock to another branch (taken FEFO from
// its own batches), ask another branch for stock, ship what another branch asked for, and receive what was shipped
// to it. Every step is saved on this device first and synced like any other change.

import { Fragment, useEffect, useState, type FormEvent } from "react";
import type { DeviceInfo, InventoryItem, Transfer, TransferLine, TransferStatus } from "../core/types.ts";
import { repo } from "../data/index.ts";
import { errorText, Field, Modal, toInt } from "../ui/Modal.tsx";

const STATUS: Record<TransferStatus, { label: string; tone: string }> = {
  requested: { label: "طلب بانتظار الشحن", tone: "info" },
  shipped: { label: "في الطريق", tone: "warn" },
  received: { label: "مستلم", tone: "ok" },
  cancelled: { label: "ملغى", tone: "" },
};

/** The step this branch can take next on a transfer, if any. */
function nextStep(t: Transfer): "ship" | "receive" | null {
  if (t.status === "requested" && t.direction === "out") return "ship";
  if (t.status === "shipped" && t.direction === "in") return "receive";
  return null;
}

export function TransfersPanel({
  device,
  items,
  onStockChanged,
}: {
  device: DeviceInfo;
  /** This branch's inventory: the products to pick from, with what is on the shelf here. */
  items: InventoryItem[];
  onStockChanged: () => void;
}) {
  const [transfers, setTransfers] = useState<Transfer[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ mode: "ship" | "request"; request?: Transfer } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const others = device.branches.filter((b) => b.active && b.id !== device.branch.id);

  const load = () => repo.transfers().then(setTransfers, (e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, []);

  function replace(t: Transfer) {
    setTransfers((all) => [t, ...(all ?? []).filter((x) => x.id !== t.id)]);
  }

  async function act(t: Transfer, action: "receive" | "cancel") {
    setError("");
    setNotice("");
    setBusy(t.id);
    try {
      if (action === "receive") {
        replace(await repo.receiveTransfer(t.id));
        setNotice(`استُلم التحويل ${t.transferNo}: ${t.units} وحدة أُضيفت إلى مخزون ${device.branch.name}.`);
        onStockChanged();
      } else {
        replace(await repo.cancelTransfer(t.id));
        setNotice(`أُلغي الطلب ${t.transferNo}.`);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const waiting = (transfers ?? []).filter((t) => nextStep(t) !== null).length;

  return (
    <>
      <div className="inv-tools transfer-tools">
        <span className="muted">
          {transfers === null
            ? "جارٍ التحميل…"
            : waiting > 0
              ? `${waiting} تحويل بانتظار إجراء من ${device.branch.name}`
              : "لا تحويلات بانتظار إجراء"}
        </span>
        <div className="transfer-actions">
          <button type="button" className="btn" disabled={others.length === 0} onClick={() => setDialog({ mode: "request" })}>
            طلب مخزون من فرع
          </button>
          <button type="button" className="btn primary" disabled={others.length === 0} onClick={() => setDialog({ mode: "ship" })}>
            شحن إلى فرع
          </button>
        </div>
      </div>
      {others.length === 0 && (
        <div className="banner info">
          <span>لا يوجد فرع آخر بعد. يضيف المدير الفروع من شاشة الموظفين ← الفروع، وتصل إلى الأجهزة الأخرى بالمزامنة.</span>
        </div>
      )}
      {error && (
        <div role="alert" className="banner error">
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div role="status" className="banner success">
          <span>{notice}</span>
        </div>
      )}
      <div className="table-wrap">
        <table className="cart inv-table">
          <thead>
            <tr>
              <th>رقم التحويل</th>
              <th>الاتجاه</th>
              <th>الحالة</th>
              <th>الوحدات</th>
              <th>آخر خطوة</th>
              <th>
                <span className="sr-only">إجراء</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {transfers && transfers.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  لا توجد تحويلات لهذا الفرع بعد
                </td>
              </tr>
            )}
            {(transfers ?? []).map((t) => {
              const step = nextStep(t);
              const last =
                t.receivedAt ? `استلمه ${t.receivedBy ?? "—"} · ${t.receivedAt}`
                : t.shippedAt ? `شحنه ${t.shippedBy ?? "—"} · ${t.shippedAt}`
                : t.requestedAt ? `طلبه ${t.requestedBy ?? "—"} · ${t.requestedAt}`
                : "—";
              return (
                <Fragment key={t.id}>
                  <tr className="clickable" onClick={() => setOpen(open === t.id ? null : t.id)} aria-expanded={open === t.id}>
                    <td>
                      <bdi className="num strong">{t.transferNo}</bdi>
                    </td>
                    <td>{t.direction === "out" ? `صادر إلى ${t.toBranch}` : `وارد من ${t.fromBranch}`}</td>
                    <td>
                      <span className={`tag ${STATUS[t.status].tone}`}>{STATUS[t.status].label}</span>
                    </td>
                    <td className="num">{t.units}</td>
                    <td className="muted small">{last}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {step === "receive" && (
                        <button type="button" className="btn primary" disabled={busy === t.id} onClick={() => void act(t, "receive")}>
                          استلام
                        </button>
                      )}
                      {step === "ship" && (
                        <button type="button" className="btn primary" onClick={() => setDialog({ mode: "ship", request: t })}>
                          شحن الطلب
                        </button>
                      )}
                      {t.status === "requested" && (
                        <button
                          type="button"
                          className="link-btn danger"
                          disabled={busy === t.id}
                          onClick={() => void act(t, "cancel")}
                        >
                          {t.direction === "in" ? "سحب الطلب" : "رفض الطلب"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {open === t.id && (
                    <tr className="transfer-detail">
                      <td colSpan={6}>
                        {t.note && <p className="muted">ملاحظة: {t.note}</p>}
                        <ul>
                          {t.items.map((i, n) => (
                            <li key={n}>
                              <bdi>{i.product}</bdi>
                              {i.qty > 0 ? (
                                <>
                                  {" "}
                                  · <span className="num">{i.qty}</span> وحدة · الدفعة <bdi className="num">{i.batchNo}</bdi> · تنتهي{" "}
                                  <bdi className="num">{i.expiryDate}</bdi>
                                </>
                              ) : (
                                <>
                                  {" "}
                                  · مطلوب <span className="num">{i.requestedQty}</span>
                                </>
                              )}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="cart-foot">
        الشحن يخصم الكمية من دفعات هذا الفرع فوراً (الأقرب انتهاءً أولاً)، والاستلام يضيفها إلى الفرع المستلم بنفس رقم الدفعة وتاريخ
        الانتهاء والتكلفة.
      </div>

      {dialog && (
        <TransferDialog
          mode={dialog.mode}
          request={dialog.request}
          device={device}
          items={items}
          onClose={() => setDialog(null)}
          onDone={(t) => {
            replace(t);
            setDialog(null);
            setNotice(
              t.status === "shipped"
                ? `شُحن التحويل ${t.transferNo} إلى ${t.toBranch}: ${t.units} وحدة خرجت من مخزون هذا الفرع.`
                : `أُرسل الطلب ${t.transferNo} إلى ${t.fromBranch}.`,
            );
            if (t.status === "shipped") onStockChanged();
          }}
        />
      )}
    </>
  );
}

/** A new shipment, a request, or shipping a request another branch made (its lines come pre-filled). */
function TransferDialog({
  mode,
  request,
  device,
  items,
  onClose,
  onDone,
}: {
  mode: "ship" | "request";
  request?: Transfer;
  device: DeviceInfo;
  items: InventoryItem[];
  onClose: () => void;
  onDone: (t: Transfer) => void;
}) {
  const others = device.branches.filter((b) => b.active && b.id !== device.branch.id);
  const [branchId, setBranchId] = useState(others[0]?.id ?? "");
  const [lines, setLines] = useState<TransferLine[]>(
    request ? request.items.filter((i) => i.requestedQty > 0).map((i) => ({ productId: i.productId, qty: i.requestedQty })) : [],
  );
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const shipping = mode === "ship";
  const product = (id: string) => items.find((i) => i.id === id);
  const choices = items.filter((i) => !lines.some((l) => l.productId === i.id) && (!shipping || i.stock > 0));

  function add() {
    const n = toInt(qty);
    if (!productId || n <= 0) return setError("اختر الصنف وأدخل كمية أكبر من صفر");
    setError("");
    setLines([...lines, { productId, qty: n }]);
    setProductId("");
    setQty("");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const t = shipping
        ? await repo.shipTransfer({
            transferId: request?.id,
            toBranchId: request ? undefined : branchId,
            note: note || undefined,
            lines,
          })
        : await repo.requestTransfer({ fromBranchId: branchId, note: note || undefined, lines });
      onDone(t);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const title = request
    ? `شحن الطلب ${request.transferNo} إلى ${request.toBranch}`
    : shipping
      ? `شحن من ${device.branch.name} إلى فرع آخر`
      : `طلب مخزون إلى ${device.branch.name}`;

  return (
    <Modal title={title} onClose={onClose} wide>
      <form className="modal-body" onSubmit={submit}>
        {error && (
          <div role="alert" className="banner error">
            <span>{error}</span>
          </div>
        )}
        {!request && (
          <Field id="tr-branch" label={shipping ? "الفرع المستلم" : "الفرع المطلوب منه"}>
            <select id="tr-branch" className="field" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              {others.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code})
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="form-grid">
          <Field id="tr-product" label="الصنف">
            <select id="tr-product" className="field" value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">اختر صنفاً…</option>
              {choices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.tradeName} — المتوفر هنا {i.stock}
                </option>
              ))}
            </select>
          </Field>
          <Field id="tr-qty" label="الكمية">
            <div className="field-row">
              <input
                id="tr-qty"
                className="field num"
                inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
              />
              <button type="button" className="btn" onClick={add}>
                إضافة
              </button>
            </div>
          </Field>
        </div>
        <div className="table-wrap">
          <table className="cart">
            <thead>
              <tr>
                <th>الصنف</th>
                <th>{shipping ? "المتوفر هنا" : "المتوفر في هذا الفرع"}</th>
                <th>الكمية</th>
                <th>
                  <span className="sr-only">حذف</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    أضف الأصناف والكميات
                  </td>
                </tr>
              )}
              {lines.map((l, n) => {
                const p = product(l.productId);
                const short = shipping && p !== undefined && l.qty > p.stock;
                return (
                  <tr key={l.productId}>
                    <td>
                      <bdi>{p?.tradeName ?? request?.items.find((i) => i.productId === l.productId)?.product ?? l.productId}</bdi>
                    </td>
                    <td className="num">
                      {p?.stock ?? 0} {short && <span className="tag bad">لا يكفي</span>}
                    </td>
                    <td>
                      <input
                        aria-label="الكمية"
                        className="field num qty-input"
                        inputMode="numeric"
                        value={String(l.qty)}
                        onChange={(e) => setLines(lines.map((x, k) => (k === n ? { ...x, qty: toInt(e.target.value) } : x)))}
                      />
                    </td>
                    <td>
                      <button type="button" className="link-btn danger" onClick={() => setLines(lines.filter((_, k) => k !== n))}>
                        حذف
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Field id="tr-note" label="ملاحظة">
          <input id="tr-note" className="field" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <p className="muted small">
          {shipping
            ? "تُخصم الكمية من دفعات هذا الفرع فوراً، الأقرب انتهاءً أولاً، وتُضاف للفرع الآخر عند استلامه."
            : "لا يتحرك أي مخزون حتى يشحن الفرع الآخر الطلب."}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            إلغاء
          </button>
          <button type="submit" className="btn primary" disabled={busy || lines.length === 0 || lines.some((l) => l.qty <= 0)}>
            {busy ? "جارٍ الحفظ…" : shipping ? "شحن" : "إرسال الطلب"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
