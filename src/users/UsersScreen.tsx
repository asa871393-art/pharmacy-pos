import { useEffect, useState, type FormEvent } from "react";
import {
  normalizeOverrides,
  PERMISSIONS,
  resolvePermissions,
  ROLE_LABEL,
  ROLES,
  roleDefault,
  type Permission,
  type PermissionOverrides,
} from "../core/permissions.ts";
import type { Role, User, UserRow } from "../core/types.ts";
import { repo } from "../data/index.ts";
import { errorText, Field, Modal, toInt } from "../ui/Modal.tsx";

const MIN_PASSWORD_LEN = 8;

type Dialog =
  | { kind: "add" }
  | { kind: "discount" }
  | { kind: "access"; user: UserRow }
  | { kind: "password"; user: UserRow }
  | { kind: "deactivate"; user: UserRow };

/** Employees and their access. Admin only: App renders it for admins, and every user command checks again. */
export function UsersScreen({ me }: { me: User }) {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);

  useEffect(() => {
    repo.listUsers().then(setUsers, (e) => setError(errorText(e)));
  }, []);

  function upsert(row: UserRow, message: string) {
    setUsers((all) => {
      const rest = (all ?? []).filter((u) => u.id !== row.id);
      return [...rest, row].sort((a, b) => Number(b.active) - Number(a.active) || a.fullName.localeCompare(b.fullName));
    });
    setDialog(null);
    setError("");
    setNotice(message);
  }

  async function activate(u: UserRow) {
    try {
      upsert(await repo.toggleUserStatus(u.id, true), `تم تفعيل حساب ${u.fullName}`);
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <main className="inv">
      <section className="panel inv-panel" aria-labelledby="users-title">
        <div className="inv-head">
          <h2 id="users-title">الموظفين</h2>
          <span className="muted">{users ? `${users.filter((u) => u.active).length} نشط من ${users.length}` : "جارٍ التحميل…"}</span>
          <button type="button" className="btn" onClick={() => setDialog({ kind: "discount" })}>
            حد الخصم
          </button>
          <button type="button" className="btn primary" onClick={() => setDialog({ kind: "add" })}>
            + موظف جديد
          </button>
        </div>
        {error && <div role="alert" className="banner error"><span>{error}</span></div>}
        {notice && <div role="status" className="banner success"><span>{notice}</span></div>}
        <div className="table-wrap">
          <table className="cart users-table">
            <thead>
              <tr>
                <th>الاسم الكامل</th>
                <th>اسم المستخدم</th>
                <th>الدور</th>
                <th>الصلاحيات</th>
                <th>الحالة</th>
                <th>آخر دخول</th>
                <th>الإجراءات</th>
              </tr>
            </thead>
            <tbody>
              {users?.map((u) => {
                const self = u.id === me.id;
                return (
                  <tr key={u.id} className={u.active ? "" : "inactive"}>
                    <td>
                      <span className="strong">{u.fullName}</span>
                      {self && <span className="tag info">أنت</span>}
                    </td>
                    <td><bdi className="num">{u.username}</bdi></td>
                    <td>{ROLE_LABEL[u.role]}</td>
                    <td><PermissionTags user={u} /></td>
                    <td>
                      {u.active ? <span className="tag ok">نشط</span> : <span className="tag bad">معطّل</span>}
                      {!u.hasPassword && <span className="tag warn">بلا كلمة مرور</span>}
                    </td>
                    <td>{u.lastLogin ? <bdi className="num small">{u.lastLogin}</bdi> : <span className="muted">—</span>}</td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="link-btn" onClick={() => setDialog({ kind: "access", user: u })}>
                          الدور والصلاحيات
                        </button>
                        <button type="button" className="link-btn" onClick={() => setDialog({ kind: "password", user: u })}>
                          كلمة المرور
                        </button>
                        {u.active ? (
                          <button
                            type="button"
                            className="link-btn danger"
                            disabled={self}
                            title={self ? "لا يمكنك تعطيل حسابك" : undefined}
                            onClick={() => setDialog({ kind: "deactivate", user: u })}
                          >
                            تعطيل
                          </button>
                        ) : (
                          <button type="button" className="link-btn" onClick={() => void activate(u)}>
                            تفعيل
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="cart-foot">
          الدور يحدد الصلاحيات الافتراضية، ويمكن منح صلاحية أو منعها لموظف بعينه. التغييرات تسري على الأوامر فوراً، وتظهر في
          شاشات الموظف عند دخوله التالي. كل تعديل يُسجَّل في سجل التدقيق.
        </div>
      </section>

      {dialog?.kind === "discount" && (
        <DiscountCapDialog
          onClose={() => setDialog(null)}
          onSaved={(pct) => {
            setDialog(null);
            setNotice(`حد الخصم الآن ${pct}٪ من مجموع الفاتورة`);
          }}
        />
      )}
      {dialog?.kind === "add" && <AddUserDialog onClose={() => setDialog(null)} onSaved={(u) => upsert(u, `تمت إضافة ${u.fullName}`)} />}
      {dialog?.kind === "access" && (
        <AccessDialog user={dialog.user} self={dialog.user.id === me.id} onClose={() => setDialog(null)} onSaved={(u) => upsert(u, `تم تحديث صلاحيات ${u.fullName}`)} />
      )}
      {dialog?.kind === "password" && (
        <PasswordDialog user={dialog.user} onClose={() => setDialog(null)} onSaved={(u) => upsert(u, `تم تعيين كلمة مرور جديدة لـ ${u.fullName}`)} />
      )}
      {dialog?.kind === "deactivate" && (
        <DeactivateDialog user={dialog.user} onClose={() => setDialog(null)} onSaved={(u) => upsert(u, `تم تعطيل حساب ${u.fullName}`)} />
      )}
    </main>
  );
}

/** Effective permissions; ones that differ from the role's default are marked. */
function PermissionTags({ user }: { user: UserRow }) {
  if (user.role === "admin") return <span className="tag ok">كل الصلاحيات</span>;
  const shown = PERMISSIONS.filter((p) => user.permissions[p.id] || user.overrides[p.id] === false);
  if (shown.length === 0) return <span className="muted">البيع فقط</span>;
  return (
    <span className="tags">
      {shown.map((p) => {
        const on = user.permissions[p.id];
        const custom = user.overrides[p.id] !== undefined && user.overrides[p.id] !== null;
        return (
          <span key={p.id} className={`tag ${on ? "" : "bad"} ${custom ? "custom" : ""}`} title={custom ? "استثناء لهذا الموظف" : "حسب الدور"}>
            {on ? "" : "ممنوع: "}
            {p.label}
            {custom && " *"}
          </span>
        );
      })}
    </span>
  );
}

/** Role picker plus a three-way switch per permission: follow the role, allow, or deny. */
function AccessEditor({
  role,
  overrides,
  onRole,
  onOverrides,
  roleLocked,
}: {
  role: Role;
  overrides: PermissionOverrides;
  onRole: (r: Role) => void;
  onOverrides: (o: PermissionOverrides) => void;
  roleLocked?: boolean;
}) {
  const effective = resolvePermissions(role, overrides);
  const set = (p: Permission, v: boolean | null) => onOverrides({ ...overrides, [p]: v });
  return (
    <div className="access-editor">
      <Field id="acc-role" label="الدور" hint={roleLocked ? "لا يمكنك تغيير دورك بنفسك" : undefined}>
        <select id="acc-role" className="field" value={role} disabled={roleLocked} onChange={(e) => onRole(e.target.value as Role)}>
          {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </Field>
      {role === "admin" ? (
        <p className="muted small">المدير يملك كل الصلاحيات، بما فيها إدارة الموظفين.</p>
      ) : (
        <fieldset className="perm-list">
          <legend className="label">الصلاحيات</legend>
          {PERMISSIONS.map((p) => {
            const v = overrides[p.id];
            const mode = v === true ? "allow" : v === false ? "deny" : "role";
            const byRole = roleDefault(role, p.id);
            return (
              <div key={p.id} className="perm-row">
                <div>
                  <div className="strong">{p.label}</div>
                  <div className="muted small">{p.hint}</div>
                </div>
                <div role="radiogroup" aria-label={p.label} className="seg small-seg">
                  <button type="button" role="radio" aria-checked={mode === "role"} className={`seg-btn ${mode === "role" ? "on" : ""}`} onClick={() => set(p.id, null)}>
                    حسب الدور ({byRole ? "نعم" : "لا"})
                  </button>
                  <button type="button" role="radio" aria-checked={mode === "allow"} className={`seg-btn ${mode === "allow" ? "on" : ""}`} onClick={() => set(p.id, true)}>
                    سماح
                  </button>
                  <button type="button" role="radio" aria-checked={mode === "deny"} className={`seg-btn ${mode === "deny" ? "on" : ""}`} onClick={() => set(p.id, false)}>
                    منع
                  </button>
                </div>
                <span className={`tag ${effective[p.id] ? "ok" : "bad"}`}>{effective[p.id] ? "مسموح" : "ممنوع"}</span>
              </div>
            );
          })}
        </fieldset>
      )}
    </div>
  );
}

function AddUserDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (u: UserRow) => void }) {
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [role, setRole] = useState<Role>("cashier");
  const [overrides, setOverrides] = useState<PermissionOverrides>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LEN) return setError(`كلمة المرور يجب ألا تقل عن ${MIN_PASSWORD_LEN} أحرف`);
    if (password !== confirm) return setError("كلمتا المرور غير متطابقتين");
    setBusy(true);
    setError("");
    try {
      onSaved(await repo.createUser({ username, fullName, password, role, overrides: normalizeOverrides(role, overrides) }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="موظف جديد" onClose={onClose} wide>
      <form className="modal-body" onSubmit={submit}>
        {error && <div role="alert" className="banner error"><span>{error}</span></div>}
        <div className="form-grid">
          <Field id="nu-name" label="الاسم الكامل *">
            <input id="nu-name" className="field" value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus required />
          </Field>
          <Field id="nu-user" label="اسم المستخدم *" hint="أحرف لاتينية صغيرة وأرقام و . _ -">
            <input
              id="nu-user"
              className="field num"
              dir="ltr"
              autoComplete="off"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              required
            />
          </Field>
          <Field id="nu-pass" label="كلمة المرور *" hint={`${MIN_PASSWORD_LEN} أحرف على الأقل`}>
            <input id="nu-pass" type="password" className="field" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Field id="nu-confirm" label="تأكيد كلمة المرور *">
            <input id="nu-confirm" type="password" className="field" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </Field>
        </div>
        <AccessEditor role={role} overrides={overrides} onRole={setRole} onOverrides={setOverrides} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>إلغاء</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "جارٍ الحفظ…" : "إضافة الموظف"}</button>
        </div>
      </form>
    </Modal>
  );
}

function AccessDialog({ user, self, onClose, onSaved }: { user: UserRow; self: boolean; onClose: () => void; onSaved: (u: UserRow) => void }) {
  const [role, setRole] = useState<Role>(user.role);
  const [overrides, setOverrides] = useState<PermissionOverrides>(user.overrides);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSaved(await repo.updateUserRole(user.id, role, normalizeOverrides(role, overrides)));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`الدور والصلاحيات — ${user.fullName}`} onClose={onClose} wide>
      <form className="modal-body" onSubmit={submit}>
        {error && <div role="alert" className="banner error"><span>{error}</span></div>}
        <AccessEditor
          role={role}
          overrides={overrides}
          onRole={(r) => {
            setRole(r);
            setOverrides({}); // exceptions belong to the old role
          }}
          onOverrides={setOverrides}
          roleLocked={self}
        />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>إلغاء</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "جارٍ الحفظ…" : "حفظ"}</button>
        </div>
      </form>
    </Modal>
  );
}

function PasswordDialog({ user, onClose, onSaved }: { user: UserRow; onClose: () => void; onSaved: (u: UserRow) => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LEN) return setError(`كلمة المرور يجب ألا تقل عن ${MIN_PASSWORD_LEN} أحرف`);
    if (password !== confirm) return setError("كلمتا المرور غير متطابقتين");
    setBusy(true);
    setError("");
    try {
      onSaved(await repo.resetUserPassword(user.id, password));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`كلمة مرور جديدة — ${user.fullName}`} onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        {error && <div role="alert" className="banner error"><span>{error}</span></div>}
        <p className="muted small">تحلّ محل كلمة المرور الحالية فوراً. أبلغ الموظف بها بنفسك؛ لا يمكن عرضها لاحقاً.</p>
        <div className="form-grid">
          <Field id="rp-pass" label="كلمة المرور الجديدة" hint={`${MIN_PASSWORD_LEN} أحرف على الأقل`}>
            <input id="rp-pass" type="password" className="field" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
          </Field>
          <Field id="rp-confirm" label="تأكيد كلمة المرور">
            <input id="rp-confirm" type="password" className="field" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </Field>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>إلغاء</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "جارٍ الحفظ…" : "تعيين كلمة المرور"}</button>
        </div>
      </form>
    </Modal>
  );
}

