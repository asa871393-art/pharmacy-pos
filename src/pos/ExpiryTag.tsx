import { daysBetween, expiryStatus } from "../core/fefo.ts";

const LABEL: Record<string, string> = {
  expired: "منتهية",
  critical: "قريبة جداً",
  warning: "قريبة الانتهاء",
  watch: "",
  ok: "",
};

/** "MM/YYYY" with a coloured tier: ≤30 days red, ≤90 amber, ≤180 yellow. */
export function ExpiryTag({ date, today }: { date: string; today: string }) {
  const status = expiryStatus(date, today);
  const days = daysBetween(today, date);
  const mmYyyy = `${date.slice(5, 7)}/${date.slice(0, 4)}`;
  const extra = LABEL[status];
  return (
    <span className={`tag exp-${status}`} title={`${date} · ${days} يوماً`}>
      <bdi className="num">{mmYyyy}</bdi>
      {extra ? ` · ${extra}` : ""}
    </span>
  );
}
