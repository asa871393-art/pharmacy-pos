import { useEffect, useState } from "react";
import { Login } from "./auth/Login.tsx";
import type { AuthStatus, Role, User } from "./core/types.ts";
import { repo } from "./data/index.ts";
import { PosScreen } from "./pos/PosScreen.tsx";

const ROLE_LABEL: Record<Role, string> = {
  admin: "مدير",
  chief_pharmacist: "صيدلاني مسؤول",
  pharmacist: "صيدلاني",
  cashier: "كاشير",
  storekeeper: "أمين مخزن",
};

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    repo.authStatus().then(setAuth, (e) => setError(String(e)));
  }, []);

  if (error) return <div role="alert" className="banner error">{error}</div>;
  if (!auth) return null;
  if (!auth.user) {
    return <Login needsSetup={auth.needsSetup} onSignedIn={(user: User) => setAuth({ needsSetup: false, user })} />;
  }

  const user = auth.user;
  async function logout() {
    await repo.logout();
    setAuth({ needsSetup: false, user: null });
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-start">
          <strong className="brand">نظام الصيدلية</strong>
          <nav aria-label="الوحدات" className="modules">
            <a href="#pos" className="module active" aria-current="page">نقطة البيع</a>
            <span className="module soon" title="المرحلة التالية">المخزون</span>
            <span className="module soon" title="المرحلة التالية">المشتريات</span>
            <span className="module soon" title="المرحلة التالية">التقارير</span>
          </nav>
        </div>
        <div className="topbar-end">
          <span className="status">
            <span className="dot" aria-hidden="true" />
            {repo.kind === "sqlite" ? "قاعدة بيانات محلية · يعمل دون إنترنت" : "وضع العرض في المتصفح · البيانات لا تُحفظ"}
          </span>
          <span>الفرع الرئيسي</span>
          <strong>{user.fullName}</strong>
          <span>{ROLE_LABEL[user.role]}</span>
          <button type="button" className="logout" onClick={() => void logout()}>
            خروج
          </button>
        </div>
      </header>
      <PosScreen key={user.id} />
    </div>
  );
}
