import { useEffect, useState } from "react";
import type { FirewallState, PhoneScannerInfo } from "../core/types.ts";
import { repo } from "../data/index.ts";
import { errorText, Modal } from "../ui/Modal.tsx";

/** QR code and steps for pairing a phone as a Wi-Fi barcode scanner. Refreshes every 2 s to show who is connected. */
export function PhoneScannerDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<PhoneScannerInfo | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [firewall, setFirewall] = useState<FirewallState>("unknown");
  const [fixing, setFixing] = useState(false);
  const [firewallError, setFirewallError] = useState(""); // separate: the 2 s refresh clears `error`

  // Checked once on open (it starts a system tool), and again after the fix.
  useEffect(() => {
    repo.phoneScannerFirewall().then(setFirewall, () => {});
  }, []);

  async function allowFirewall() {
    setFixing(true);
    setFirewallError("");
    try {
      setFirewall(await repo.allowPhoneScannerFirewall());
    } catch (e) {
      setFirewallError(errorText(e));
    } finally {
      setFixing(false);
    }
  }

  useEffect(() => {
    let live = true;
    const load = () =>
      repo.phoneScanner().then(
        (i) => live && (setInfo(i), setError("")),
        (e) => live && setError(errorText(e)),
      );
    void load();
    const t = setInterval(load, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  return (
    <Modal title="قارئ الموبايل" onClose={onClose} wide>
      <div className="modal-body phone-scanner">
        {error && <div role="alert" className="banner error"><span>{error}</span></div>}
        {info === null && (
          <p className="empty-note">
            قارئ الموبايل يعمل في برنامج سطح المكتب فقط، لأنه يحتاج خادماً على شبكة الصيدلية. وضع العرض في المتصفح لا يدعمه.
          </p>
        )}
        {info && info.error && <div role="alert" className="banner error"><span>{info.error}</span></div>}
        {info && firewall === "missing" && (
          <div role="alert" className="banner error firewall-banner">
            <span>
              <strong>جدار حماية ويندوز يمنع الموبايل من الوصول إلى البرنامج</strong>، فتظهر صفحة بيضاء على الموبايل. اسمح
              للبرنامج باستقبال اتصالات قارئ الموبايل (المنفذ {info.port} فقط). سيطلب ويندوز موافقة المدير.
              {firewallError && <strong className="firewall-error"> {firewallError}</strong>}
            </span>
            <button type="button" className="btn primary" disabled={fixing} onClick={() => void allowFirewall()}>
              {fixing ? "بانتظار موافقة ويندوز…" : "السماح عبر جدار الحماية"}
            </button>
          </div>
        )}
        {info && firewall === "allowed" && !info.devices.length && (
          <p className="muted small">جدار الحماية يسمح بالاتصال ✓</p>
        )}
        {info && !info.error && (
          <div className="phone-grid">
            <div className="phone-qr">
              <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(info.qrSvg)}`} alt="رمز QR لفتح قارئ الباركود على الموبايل" width={240} height={240} />
              <bdi className="num small phone-url">{info.url.replace(/\?t=.*/, "")}</bdi>
              <span className={`tag ${info.devices.length ? "ok" : ""}`} role="status">
                {info.devices.length
                  ? `متصل: ${info.devices.length === 1 ? "موبايل واحد" : `${info.devices.length} أجهزة`}`
                  : info.running
                    ? "بانتظار اتصال موبايل…"
                    : "الخادم لا يعمل"}
              </span>
            </div>
            <ol className="phone-steps">
              <li>وصّل الموبايل بشبكة الواي فاي نفسها المتصل بها هذا الجهاز.</li>
              <li>افتح كاميرا الموبايل ووجّهها إلى رمز QR، ثم افتح الرابط.</li>
              <li>
                في أول مرة فقط سيظهر تحذير «الاتصال ليس خاصاً» لأن الشهادة صادرة عن هذا البرنامج: اختر <strong>متقدم</strong> ثم{" "}
                <strong>متابعة</strong>.
              </li>
              <li>اسمح للصفحة باستخدام الكاميرا، ثم وجّهها إلى باركود العبوة: يُضاف الصنف إلى الفاتورة هنا مباشرة.</li>
              <li className="muted">
                إن بقيت صفحة الموبايل بيضاء: تأكد أن الجهازين على الشبكة نفسها (ليست شبكة ضيوف)، وأن جدار الحماية يسمح
                بالاتصال. الرابط صالح حتى إغلاق البرنامج؛ بعد إعادة تشغيله امسح الرمز من جديد.
              </li>
            </ol>
          </div>
        )}
        {info === undefined && !error && <p className="empty-note">جارٍ التحضير…</p>}
      </div>
    </Modal>
  );
}