function DeactivateDialog({ user, onClose, onSaved }: { user: UserRow; onClose: () => void; onSaved: (u: UserRow) => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      onSaved(await repo.toggleUserStatus(user.id, false));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`تعطيل حساب ${user.fullName}`} onClose={onClose}>
      <div className="modal-body">
        {error && <div role="alert" className="banner error"><span>{error}</span></div>}
        <p>
          لن يستطيع <strong>{user.fullName}</strong> تسجيل الدخول، وإن كان داخلاً الآن فسيُرفض أي بيع أو تعديل يقوم به. تبقى
          مبيعاته وسجلاته كما هي، ويمكن تفعيل الحساب لاحقاً.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>إلغاء</button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => void confirm()} autoFocus>
            {busy ? "جارٍ التعطيل…" : "تعطيل الحساب"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The discount cap for every role except admin and chief pharmacist. Changes are audit-logged. */
function DiscountCapDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (pct: number) => void }) {
  const [pct, setPct] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    repo.saleSettings().then((s) => setPct(String(s.maxDiscountPct)), (e) => setError(errorText(e)));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pct === null) return;
    setError("");
    setBusy(true);
    try {
      onSaved((await repo.saveSaleSettings({ maxDiscountPct: toInt(pct) })).maxDiscountPct);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="حد الخصم" onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        {error && <div role="alert" className="banner error"><span>{error}</span></div>}
        <Field
          id="cap-pct"
          label="أقصى خصم على الفاتورة (٪ من المجموع)"
          hint="يسري على الصيدلاني والكاشير؛ المدير والصيدلاني المسؤول بلا حد. التغيير يُسجَّل في سجل التدقيق"
        >
          <input
            id="cap-pct"
            className="field num"
            inputMode="numeric"
            value={pct ?? ""}
            disabled={pct === null}
            autoFocus
            onChange={(e) => setPct(e.target.value)}
            required
          />
        </Field>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>إلغاء</button>
          <button type="submit" className="btn primary" disabled={busy || pct === null}>
            {busy ? "جارٍ الحفظ…" : "حفظ"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
