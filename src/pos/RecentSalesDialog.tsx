import { useEffect, useState, type FormEvent } from "react";
import { requestPrint } from "../components/PrintHost.tsx";
import { ReceiptPrint } from "../components/ReceiptPrint.tsx";
import { formatIqd } from "../core/totals.ts";
import type { Receipt, ReceiptPaper, ReceiptSettings, RecentSale } from "../core/types.ts";
import { repo } from "../data/index.ts";
import { errorText, Field, Modal } from "../ui/Modal.tsx";

const PAPERS: { id: ReceiptPaper; label: string }[] = [
  { id: "80", label: "حراري 80 مم" },
  { id: "58", label: "حراري 58 مم" },
  { id: "a4", label: "ورق عادي A4" },
];

/** Today's invoices with a receipt preview and reprint (marked "نسخة" and logged). Admins also edit the receipt header. */
export function RecentSalesDialog({ onClose }: { onClose: () => void }) {
  const [sales, setSales] = useState<RecentSale[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<Receipt | null>(null);
  const [error, setError] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    repo.recentSales().then(
      (list) => {
        setSales(list);
        if (list[0]) setSelected(list[0].saleId);
      },
      (e) => setError(errorText(e)),
    );
    repo.authStatus().then((a) => setIsAdmin(a.user?.role === "admin"), () => {});
  }, []);

  useEffect(() => {
    if (!selected) return;
    setPreview(null);
    repo.saleReceipt(selected, false).then(setPreview, (e) => setError(errorText(e)));
  }, [selected]);

  async function reprint() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      requestPrint(await repo.saleReceipt(selected, true));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="فواتير اليوم" onClose={onClose} wide>
      <div className="modal-body">
        {error && <div role="alert" className="banner error"><span>{error}</span></div>}
        <div className="history-grid">
          <div className="table-wrap history-list">
            <table className="cart">
              <thead>
                <tr>
                  <th>الوقت</th>
                  <th>الفاتورة</th>
                  <th>الكاشير</th>
                  <th>الإجمالي</th>
                </tr>
              </thead>
              <tbody>
                {sales?.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty">لا توجد فواتير اليوم</td>
                  </tr>
                )}
                {sales?.map((s) => (
                  <tr
                    key={s.saleId}
                    className={`clickable ${s.saleId === selected ? "selected" : ""}`}
                    onClick={() => setSelected(s.saleId)}
                    aria-selected={s.saleId === selected}
                  >
                    <td className="num">{s.time}</td>
                    <td>
                      <button type="button" className="link-btn" onClick={() => setSelected(s.saleId)}>
                        <bdi className="num">{s.invoiceNo}</bdi>
                      </button>
                    </td>
                    <td>{s.cashier ?? "—"}</td>
                    <td className="num">{formatIqd(s.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="history-preview">
            <div className="paper-frame">{preview ? <ReceiptPrint receipt={preview} /> : <p className="empty-note">اختر فاتورة</p>}</div>
            <div className="modal-actions">
              {isAdmin && (
                <button type="button" className="btn" onClick={() => setEditing(true)}>
                  بيانات الإيصال
                </button>
              )}
              <button type="button" className="btn primary" disabled={!preview || busy} onClick={() => void reprint()}>
                طبع الفاتورة (نسخة)
              </button>
            </div>
          </div>
        </div>
      </div>
      {editing && (
        <ReceiptSettingsDialog
          onClose={() => setEditing(false)}
          onSaved={(s) => {
            setEditing(false);
            setPreview((p) => (p ? { ...p, settings: s } : p));
          }}
        />
      )}
    </Modal>
  );
}

function ReceiptSettingsDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (s: ReceiptSettings) => void }) {
  const [s, setS] = useState<ReceiptSettings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    repo.receiptSettings().then(setS, (e) => setError(errorText(e)));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!s) return;
    setBusy(true);
    setError("");
    try {
      onSaved(await repo.saveReceiptSettings(s));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof ReceiptSettings) => (e: { target: { value: string } }) => s && setS({ ...s, [k]: e.target.value });

  return (
    <Modal title="بيانات الإيصال" onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        {error && <div role="alert" className="banner error"><span>{error}</span></div>}
        {s && (
          <>
            <div className="form-grid">
              <Field id="rs-name" label="اسم الصيدلية *">
                <input id="rs-name" className="field" value={s.name} onChange={set("name")} maxLength={60} required autoFocus />
              </Field>
              <Field id="rs-phone" label="الهاتف">
                <input id="rs-phone" className="field num" value={s.phone} onChange={set("phone")} maxLength={40} />
              </Field>
            </div>
            <Field id="rs-address" label="العنوان">
              <input id="rs-address" className="field" value={s.address} onChange={set("address")} maxLength={120} />
            </Field>
            <Field id="rs-footer" label="رسالة أسفل الإيصال">
              <input id="rs-footer" className="field" value={s.footer} onChange={set("footer")} maxLength={200} />
            </Field>
            <Field id="rs-paper" label="مقاس الورق" hint="اختر نفس المقاس في إعدادات الطابعة عند أول طباعة">
              <select id="rs-paper" className="field" value={s.paper} onChange={set("paper")}>
                {PAPERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </Field>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>إلغاء</button>
          <button type="submit" className="btn primary" disabled={!s || busy}>{busy ? "جارٍ الحفظ…" : "حفظ"}</button>
        </div>
      </form>
    </Modal>
  );
}
