import { useEffect, useState, type ReactNode } from "react";
import { AUDIT_GROUPS, auditActionLabel, auditSummary } from "../core/audit.ts";
import { addDays, weekStart } from "../core/fefo.ts";
import { formatIqd } from "../core/totals.ts";
import {
  type AuditReport,
  type Category,
  type ExpiryReport,
  type ReorderRow,
  type ReportFilter,
  type RxReport,
  type SalesReport,
  type SalesRow,
  type User,
  type UserRef,
} from "../core/types.ts";
import { localToday, repo } from "../data/index.ts";
import { ExpiryTag } from "../pos/ExpiryTag.tsx";
import { errorText } from "../ui/Modal.tsx";

type Tab = "sales" | "expiry" | "reorder" | "rx" | "audit";

// Same rules as the report_* commands: money and prescription reports need viewReports; stock reports either;
// the audit log is for admins.
const moneyReports = (u: User) => u.permissions.viewReports;
const stockReports = (u: User) => u.permissions.viewReports || u.permissions.modifyInventory;
const adminOnly = (u: User) => u.role === "admin";

const TABS: {
  id: Tab;
  label: string;
  allowed: (u: User) => boolean;
  usesDates: boolean;
  /** Label of the user filter, if the report has one. */
  userFilter?: string;
  usesCategory: boolean;
}[] = [
  { id: "sales", label: "المبيعات والأرباح", allowed: moneyReports, usesDates: true, userFilter: "الكاشير", usesCategory: true },
  { id: "expiry", label: "الصلاحية والتالف", allowed: stockReports, usesDates: true, usesCategory: true },
  { id: "reorder", label: "إعادة الطلب", allowed: stockReports, usesDates: false, usesCategory: true },
  { id: "rx", label: "سجل الوصفات الطبية", allowed: moneyReports, usesDates: true, userFilter: "الكاشير", usesCategory: true },
  { id: "audit", label: "سجل التدقيق", allowed: adminOnly, usesDates: true, userFilter: "المستخدم", usesCategory: false },
];

const HORIZONS = [30, 90, 180];

// ── One description per report, used for the screen, the print view and the CSV file ──

interface Tile {
  label: string;
  value: string;
  sub?: string;
  /** Plain number for the CSV file, so spreadsheets can add it up. */
  csv?: number;
}

interface Column<T> {
  label: string;
  cell: (row: T) => ReactNode;
  csv: (row: T) => string | number;
  num?: boolean;
}

interface Section<T> {
  title: string;
  note?: string;
  empty: string;
  columns: Column<T>[];
  rows: T[];
}

interface View {
  hero?: Tile;
  tiles: Tile[];
  // Each section has its own row type; the screen only passes rows back to their own columns.
  sections: Section<any>[];
}

