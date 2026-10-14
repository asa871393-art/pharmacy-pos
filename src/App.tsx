import { useEffect, useState } from "react";
import { Login } from "./auth/Login.tsx";
import type { AuthStatus, Role, User } from "./core/types.ts";
import { repo } from "./data/index.ts";
import { InventoryScreen } from "./inventory/InventoryScreen.tsx";
import { PosScreen } from "./pos/PosScreen.tsx";
import { PurchasingScreen } from "./purchasing/PurchasingScreen.tsx";

const ROLE_LABEL: Record<Role, string> = {
  admin: "مدير",
  chief_pharmacist: "صيدلاني مسؤول",
  pharmacist: "صيدلاني",
  cashier: "كاشير",
  storekeeper: "أمين مخزن",
};

type View = "pos" | "inventory" | "purchasing";

const VIEWS: { id: View; label: string }[] = [
  { id: "pos", label: "نقطة البيع" },
  { id: "inventory", label: "المخزون" },
  { id: "purchasing", label: "المشتريات" },
];

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("pos");

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
    setView("pos");
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-start">
          <strong className="brand">نظام الصيدلية</strong>
          <nav aria-label="الوحدات" className="modules">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                className={`module ${view === v.id ? "active" : ""}`}
                aria-current={view === v.id ? "page" : undefined}
                onClick={() => setView(v.id)}
              >
                {v.label}
              </button>
            ))}
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
      {/* POS and Purchasing stay mounted while hidden, so a half-built sale or invoice survives switching screens.
          Inventory reloads each time it opens, so it always shows current stock. */}
      <div className="view" hidden={view !== "pos"}>
        <PosScreen key={user.id} visible={view === "pos"} />
      </div>
      {view === "inventory" && <InventoryScreen key={user.id} user={user} />}
      <div className="view" hidden={view !== "purchasing"}>
        <PurchasingScreen key={user.id} user={user} />
      </div>
    </div>
  );
}
