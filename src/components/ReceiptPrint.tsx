import { code128Widths } from "../core/code128.ts";
import { formatIqd } from "../core/totals.ts";
import type { Receipt } from "../core/types.ts";

const METHOD_LABEL: Record<Receipt["payments"][number]["method"], string> = {
  cash: "نقدي",
  card: "بطاقة",
  credit: "آجل",
  insurance: "تأمين",
};

/** The invoice number as a Code 128 barcode, so a return or reprint can be looked up by scanning. */
function InvoiceBarcode({ value }: { value: string }) {
  let widths: number[];
  try {
    widths = code128Widths(value);
  } catch {
    return null;
  }
  const quiet = 10;
  const total = widths.reduce((s, w) => s + w, 0) + quiet * 2;
  let x = quiet;
  const bars: { x: number; w: number }[] = [];
  widths.forEach((w, i) => {
    if (i % 2 === 0) bars.push({ x, w });
    x += w;
  });
  return (
    <svg className="r-barcode" viewBox={`0 0 ${total} 40`} preserveAspectRatio="none" shapeRendering="crispEdges" role="img" aria-label={`باركود الفاتورة ${value}`}>
      <rect width={total} height={40} fill="#fff" />
      {bars.map((b, i) => (
        <rect key={i} x={b.x} y={0} width={b.w} height={40} fill="#000" />
      ))}
    </svg>
  );
}

/**
 * Arabic receipt laid out for an 80 mm or 58 mm thermal roll, or A4 (from the receipt settings).
 * Used both on screen (preview) and inside the print host, which is the only thing visible when printing.
 */
export function ReceiptPrint({ receipt: r }: { receipt: Receipt }) {
  const s = r.settings;
  const cashPaid = r.payments.some((p) => p.method === "cash");
  return (
    <div className={`receipt-print paper-${s.paper}`} dir="rtl">
      <header className="r-center">
        <div className="r-title">{s.name}</div>
        {s.address && <div>{s.address}</div>}
        {s.phone && (
          <div>
            هاتف: <bdi>{s.phone}</bdi>
          </div>
        )}
        {r.copy && <div className="r-copy">نسخة</div>}
      </header>
      <div className="r-rule" />
      <div className="r-row">
        <span>فاتورة</span>
        <bdi className="r-strong">{r.invoiceNo}</bdi>
      </div>
      <div className="r-row">
        <span>التاريخ</span>
        <bdi>{r.soldAt}</bdi>
      </div>
      {r.cashier && (
        <div className="r-row">
          <span>الكاشير</span>
          <span>{r.cashier}</span>
        </div>
      )}
      <div className="r-rule" />
      <table className="r-items">
        <thead>
          <tr>
            <th>الصنف</th>
            <th>الكمية</th>
            <th>السعر</th>
            <th>المجموع</th>
          </tr>
        </thead>
        <tbody>
          {r.lines.map((l, i) => (
            <tr key={i}>
              <td>
                <bdi>{l.name}</bdi>
                <div className="r-small">
                  تشغيلة <bdi>{l.batches}</bdi>
                </div>
                {l.discount > 0 && (
                  <div className="r-small">
                    خصم <bdi>{formatIqd(l.discount)}</bdi>
                  </div>
                )}
              </td>
              <td className="r-num">{l.qty}</td>
              <td className="r-num">{formatIqd(l.unitPrice)}</td>
              <td className="r-num">{formatIqd(l.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="r-rule" />
      <div className="r-row">
        <span>المجموع</span>
        <bdi>{formatIqd(r.subtotal)}</bdi>
      </div>
      {r.discount > 0 && (
        <div className="r-row">
          <span>الخصم</span>
          <bdi>− {formatIqd(r.discount)}</bdi>
        </div>
      )}
      <div className="r-row r-total">
        <span>الصافي</span>
        <bdi>{formatIqd(r.total)} د.ع</bdi>
      </div>
      <div className="r-rule" />
      {r.payments.map((p, i) => (
        <div key={i} className="r-row">
          <span>{METHOD_LABEL[p.method]}</span>
          <bdi>{formatIqd(p.method === "cash" ? r.cashTendered : p.amount)}</bdi>
        </div>
      ))}
      {cashPaid && r.change > 0 && (
        <div className="r-row r-strong">
          <span>الباقي للعميل</span>
          <bdi>{formatIqd(r.change)}</bdi>
        </div>
      )}
      {r.prescription && (
        <>
          <div className="r-rule" />
          <div className="r-small">
            وصفة رقم <bdi>{r.prescription.rxNo}</bdi> · الطبيب {r.prescription.prescriber}
            {r.prescription.pharmacist && <> · صرفها {r.prescription.pharmacist}</>}
          </div>
        </>
      )}
      <div className="r-rule" />
      {s.footer && <div className="r-center">{s.footer}</div>}
      <InvoiceBarcode value={r.invoiceNo} />
      <div className="r-center r-small">
        <bdi>{r.invoiceNo}</bdi>
      </div>
    </div>
  );
}