const iqd = (n: number) => `${formatIqd(n)} د.ع`;
/** A money tile: shown in dinars, exported as the plain number. */
const moneyTile = (label: string, n: number, sub?: string): Tile => ({ label, value: iqd(n), sub, csv: n });
const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}٪` : "—");
const money = <T,>(label: string, get: (r: T) => number): Column<T> => ({ label, cell: (r) => formatIqd(get(r)), csv: get, num: true });
const count = <T,>(label: string, get: (r: T) => number): Column<T> => ({ label, cell: get, csv: get, num: true });
const text = <T,>(label: string, get: (r: T) => string | null | undefined): Column<T> => ({
  label,
  cell: (r) => get(r) ?? "—",
  csv: (r) => get(r) ?? "",
});

function salesView(r: SalesReport): View {
  const t = r.totals;
  const rowColumns = (first: Column<SalesRow>): Column<SalesRow>[] => [
    first,
    count("الفواتير", (x) => x.invoices),
    count("الوحدات", (x) => x.units),
    money("الخصومات", (x) => x.discounts),
    money("صافي المبيعات", (x) => x.net),
    money("صافي الربح", (x) => x.profit),
    { label: "الهامش", cell: (x) => pct(x.profit, x.net), csv: (x) => (x.net > 0 ? ((x.profit / x.net) * 100).toFixed(1) : ""), num: true },
  ];
  return {
    hero: moneyTile("صافي المبيعات", t.net, `${t.invoices} فاتورة · ${t.units} وحدة`),
    tiles: [
      moneyTile("إجمالي المبيعات قبل الخصم", t.gross),
      moneyTile("إجمالي الخصومات", t.discounts, pct(t.discounts, t.gross) + " من الإجمالي"),
      moneyTile("كلفة البضاعة المباعة", t.cost),
      moneyTile("صافي الربح", t.profit, "هامش " + pct(t.profit, t.net)),
      t.invoices ? moneyTile("متوسط الفاتورة", Math.round(t.net / t.invoices)) : { label: "متوسط الفاتورة", value: "—" },
    ],
    sections: [
      { title: "المبيعات حسب الكاشير", empty: "لا مبيعات في هذه الفترة", columns: rowColumns(text("الكاشير", (x) => x.label)), rows: r.byCashier },
      { title: "المبيعات حسب اليوم", empty: "لا مبيعات في هذه الفترة", columns: rowColumns(text("اليوم", (x) => x.key)), rows: r.byDay },
      { title: "الأصناف الأعلى مبيعاً", note: "أعلى ٢٠ صنفاً بصافي المبيعات", empty: "لا مبيعات في هذه الفترة", columns: rowColumns(text("الصنف", (x) => x.label)), rows: r.topProducts },
    ],
  };
}

function expiryView(r: ExpiryReport, withinDays: number, today: string): View {
  type B = ExpiryReport["batches"][number];
  type W = ExpiryReport["writeOffs"][number];
  return {
    hero: moneyTile("قيمة المنتهي على الرف (بالكلفة)", r.expiredValue, `${r.expiredQty} وحدة يجب سحبها`),
    tiles: [
      moneyTile(`قريب الانتهاء خلال ${withinDays} يوماً`, r.nearValue, `${r.nearQty} وحدة`),
      moneyTile("المتلف في الفترة", r.writtenOffValue, `${r.writeOffs.length} عملية`),
    ],
    sections: [
      {
        title: "الدفعات المنتهية والقريبة من الانتهاء",
        note: "بترتيب FEFO: الأقرب انتهاءً أولاً",
        empty: "لا توجد دفعات منتهية أو قريبة الانتهاء",
        rows: r.batches,
        columns: [
          text<B>("الصنف", (x) => x.product),
          text<B>("التصنيف", (x) => x.category),
          { label: "التشغيلة", cell: (x: B) => <bdi className="num">{x.batchNo}</bdi>, csv: (x: B) => x.batchNo },
          { label: "الانتهاء", cell: (x: B) => <ExpiryTag date={x.expiryDate} today={today} />, csv: (x: B) => x.expiryDate },
          {
            label: "الأيام المتبقية",
            cell: (x: B) => (x.daysLeft <= 0 ? <span className="tag bad">منتهية</span> : x.daysLeft),
            csv: (x: B) => x.daysLeft,
            num: true,
          },
          count<B>("الكمية", (x) => x.qty),
          money<B>("القيمة بالكلفة", (x) => x.value),
        ],
      },
      {
        title: "المتلف والمسحوب في الفترة",
        note: "تصحيحات الجرد التي أنقصت الكمية، مع السبب المسجّل",
        empty: "لا توجد عمليات إتلاف أو سحب في هذه الفترة",
        rows: r.writeOffs,
        columns: [
          text<W>("اليوم", (x) => x.day),
          text<W>("الصنف", (x) => x.product),
          { label: "التشغيلة", cell: (x: W) => <bdi className="num">{x.batchNo}</bdi>, csv: (x: W) => x.batchNo },
          count<W>("الكمية", (x) => x.qty),
          money<W>("القيمة", (x) => x.value),
          text<W>("السبب", (x) => x.reason),
          text<W>("بواسطة", (x) => x.user),
        ],
      },
    ],
  };
}

function reorderView(rows: ReorderRow[]): View {
  const out = rows.filter((r) => r.stock === 0).length;
  const cost = rows.reduce((s, r) => s + r.suggestedQty * (r.lastCost ?? 0), 0);
  return {
    hero: { label: "أصناف تحتاج إعادة طلب", value: String(rows.length), sub: `منها ${out} نفد مخزونها`, csv: rows.length },
    tiles: [moneyTile("كلفة الطلب المقترح (تقديرية)", cost, "بآخر سعر شراء")],
    sections: [
      {
        title: "قائمة إعادة الطلب",
        note: "النافد أولاً، ثم الأقل أياماً من التغطية بمعدل بيع آخر ٣٠ يوماً",
        empty: "لا توجد أصناف تحت حد إعادة الطلب",
        rows,
        columns: [
          text<ReorderRow>("الصنف", (x) => x.product),
          { label: "الباركود", cell: (x: ReorderRow) => (x.barcode ? <bdi className="num">{x.barcode}</bdi> : "—"), csv: (x: ReorderRow) => x.barcode ?? "" },
          text<ReorderRow>("التصنيف", (x) => x.category),
          {
            label: "المتوفر",
            cell: (x: ReorderRow) => (x.stock === 0 ? <span className="tag bad">نفد</span> : x.stock),
            csv: (x: ReorderRow) => x.stock,
            num: true,
          },
          { label: "حد الطلب", cell: (x: ReorderRow) => x.reorderLevel ?? "—", csv: (x: ReorderRow) => x.reorderLevel ?? "", num: true },
          count<ReorderRow>("مبيع ٣٠ يوماً", (x) => x.sold30d),
          { label: "يكفي (يوم)", cell: (x: ReorderRow) => x.daysOfCover ?? "—", csv: (x: ReorderRow) => x.daysOfCover ?? "", num: true },
          count<ReorderRow>("الكمية المقترحة", (x) => x.suggestedQty),
          text<ReorderRow>("المورد المفضّل", (x) => x.supplier),
          { label: "آخر سعر شراء", cell: (x: ReorderRow) => (x.lastCost === null ? "—" : formatIqd(x.lastCost)), csv: (x: ReorderRow) => x.lastCost ?? "", num: true },
        ],
      },
    ],
  };
}

function rxView(r: RxReport): View {
  type R = RxReport["rows"][number];
  type P = RxReport["byPrescriber"][number];
  return {
    hero: { label: "وصفات مصروفة", value: String(r.rows.length), sub: `من ${r.byPrescriber.length} طبيب`, csv: r.rows.length },
    tiles: [moneyTile("قيمة أدوية الوصفة", r.rows.reduce((s, x) => s + x.rxTotal, 0))],
    sections: [
      {
        title: "سجل صرف الأدوية بوصفة",
        note: "كل فاتورة فيها دواء لا يُصرف إلا بوصفة، مع رقم الوصفة والطبيب والصيدلاني الذي تحقّق منها",
        empty: "لا توجد وصفات في هذه الفترة",
        rows: r.rows,
        columns: [
          text<R>("التاريخ والوقت", (x) => x.soldAt),
          { label: "الفاتورة", cell: (x: R) => <bdi className="num">{x.invoiceNo}</bdi>, csv: (x: R) => x.invoiceNo },
          { label: "رقم الوصفة", cell: (x: R) => <bdi className="num">{x.rxNo}</bdi>, csv: (x: R) => x.rxNo },
          text<R>("الطبيب", (x) => x.prescriber),
          text<R>("الصيدلاني", (x) => x.pharmacist),
          text<R>("الأدوية المصروفة", (x) => x.items),
          money<R>("القيمة", (x) => x.rxTotal),
        ],
      },
      {
        title: "حسب الطبيب",
        empty: "لا توجد وصفات في هذه الفترة",
        rows: r.byPrescriber,
        columns: [text<P>("الطبيب", (x) => x.prescriber), count<P>("الوصفات", (x) => x.prescriptions), count<P>("الوحدات", (x) => x.units)],
      },
    ],
  };
}

function auditView(r: AuditReport): View {
  type A = AuditReport["rows"][number];
  const { chain } = r;
  const cut = r.total > r.rows.length;
  return {
    hero: { label: "عمليات مسجّلة في الفترة", value: String(r.total), sub: cut ? `يُعرض أحدث ${r.rows.length}` : undefined, csv: r.total },
    tiles: [
      {
        label: "سلامة السجل",
        value: chain.ok ? "سليم" : "تم العبث به",
        sub: chain.ok
          ? `تحقّقنا من ${chain.checked} عملية: لم يُعدَّل أو يُحذف شيء`
          : `السجل لا يطابق بصمته ابتداءً من العملية رقم ${chain.brokenAt}`,
      },
    ],
    sections: [
      {
        title: "العمليات",
        note: cut
          ? `الأحدث أولاً. عُرض ${r.rows.length} من ${r.total}، ضيّق الفترة أو اختر مستخدماً أو نوع عملية لرؤية البقية`
          : "الأحدث أولاً. السجل لا يقبل التعديل ولا الحذف",
        empty: "لا توجد عمليات في هذه الفترة",
        rows: r.rows,
        columns: [
          { label: "#", cell: (x: A) => x.seq, csv: (x: A) => x.seq, num: true },
          { label: "التاريخ والوقت", cell: (x: A) => <bdi className="num">{x.at}</bdi>, csv: (x: A) => x.at },
          text<A>("المستخدم", (x) => x.user),
          text<A>("العملية", (x) => auditActionLabel(x.action)),
          text<A>("يخص", (x) => x.subject),
          { label: "التفاصيل", cell: (x: A) => auditSummary(x.action, x.payload) || "—", csv: (x: A) => auditSummary(x.action, x.payload) },
        ],
      },
    ],
  };
}

// ── CSV ──

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(title: string, meta: string[], view: View): string {
  const lines: string[] = [csvCell(title), ...meta.map(csvCell), ""];
  for (const t of view.hero ? [view.hero, ...view.tiles] : view.tiles) lines.push(`${csvCell(t.label)},${csvCell(t.csv ?? t.value)}`);
  for (const s of view.sections) {
    lines.push("", csvCell(s.title), s.columns.map((c) => csvCell(c.label)).join(","));
    for (const r of s.rows) lines.push(s.columns.map((c) => csvCell(c.csv(r))).join(","));
  }
  // The byte-order mark makes Excel read the Arabic text as UTF-8.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// ── Screen ──

/** Stays mounted (filters survive switching screens); reloads whenever it becomes `visible`, so figures are current. */
export function ReportsScreen({ user, visible = true }: { user: User; visible?: boolean }) {
  const today = localToday();
  const tabs = TABS.filter((t) => t.allowed(user));
  const [tab, setTab] = useState<Tab | undefined>(tabs[0]?.id);
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const [cashierId, setCashierId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [withinDays, setWithinDays] = useState(90);
  const [auditGroup, setAuditGroup] = useState("");
  const [users, setUsers] = useState<UserRef[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  // The view is kept with the tab it belongs to, so a tab never shows another tab's numbers while loading.
  const [loaded, setLoaded] = useState<{ tab: Tab; view: View } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const current = TABS.find((t) => t.id === tab);
  const view = loaded && loaded.tab === tab ? loaded.view : null;
  const canSeeMoney = user.permissions.viewReports;

  useEffect(() => {
    repo.categories().then(setCategories, () => {});
    if (canSeeMoney) repo.reportUsers().then(setUsers, () => {});
  }, [canSeeMoney]);

  useEffect(() => {
    if (!tab || !visible) return;
    let stale = false;
    const f: ReportFilter = { from, to, cashierId: cashierId || undefined, categoryId: categoryId || undefined };
    setLoading(true);
    setError("");
    setNotice("");
    const load: Promise<View> =
      tab === "sales"
        ? repo.reportSales(f).then(salesView)
        : tab === "expiry"
          ? repo.reportExpiry(f, withinDays).then((r) => expiryView(r, withinDays, today))
          : tab === "reorder"
            ? repo.reportReorder(f.categoryId).then(reorderView)
            : tab === "rx"
              ? repo.reportPrescriptions(f).then(rxView)
              : repo.reportAudit({ ...f, categoryId: undefined }, auditGroup || undefined).then(auditView);
    load
      .then((v) => !stale && setLoaded({ tab, view: v }))
      .catch((e) => {
        if (stale) return;
        setLoaded(null);
        setError(errorText(e));
      })
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [tab, from, to, cashierId, categoryId, withinDays, auditGroup, today, visible]);

  if (!tab || !current) {
    return (
      <main className="rep">
        <section className="panel rep-panel">
          <div className="inv-head"><h2>التقارير</h2></div>
          <p className="empty-note">ليست لديك صلاحية لعرض التقارير.</p>
        </section>
      </main>
    );
  }

  const presets: { label: string; from: string; to: string }[] = [
    { label: "اليوم", from: today, to: today },
    { label: "هذا الأسبوع", from: weekStart(today), to: today },
    { label: "آخر ٧ أيام", from: addDays(today, -6), to: today },
    { label: "هذا الشهر", from: today.slice(0, 8) + "01", to: today },
    { label: "آخر ٣٠ يوماً", from: addDays(today, -29), to: today },
  ];

  // What the report covers, for the print header and the CSV file.
  const meta = [
    current.usesDates ? `الفترة: من ${from} إلى ${to}` : `حتى تاريخ ${today}`,
    ...(tab === "expiry" ? [`تنبيه الانتهاء: خلال ${withinDays} يوماً`] : []),
    ...(current.userFilter && cashierId ? [`${current.userFilter}: ${users.find((u) => u.id === cashierId)?.fullName ?? cashierId}`] : []),
    ...(current.usesCategory && categoryId ? [`التصنيف: ${categories.find((c) => c.id === categoryId)?.nameAr ?? categoryId}`] : []),
    ...(tab === "audit" && auditGroup ? [`نوع العملية: ${AUDIT_GROUPS.find((g) => g.id === auditGroup)?.label ?? auditGroup}`] : []),
    `أُعدّ بواسطة ${user.fullName} في ${new Date().toLocaleString("ar-IQ-u-nu-latn")}`,
  ];

  async function exportCsv() {
    if (!view || !current) return;
    try {
      const name = `report-${tab}-${current.usesDates ? `${from}_${to}` : today}.csv`;
      const where = await repo.saveExport(name, toCsv(`تقرير ${current.label}`, meta, view));
      setNotice(`تم تصدير التقرير: ${where}`);
    } catch (e) {
      setError(errorText(e));
    }
  }

  function print() {
    document.body.classList.add("printing-report");
    const done = () => {
      document.body.classList.remove("printing-report");
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
  }

  return (
    <main className="rep">
      <section className="panel rep-panel" aria-labelledby="rep-title">
        <div className="inv-head no-print">
          <h2 id="rep-title">التقارير</h2>
          <div className="rep-actions">
            <button type="button" className="btn" onClick={print} disabled={!view}>طباعة</button>
            <button type="button" className="btn" onClick={() => void exportCsv()} disabled={!view}>تصدير CSV</button>
          </div>
        </div>

        <div role="tablist" aria-label="نوع التقرير" className="rep-tabs no-print">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`rep-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="rep-body"
              className={`rep-tab ${tab === t.id ? "on" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="rep-filters no-print">
          {current.usesDates && (
            <>
              <label className="rep-field">
                <span className="label">من</span>
                <input type="date" className="field num" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
              </label>
              <label className="rep-field">
                <span className="label">إلى</span>
                <input type="date" className="field num" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} />
              </label>
              <div className="chips" role="group" aria-label="فترات جاهزة">
                {presets.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className={`chip ${from === p.from && to === p.to ? "on" : ""}`}
                    aria-pressed={from === p.from && to === p.to}
                    onClick={() => {
                      setFrom(p.from);
                      setTo(p.to);
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </>
          )}
          {tab === "expiry" && (
            <label className="rep-field">
              <span className="label">تنبيه الانتهاء خلال</span>
              <select className="field" value={withinDays} onChange={(e) => setWithinDays(Number(e.target.value))}>
                {HORIZONS.map((d) => <option key={d} value={d}>{d} يوماً</option>)}
              </select>
            </label>
          )}
          {current.userFilter && (
            <label className="rep-field">
              <span className="label">{current.userFilter}</span>
              <select className="field" value={cashierId} onChange={(e) => setCashierId(e.target.value)}>
                <option value="">الكل</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
              </select>
            </label>
          )}
          {tab === "audit" && (
            <label className="rep-field">
              <span className="label">نوع العملية</span>
              <select className="field" value={auditGroup} onChange={(e) => setAuditGroup(e.target.value)}>
                <option value="">الكل</option>
                {AUDIT_GROUPS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
              </select>
            </label>
          )}
          {current.usesCategory && (
            <label className="rep-field">
              <span className="label">التصنيف</span>
              <select className="field" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">الكل</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
              </select>
            </label>
          )}
        </div>

        {error && <div role="alert" className="banner error no-print"><span>{error}</span></div>}
        {notice && <div role="status" className="banner success no-print"><span>{notice}</span></div>}

        <div id="rep-body" role="tabpanel" aria-labelledby={`rep-tab-${tab}`} className="rep-body" aria-busy={loading}>
          <div className="print-only rep-print-head">
            <h1>نظام الصيدلية — تقرير {current.label}</h1>
            {meta.map((m) => <div key={m}>{m}</div>)}
          </div>
          {view && (
            <>
              <div className="tiles">
                {view.hero && (
                  <div className="tile hero">
                    <span className="tile-label">{view.hero.label}</span>
                    <span className="tile-value">{view.hero.value}</span>
                    {view.hero.sub && <span className="tile-sub">{view.hero.sub}</span>}
                  </div>
                )}
                {view.tiles.map((t) => (
                  <div key={t.label} className="tile">
                    <span className="tile-label">{t.label}</span>
                    <span className="tile-value">{t.value}</span>
                    {t.sub && <span className="tile-sub">{t.sub}</span>}
                  </div>
                ))}
              </div>
              {view.sections.map((s) => (
                <section key={s.title} className="rep-section">
                  <h3>{s.title}</h3>
                  {s.note && <p className="muted small">{s.note}</p>}
                  <div className="table-wrap">
                    <table className="cart rep-table">
                      <thead>
                        <tr>{s.columns.map((c) => <th key={c.label} className={c.num ? "n" : ""}>{c.label}</th>)}</tr>
                      </thead>
                      <tbody>
                        {s.rows.length === 0 && (
                          <tr><td colSpan={s.columns.length} className="empty">{s.empty}</td></tr>
                        )}
                        {s.rows.map((r, i) => (
                          <tr key={i}>
                            {s.columns.map((c) => <td key={c.label} className={c.num ? "n num" : ""}>{c.cell(r)}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
            </>
          )}
          {loading && !view && <p className="empty-note">جارٍ إعداد التقرير…</p>}
        </div>
      </section>
    </main>
  );
}
