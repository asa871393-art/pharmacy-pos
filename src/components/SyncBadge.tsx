import { useEffect, useState } from "react";
import type { SyncState, SyncStatus } from "../core/types.ts";
import { repo } from "../data/index.ts";

const LABEL: Record<SyncState, string> = {
  synced: "متصل · تم المزامنة",
  syncing: "جاري المزامنة...",
  offline: "غير متصل · يعمل محلياً",
  error: "تعذّرت المزامنة · يعمل محلياً",
  disabled: "قاعدة بيانات محلية · المزامنة غير مفعّلة",
};

const localTime = (iso: string) => new Date(iso).toLocaleString("ar-IQ-u-nu-latn", { dateStyle: "short", timeStyle: "short" });

/** Cloud connection in the top bar. Every sale and change is saved locally first, whatever this says. */
export function SyncBadge() {
  const [status, setStatus] = useState<SyncStatus | null>(null);

  useEffect(() => {
    let stop = () => {};
    repo.syncStatus().then(setStatus, () => {});
    void repo.onSyncStatus(setStatus).then((unlisten) => (stop = unlisten));
    // Back online: don't wait for the worker's next try.
    const online = () => void repo.syncNow().catch(() => {});
    window.addEventListener("online", online);
    return () => {
      stop();
      window.removeEventListener("online", online);
    };
  }, []);

  if (repo.kind !== "sqlite") {
    return (
      <span className="status">
        <span className="dot" aria-hidden="true" />
        وضع العرض في المتصفح · البيانات لا تُحفظ
      </span>
    );
  }
  if (!status) return null;

  const details = [
    status.pending > 0 ? `${status.pending} عملية محفوظة محلياً بانتظار الإرسال` : "لا شيء بانتظار الإرسال",
    status.failed > 0 ? `${status.failed} عملية رفضتها السحابة` : "",
    status.lastSyncAt ? `آخر مزامنة: ${localTime(status.lastSyncAt)}` : "",
    status.lastError ? `السبب: ${status.lastError}` : "",
  ].filter(Boolean);

  return (
    <span className={`status sync-${status.state}`} role="status" aria-live="polite" title={details.join("\n")}>
      <span className="dot" aria-hidden="true" />
      {LABEL[status.state]}
      {status.state !== "synced" && status.state !== "disabled" && status.pending > 0 && (
        <span className="sync-count num" aria-label={`${status.pending} بانتظار الإرسال`}>{status.pending}</span>
      )}
    </span>
  );
}
