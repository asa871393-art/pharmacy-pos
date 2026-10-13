import { formatIqd } from "../core/totals.ts";
import type { SaleResult } from "../core/types.ts";

export interface ReceiptLine {
  name: string;
  qty: number;
  unitPrice: number;
  total: number;
  batches: string;
}

/** 80 mm thermal receipt. Hidden on screen; the only thing shown when printing. */
export function Receipt({ sale, lines, method }: { sale: SaleResult; lines: ReceiptLine[]; method: string }) {
  const when = new Date(sale.createdAt);
  return (
    <div className="receipt" dir="rtl">
      <div className="r-center r-strong">[اسم الصيدلية]</div>
      <div className="r-center">الفرع الرئيسي</div>
      <div className="r-rule" />
      <div>فاتورة: <bdi>{sale.invoiceNo}</bdi></div>
      <div>التاريخ: <bdi>{when.toLocaleString("en-GB")}</bdi></div>
      <div className="r-rule" />
      {lines.map((l, i) => (
        <div key={i} className="r-line">
          <div><bdi>{l.name}</bdi></div>
          <div className="r-row">
            <span><bdi>{l.qty} × {formatIqd(l.unitPrice)}</bdi> · دفعة <bdi>{l.batches}</bdi></span>
            <bdi>{formatIqd(l.total)}</bdi>
          </div>
        </div>
      ))}
      <div className="r-rule" />
      <div className="r-row r-strong"><span>الإجمالي</span><bdi>{formatIqd(sale.total)} د.ع</bdi></div>
      <div className="r-row"><span>طريقة الدفع</span><span>{method}</span></div>
      {sale.change > 0 && <div className="r-row"><span>الباقي للعميل</span><bdi>{formatIqd(sale.change)}</bdi></div>}
      <div className="r-rule" />
      <div className="r-center">شكراً لزيارتكم · الأدوية لا تُرد بعد فتح العبوة</div>
    </div>
  );
}
