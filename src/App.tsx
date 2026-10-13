import { repo } from "./data/index.ts";
import { PosScreen } from "./pos/PosScreen.tsx";

// Until login lands (step 15), the app runs as the seeded admin user.
const CURRENT_USER = { id: "u-admin", name: "مدير النظام" };

export function App() {
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
          <strong>{CURRENT_USER.name}</strong>
        </div>
      </header>
      <PosScreen userId={CURRENT_USER.id} />
    </div>
  );
}
