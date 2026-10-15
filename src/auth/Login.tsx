import { useEffect, useState, type FormEvent } from "react";
import type { DeviceInfo, User } from "../core/types.ts";
import { repo } from "../data/index.ts";
import { DEMO_PASSWORD } from "../data/demoRepo.ts";

const MIN_PASSWORD_LEN = 8;

/** Sign-in screen. On a fresh install (`needsSetup`) it asks the admin to choose the first password instead.
 *  With more than one branch it also offers the branch this device works for; only an admin can change it. */
export function Login({ needsSetup, onSignedIn }: { needsSetup: boolean; onSignedIn: (u: User) => void }) {
  const [username, setUsername] = useState(needsSetup ? "admin" : "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [branchId, setBranchId] = useState("");

  useEffect(() => {
    repo.deviceInfo().then(
      (d) => {
        setDevice(d);
        setBranchId(d.branch.id);
      },
      () => {},
    );
  }, []);

  const choices = device?.branches.filter((b) => b.active || b.id === device.branch.id) ?? [];
  // Sent only when it changes, so staff signing in on their usual branch need no admin.
  const picked = device && branchId !== device.branch.id ? branchId : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (needsSetup) {
      if (password.length < MIN_PASSWORD_LEN) return setError(`كلمة المرور يجب ألا تقل عن ${MIN_PASSWORD_LEN} أحرف`);
      if (password !== confirm) return setError("كلمتا المرور غير متطابقتين");
    }
    setBusy(true);
    try {
      onSignedIn(needsSetup ? await repo.setupAdmin(password, picked) : await repo.login(username, password, picked));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPassword("");
      setConfirm("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="panel login-card" onSubmit={submit} aria-labelledby="login-title">
        <h1 id="login-title">نظام الصيدلية</h1>
        <p className="muted">
          {needsSetup ? "التشغيل الأول: اختر كلمة مرور لحساب المدير." : "سجّل الدخول لبدء البيع."}
        </p>
        {error && (
          <div role="alert" className="banner error">
            {error}
          </div>
        )}
        <label htmlFor="login-user" className="label">اسم المستخدم</label>
        <input
          id="login-user"
          className="field"
          autoComplete="username"
          value={username}
          readOnly={needsSetup}
          autoFocus={!needsSetup}
          onChange={(e) => setUsername(e.target.value)}
        />
        <label htmlFor="login-pass" className="label">كلمة المرور</label>
        <input
          id="login-pass"
          className="field"
          type="password"
          autoComplete={needsSetup ? "new-password" : "current-password"}
          value={password}
          autoFocus={needsSetup}
          onChange={(e) => setPassword(e.target.value)}
        />
        {choices.length > 1 && (
          <>
            <label htmlFor="login-branch" className="label">الفرع</label>
            <select id="login-branch" className="field" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              {choices.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code})
                </option>
              ))}
            </select>
            {picked && <p className="muted small">تغيير فرع هذا الجهاز يحتاج حساب مدير.</p>}
          </>
        )}
        {needsSetup && (
          <>
            <label htmlFor="login-confirm" className="label">تأكيد كلمة المرور</label>
            <input
              id="login-confirm"
              className="field"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </>
        )}
        <button type="submit" className="complete" disabled={busy || !username || !password}>
          {busy ? "جارٍ التحقق…" : needsSetup ? "حفظ كلمة المرور والدخول" : "دخول"}
        </button>
        {repo.kind === "demo" && (
          <p className="muted small">
            وضع العرض: المستخدمون <bdi>admin</bdi> (مدير)، <bdi>pharm</bdi> (صيدلاني)، <bdi>cash</bdi> (كاشير)،
            وكلمة المرور <bdi className="num">{DEMO_PASSWORD}</bdi>
          </p>
        )}
      </form>
    </main>
  );
}
