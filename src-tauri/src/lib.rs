//! Pharmacy POS — local data layer.
//! Everything is stored in one SQLite file in the app's data folder, so the shop keeps selling with no internet.
//! All stock-changing writes happen here inside a single transaction.

use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

mod phone_scanner;

pub struct Db(pub Mutex<Connection>);

/// Id of the user signed in on this device. Write commands take the user from here, never from the screen.
#[derive(Default)]
pub struct Session(pub Mutex<Option<String>>);

const INIT_SQL: &str = include_str!("../migrations/0001_init.sql");
const SALE_CONTROLS_SQL: &str = include_str!("../migrations/0002_sale_controls.sql");
const USER_PERMISSIONS_SQL: &str = include_str!("../migrations/0003_user_permissions.sql");
const DEMO_SQL: &str = include_str!("../migrations/demo_seed.sql");

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(INIT_SQL)?;
        tx.execute_batch("PRAGMA user_version = 1;")?;
        tx.commit()?;
    }
    if version < 2 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(SALE_CONTROLS_SQL)?;
        tx.execute_batch("PRAGMA user_version = 2;")?;
        tx.commit()?;
    }
    if version < 3 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(USER_PERMISSIONS_SQL)?;
        tx.execute_batch("PRAGMA user_version = 3;")?;
        tx.commit()?;
    }
    // Version 0.1 ships with demo data so the shop can try every screen right away.
    let products: i64 = conn.query_row("SELECT COUNT(*) FROM products", [], |r| r.get(0))?;
    if products == 0 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(DEMO_SQL)?;
        tx.commit()?;
    }
    Ok(())
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ── DTOs (camelCase to match the TypeScript types in src/core/types.ts) ──

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductHit {
    id: String,
    trade_name: String,
    generic: String,
    strength: String,
    form: String,
    pack_size: i64,
    price: i64,
    stock: i64,
    nearest_expiry: Option<String>,
    requires_rx: bool,
    composition_key: String,
    drug_classes: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchDto {
    id: String,
    product_id: String,
    batch_no: String,
    expiry_date: String,
    qty_on_hand: i64,
    unit_cost: i64,
    sell_price: i64,
    received_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationIn {
    batch_id: String,
    qty: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleLineIn {
    product_id: String,
    unit_price: i64,
    discount: i64,
    allocations: Vec<AllocationIn>,
    fefo_override_reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentIn {
    method: String,
    amount: i64,
    reference: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrescriptionIn {
    rx_no: String,
    prescriber: String,
}

/// What the screen sends. The seller is the signed-in user, not a field of the draft.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleDraft {
    lines: Vec<SaleLineIn>,
    invoice_discount: i64,
    payments: Vec<PaymentIn>,
    patient_id: Option<String>,
    prescription: Option<PrescriptionIn>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UserDto {
    id: String,
    username: String,
    full_name: String,
    role: String,
    /// What this user may do: the role's defaults with any per-user overrides applied.
    permissions: Permissions,
}

// ── Roles and permissions ──

const ROLES: [&str; 5] = ["admin", "chief_pharmacist", "pharmacist", "cashier", "storekeeper"];

/// Permissions that can be granted or denied per user. Every check in this file goes through `has_permission`.
const PERMISSIONS: [&str; 4] = ["give_discount", "dispense_rx", "view_reports", "modify_inventory"];

/// What each role may do when the user has no override.
fn role_default(role: &str, permission: &str) -> bool {
    match permission {
        // Within the max_discount_pct ceiling, except admin and chief pharmacist (see post_sale).
        "give_discount" => matches!(role, "admin" | "chief_pharmacist" | "pharmacist" | "cashier"),
        "dispense_rx" => matches!(role, "admin" | "chief_pharmacist" | "pharmacist"),
        // Sales, profit and prescription reports.
        "view_reports" => matches!(role, "admin" | "chief_pharmacist"),
        // Products, stock, purchasing and suppliers.
        "modify_inventory" => matches!(role, "admin" | "chief_pharmacist" | "pharmacist" | "storekeeper"),
        _ => false,
    }
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    give_discount: bool,
    dispense_rx: bool,
    view_reports: bool,
    modify_inventory: bool,
}

/// Per-user overrides: Some(true) grants, Some(false) denies, None follows the role.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PermissionOverrides {
    give_discount: Option<bool>,
    dispense_rx: Option<bool>,
    view_reports: Option<bool>,
    modify_inventory: Option<bool>,
}

impl PermissionOverrides {
    fn get(&self, permission: &str) -> Option<bool> {
        match permission {
            "give_discount" => self.give_discount,
            "dispense_rx" => self.dispense_rx,
            "view_reports" => self.view_reports,
            "modify_inventory" => self.modify_inventory,
            _ => None,
        }
    }

    fn set(&mut self, permission: &str, value: Option<bool>) {
        match permission {
            "give_discount" => self.give_discount = value,
            "dispense_rx" => self.dispense_rx = value,
            "view_reports" => self.view_reports = value,
            "modify_inventory" => self.modify_inventory = value,
            _ => {}
        }
    }
}

fn load_overrides(conn: &Connection, user_id: &str) -> Result<PermissionOverrides, String> {
    let mut o = PermissionOverrides::default();
    let mut stmt = conn.prepare("SELECT permission, granted FROM user_permissions WHERE user_id = ?1").map_err(err)?;
    let rows = stmt
        .query_map(params![user_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0)))
        .map_err(err)?;
    for row in rows {
        let (p, granted) = row.map_err(err)?;
        o.set(&p, Some(granted));
    }
    Ok(o)
}

/// Admins always have every permission; anyone else gets the override if there is one, else the role's default.
fn resolve(role: &str, overrides: &PermissionOverrides, permission: &str) -> bool {
    role == "admin" || overrides.get(permission).unwrap_or_else(|| role_default(role, permission))
}

fn effective_permissions(conn: &Connection, user_id: &str, role: &str) -> Result<Permissions, String> {
    let o = load_overrides(conn, user_id)?;
    Ok(Permissions {
        give_discount: resolve(role, &o, "give_discount"),
        dispense_rx: resolve(role, &o, "dispense_rx"),
        view_reports: resolve(role, &o, "view_reports"),
        modify_inventory: resolve(role, &o, "modify_inventory"),
    })
}

fn has_permission(conn: &Connection, user_id: &str, role: &str, permission: &str) -> Result<bool, String> {
    Ok(resolve(role, &load_overrides(conn, user_id)?, permission))
}

/// Role of an active account, read from the database on every call so a disabled account stops working at once.
fn active_role(conn: &Connection, user_id: &str) -> Result<String, String> {
    conn.query_row("SELECT role FROM users WHERE id = ?1 AND is_active = 1", params![user_id], |r| r.get(0))
        .optional()
        .map_err(err)?
        .ok_or_else(|| "الحساب غير موجود أو معطّل، سجّل الدخول من جديد".to_string())
}

fn denied_message(permission: &str) -> &'static str {
    match permission {
        "give_discount" => "ليست لديك صلاحية لإعطاء خصم",
        "dispense_rx" => "الفاتورة تحتوي دواءً بوصفة طبية ويجب أن يصرفها صيدلاني",
        "view_reports" => "ليست لديك صلاحية لعرض هذا التقرير",
        "modify_inventory" => "ليست لديك صلاحية لتعديل المخزون",
        _ => "ليست لديك صلاحية",
    }
}

/// Fails unless the account is active and holds at least one of `permissions`. Returns the role.
fn require_permission(conn: &Connection, user_id: &str, permissions: &[&str]) -> Result<String, String> {
    let role = active_role(conn, user_id)?;
    let o = load_overrides(conn, user_id)?;
    if permissions.iter().any(|p| resolve(&role, &o, p)) {
        Ok(role)
    } else {
        Err(denied_message(permissions[0]).into())
    }
}

/// User management is for the admin role only; it cannot be granted by an override.
fn require_admin(conn: &Connection, user_id: &str) -> Result<(), String> {
    if active_role(conn, user_id)? != "admin" {
        return Err("إدارة الموظفين للمدير فقط".into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    /// True until the first password is set; the screen then asks the admin to choose one.
    needs_setup: bool,
    user: Option<UserDto>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SaleResult {
    sale_id: String,
    invoice_no: String,
    total: i64,
    paid: i64,
    change: i64,
    created_at: String,
}

// ── Product search ──

const HIT_SELECT: &str = "SELECT p.id, p.trade_name, p.strength_label, p.dosage_form, p.pack_size, p.sell_price,
  p.requires_rx, p.composition_key,
  COALESCE((SELECT group_concat(ai.name_inn, ' + ') FROM product_ingredients pi
            JOIN active_ingredients ai ON ai.id = pi.ingredient_id WHERE pi.product_id = p.id), '') AS generic,
  COALESCE((SELECT group_concat(COALESCE(ai.drug_class, ''), ',') FROM product_ingredients pi
            JOIN active_ingredients ai ON ai.id = pi.ingredient_id WHERE pi.product_id = p.id), '') AS classes,
  COALESCE((SELECT SUM(b.qty_on_hand) FROM batches b WHERE b.product_id = p.id AND b.status = 'active'
            AND b.expiry_date > date('now', 'localtime')), 0) AS stock,
  (SELECT MIN(b.expiry_date) FROM batches b WHERE b.product_id = p.id AND b.status = 'active'
            AND b.qty_on_hand > 0 AND b.expiry_date > date('now', 'localtime')) AS nearest
  FROM products p";

fn map_hit(r: &rusqlite::Row) -> rusqlite::Result<ProductHit> {
    let classes: String = r.get(9)?;
    Ok(ProductHit {
        id: r.get(0)?,
        trade_name: r.get(1)?,
        strength: r.get(2)?,
        form: r.get(3)?,
        pack_size: r.get(4)?,
        price: r.get(5)?,
        requires_rx: r.get::<_, i64>(6)? != 0,
        composition_key: r.get(7)?,
        generic: r.get(8)?,
        drug_classes: classes.split(',').filter(|s| !s.is_empty()).map(String::from).collect(),
        stock: r.get(10)?,
        nearest_expiry: r.get(11)?,
    })
}

/// SQL condition that every search word must satisfy for the product aliased `a`.
fn token_condition(a: &str, mode: &str, k: usize) -> String {
    let trade = format!(
        "{a}.trade_name LIKE ?{k} OR IFNULL({a}.trade_name_ar, '') LIKE ?{k} OR {a}.strength_label LIKE ?{k}"
    );
    let generic = format!(
        "{a}.strength_label LIKE ?{k} OR EXISTS (SELECT 1 FROM product_ingredients pi2
           JOIN active_ingredients ai2 ON ai2.id = pi2.ingredient_id
           WHERE pi2.product_id = {a}.id AND (ai2.name_inn LIKE ?{k} OR IFNULL(ai2.name_ar, '') LIKE ?{k}))"
    );
    match mode {
        "generic" => format!("({generic})"),
        "trade" => format!("({trade})"),
        _ => format!("({trade} OR {generic})"),
    }
}

fn run_hits(conn: &Connection, where_sql: &str, args: Vec<String>) -> Result<Vec<ProductHit>, String> {
    let sql = format!(
        "{HIT_SELECT} WHERE p.is_active = 1 AND ({where_sql}) ORDER BY (stock > 0) DESC, p.trade_name LIMIT 40"
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), map_hit).map_err(err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
}

#[tauri::command]
fn search_products(db: State<'_, Db>, query: String, mode: String) -> Result<Vec<ProductHit>, String> {
    let conn = db.0.lock().map_err(err)?;
    search_inner(&conn, &query, &mode)
}

fn search_inner(conn: &Connection, query: &str, mode: &str) -> Result<Vec<ProductHit>, String> {
    let tokens: Vec<String> = query.split_whitespace().map(|t| format!("%{t}%")).collect();
    if tokens.is_empty() {
        return Ok(vec![]);
    }
    if mode == "alternatives" {
        let inner: Vec<String> = (1..=tokens.len()).map(|k| token_condition("p2", "any", k)).collect();
        let where_sql = format!(
            "p.composition_key != '' AND p.composition_key IN (SELECT p2.composition_key FROM products p2 WHERE {})",
            inner.join(" AND ")
        );
        return run_hits(conn, &where_sql, tokens);
    }
    let conds: Vec<String> = (1..=tokens.len()).map(|k| token_condition("p", mode, k)).collect();
    run_hits(conn, &conds.join(" AND "), tokens)
}

#[tauri::command]
fn find_by_code(db: State<'_, Db>, codes: Vec<String>) -> Result<Option<ProductHit>, String> {
    let conn = db.0.lock().map_err(err)?;
    for code in codes {
        let pid: Option<String> = conn
            .query_row("SELECT product_id FROM product_barcodes WHERE code = ?1", params![code], |r| r.get(0))
            .optional()
            .map_err(err)?;
        if let Some(pid) = pid {
            let mut hits = run_hits(&conn, "p.id = ?1", vec![pid])?;
            return Ok(hits.pop());
        }
    }
    Ok(None)
}

#[tauri::command]
fn alternatives(db: State<'_, Db>, product_id: String) -> Result<Vec<ProductHit>, String> {
    let conn = db.0.lock().map_err(err)?;
    run_hits(
        &conn,
        "p.composition_key != '' AND p.id != ?1 AND p.composition_key = (SELECT composition_key FROM products WHERE id = ?1)",
        vec![product_id],
    )
}

#[tauri::command]
fn product_batches(db: State<'_, Db>, product_id: String) -> Result<Vec<BatchDto>, String> {
    let conn = db.0.lock().map_err(err)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, product_id, batch_no, expiry_date, qty_on_hand, unit_cost, sell_price, received_at
             FROM batches WHERE product_id = ?1 AND status = 'active' AND qty_on_hand > 0
             ORDER BY expiry_date, received_at",
        )
        .map_err(err)?;
    let rows = stmt
        .query_map(params![product_id], |r| {
            Ok(BatchDto {
                id: r.get(0)?,
                product_id: r.get(1)?,
                batch_no: r.get(2)?,
                expiry_date: r.get(3)?,
                qty_on_hand: r.get(4)?,
                unit_cost: r.get(5)?,
                sell_price: r.get(6)?,
                received_at: r.get(7)?,
            })
        })
        .map_err(err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
}

// ── Posting a sale ──

fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

fn append_audit(
    tx: &rusqlite::Transaction,
    user_id: &str,
    action: &str,
    entity: &str,
    entity_id: &str,
    payload: &str,
    occurred_at: &str,
) -> rusqlite::Result<()> {
    let prev: String = tx
        .query_row("SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1", [], |r| r.get(0))
        .optional()?
        .unwrap_or_else(|| "GENESIS".to_string());
    let mut h = Sha256::new();
    h.update(format!("{prev}|{user_id}|{action}|{entity}|{entity_id}|{payload}|{occurred_at}"));
    let hash = format!("{:x}", h.finalize());
    tx.execute(
        "INSERT INTO audit_log(user_id, action, entity, entity_id, payload, prev_hash, hash, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![user_id, action, entity, entity_id, payload, prev, hash, occurred_at],
    )?;
    Ok(())
}

// ── Sign-in ──

const MIN_PASSWORD_LEN: usize = 8;
const BAD_LOGIN: &str = "اسم المستخدم أو كلمة المرور غير صحيحة";

fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default().hash_password(password.as_bytes(), &salt).map(|h| h.to_string()).map_err(err)
}

fn verify_password(password: &str, stored: &str) -> bool {
    PasswordHash::new(stored)
        .map(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
        .unwrap_or(false)
}

fn active_user(conn: &Connection, user_id: &str) -> Result<Option<UserDto>, String> {
    let found: Option<(String, String, String, String)> = conn
        .query_row(
            "SELECT id, username, full_name, role FROM users WHERE id = ?1 AND is_active = 1",
            params![user_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(err)?;
    match found {
        Some((id, username, full_name, role)) => {
            let permissions = effective_permissions(conn, &id, &role)?;
            Ok(Some(UserDto { id, username, full_name, role, permissions }))
        }
        None => Ok(None),
    }
}

/// No active user has a password yet: a fresh install, before the admin has chosen one.
fn needs_setup(conn: &Connection) -> Result<bool, String> {
    conn.query_row(
        "SELECT NOT EXISTS (SELECT 1 FROM users WHERE is_active = 1 AND password_hash IS NOT NULL)",
        [],
        |r| r.get(0),
    )
    .map_err(err)
}

fn utc_now(conn: &Connection) -> Result<String, String> {
    conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |r| r.get(0)).map_err(err)
}

/// First run only: sets the password of the first admin account and signs it in.
fn setup_admin_inner(conn: &mut Connection, password: &str) -> Result<UserDto, String> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(format!("كلمة المرور يجب ألا تقل عن {MIN_PASSWORD_LEN} أحرف"));
    }
    let tx = conn.transaction().map_err(err)?;
    if !needs_setup(&tx)? {
        return Err("تم إعداد كلمة المرور مسبقاً، سجّل الدخول".into());
    }
    let admin_id: String = tx
        .query_row(
            "SELECT id FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY created_at, id LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?
        .ok_or("لا يوجد حساب مدير لإعداده")?;
    tx.execute("UPDATE users SET password_hash = ?1 WHERE id = ?2", params![hash_password(password)?, admin_id])
        .map_err(err)?;
    let now = utc_now(&tx)?;
    append_audit(&tx, &admin_id, "user.setup", "users", &admin_id, "{}", &now).map_err(err)?;
    let user = active_user(&tx, &admin_id)?.ok_or(BAD_LOGIN)?;
    tx.commit().map_err(err)?;
    Ok(user)
}

fn login_inner(conn: &mut Connection, username: &str, password: &str) -> Result<UserDto, String> {
    let found: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT id, password_hash FROM users WHERE username = ?1 AND is_active = 1",
            params![username.trim()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(err)?;
    let user_id = match found {
        Some((id, Some(hash))) if verify_password(password, &hash) => id,
        _ => return Err(BAD_LOGIN.into()),
    };
    let tx = conn.transaction().map_err(err)?;
    let now = utc_now(&tx)?;
    append_audit(&tx, &user_id, "user.login", "users", &user_id, "{}", &now).map_err(err)?;
    let user = active_user(&tx, &user_id)?.ok_or(BAD_LOGIN)?;
    tx.commit().map_err(err)?;
    Ok(user)
}

#[tauri::command]
fn auth_status(db: State<'_, Db>, session: State<'_, Session>) -> Result<AuthStatus, String> {
    let conn = db.0.lock().map_err(err)?;
    let current = session.0.lock().map_err(err)?.clone();
    let user = match current {
        Some(id) => active_user(&conn, &id)?,
        None => None,
    };
    Ok(AuthStatus { needs_setup: needs_setup(&conn)?, user })
}

#[tauri::command]
fn setup_admin(db: State<'_, Db>, session: State<'_, Session>, password: String) -> Result<UserDto, String> {
    let mut conn = db.0.lock().map_err(err)?;
    let user = setup_admin_inner(&mut conn, &password)?;
    *session.0.lock().map_err(err)? = Some(user.id.clone());
    Ok(user)
}

#[tauri::command]
fn login(db: State<'_, Db>, session: State<'_, Session>, username: String, password: String) -> Result<UserDto, String> {
    let mut conn = db.0.lock().map_err(err)?;
    let user = login_inner(&mut conn, &username, &password)?;
    *session.0.lock().map_err(err)? = Some(user.id.clone());
    Ok(user)
}

#[tauri::command]
fn logout(session: State<'_, Session>) -> Result<(), String> {
    *session.0.lock().map_err(err)? = None;
    Ok(())
}

// ── Sale rules ──

/// Roles that may give any discount; everyone else with `give_discount` is held to the `max_discount_pct` setting.
const UNLIMITED_DISCOUNT_ROLES: [&str; 2] = ["admin", "chief_pharmacist"];

#[tauri::command]
fn post_sale(db: State<'_, Db>, session: State<'_, Session>, draft: SaleDraft) -> Result<SaleResult, String> {
    let user_id = session.0.lock().map_err(err)?.clone().ok_or("سجّل الدخول أولاً")?;
    let mut conn = db.0.lock().map_err(err)?;
    post_sale_inner(&mut conn, &user_id, draft)
}

fn post_sale_inner(conn: &mut Connection, user_id: &str, draft: SaleDraft) -> Result<SaleResult, String> {
    if draft.lines.is_empty() {
        return Err("الفاتورة فارغة".into());
    }
    let tx = conn.transaction().map_err(err)?;

    // The role is read from the database inside the transaction, so a disabled account cannot keep selling.
    let role = active_role(&tx, user_id)?;

    // Totals are recomputed here from database prices; the screen's numbers are only checked, never used.
    let mut subtotal = 0i64;
    let mut line_discounts = 0i64;
    let mut needs_rx = false;
    for l in &draft.lines {
        let qty: i64 = l.allocations.iter().map(|a| a.qty).sum();
        if qty <= 0 || l.allocations.iter().any(|a| a.qty <= 0) {
            return Err("كمية غير صالحة في أحد الأسطر".into());
        }
        let (name, price, requires_rx): (String, i64, bool) = tx
            .query_row(
                "SELECT trade_name, sell_price, requires_rx FROM products WHERE id = ?1 AND is_active = 1",
                params![l.product_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)),
            )
            .optional()
            .map_err(err)?
            .ok_or("صنف غير موجود أو موقوف، حدّث السلة")?;
        if l.unit_price != price {
            return Err(format!("سعر {name} أصبح {price} د.ع، حدّث السلة"));
        }
        needs_rx |= requires_rx;
        let gross = price.checked_mul(qty).ok_or("كمية غير صالحة في أحد الأسطر")?;
        if l.discount < 0 || l.discount > gross {
            return Err(format!("خصم غير صالح على {name}"));
        }
        subtotal += gross;
        line_discounts += l.discount;
    }
    let after_lines = subtotal - line_discounts;
    if draft.invoice_discount < 0 || draft.invoice_discount > after_lines {
        return Err("خصم الفاتورة غير صالح".into());
    }
    let invoice_discount = draft.invoice_discount;
    let total = after_lines - invoice_discount;

    if line_discounts + invoice_discount > 0 && !has_permission(&tx, user_id, &role, "give_discount")? {
        return Err(denied_message("give_discount").into());
    }
    if !UNLIMITED_DISCOUNT_ROLES.contains(&role.as_str()) {
        let max_pct: i64 = tx
            .query_row("SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'max_discount_pct'", [], |r| r.get(0))
            .optional()
            .map_err(err)?
            .unwrap_or(0);
        if (line_discounts + invoice_discount) * 100 > subtotal * max_pct {
            return Err(format!("الخصم يتجاوز الحد المسموح ({max_pct}٪ من المجموع)، يحتاج موافقة المدير"));
        }
    }

    let prescription = if needs_rx {
        if !has_permission(&tx, user_id, &role, "dispense_rx")? {
            return Err(denied_message("dispense_rx").into());
        }
        let rx = draft.prescription.as_ref().map(|p| (p.rx_no.trim(), p.prescriber.trim()));
        match rx {
            Some((no, by)) if !no.is_empty() && !by.is_empty() => Some((no.to_string(), by.to_string())),
            _ => return Err("الفاتورة تحتوي دواءً بوصفة طبية: أدخل رقم الوصفة واسم الطبيب".into()),
        }
    } else {
        None
    };

    // Settle: card and credit first (never more than owed), cash last (may produce change).
    let mut remaining = total;
    let mut change = 0i64;
    let mut on_credit = 0i64;
    let mut applied: Vec<(String, i64, Option<String>)> = vec![];
    let mut ordered: Vec<&PaymentIn> = draft.payments.iter().filter(|p| p.amount > 0).collect();
    ordered.sort_by_key(|p| if p.method == "cash" { 1 } else { 0 });
    for p in ordered {
        if !matches!(p.method.as_str(), "cash" | "card" | "credit") {
            return Err(format!("طريقة دفع غير معروفة: {}", p.method));
        }
        let take = p.amount.min(remaining);
        if p.method == "cash" {
            change += p.amount - take;
        }
        if p.method == "credit" {
            on_credit += take;
        }
        remaining -= take;
        if take > 0 {
            applied.push((p.method.clone(), take, p.reference.clone()));
        }
    }
    if remaining > 0 {
        return Err(format!("المبلغ المدفوع أقل من المطلوب بـ {remaining} د.ع"));
    }
    if on_credit > 0 && draft.patient_id.is_none() {
        return Err("البيع بالآجل يتطلب اختيار عميل".into());
    }

    let branch_id: String = tx
        .query_row("SELECT id FROM branches ORDER BY created_at LIMIT 1", [], |r| r.get(0))
        .map_err(err)?;
    let (now, year): (String, String) = tx
        .query_row(
            "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y', 'now', 'localtime')",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(err)?;
    tx.execute(
        "UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'invoice_counter'",
        [],
    )
    .map_err(err)?;
    let counter: i64 = tx
        .query_row("SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'invoice_counter'", [], |r| r.get(0))
        .map_err(err)?;
    let prefix: String = tx
        .query_row("SELECT value FROM settings WHERE key = 'invoice_prefix'", [], |r| r.get(0))
        .map_err(err)?;
    let invoice_no = format!("{prefix}-{year}-{counter:06}");
    let sale_id = new_id();
    let paid = total;

    tx.execute(
        "INSERT INTO sales(id, invoice_no, branch_id, patient_id, cashier_id, subtotal, discount_total, total, paid,
                           change_given, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'paid', ?11)",
        params![
            sale_id,
            invoice_no,
            branch_id,
            draft.patient_id,
            user_id,
            subtotal,
            line_discounts + invoice_discount,
            total,
            paid,
            change,
            now
        ],
    )
    .map_err(err)?;
    if let Some((rx_no, prescriber)) = &prescription {
        tx.execute(
            "INSERT INTO sale_prescriptions(sale_id, rx_no, prescriber, verified_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![sale_id, rx_no, prescriber, user_id, now],
        )
        .map_err(err)?;
    }

    for l in &draft.lines {
        let mut discount_left = l.discount.max(0);
        for a in &l.allocations {
            let unit_cost: i64 = tx
                .query_row(
                    "SELECT unit_cost FROM batches WHERE id = ?1 AND product_id = ?2",
                    params![a.batch_id, l.product_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(err)?
                .ok_or_else(|| "دفعة غير موجودة لهذا الصنف".to_string())?;
            let changed = tx
                .execute(
                    "UPDATE batches SET qty_on_hand = qty_on_hand - ?1
                     WHERE id = ?2 AND qty_on_hand >= ?1 AND status = 'active'
                       AND expiry_date > date('now', 'localtime')",
                    params![a.qty, a.batch_id],
                )
                .map_err(err)?;
            if changed != 1 {
                let batch_no: String = tx
                    .query_row("SELECT batch_no FROM batches WHERE id = ?1", params![a.batch_id], |r| r.get(0))
                    .unwrap_or_default();
                return Err(format!("الدفعة {batch_no} لم تعد تكفي أو انتهت صلاحيتها، حدّث السلة"));
            }
            let gross = l.unit_price * a.qty;
            let d = discount_left.min(gross);
            discount_left -= d;
            let item_id = new_id();
            tx.execute(
                "INSERT INTO sale_items(id, sale_id, product_id, batch_id, qty, unit_price, unit_cost, discount,
                                        line_total, fefo_override_reason)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    item_id,
                    sale_id,
                    l.product_id,
                    a.batch_id,
                    a.qty,
                    l.unit_price,
                    unit_cost,
                    d,
                    gross - d,
                    l.fefo_override_reason
                ],
            )
            .map_err(err)?;
            tx.execute(
                "INSERT INTO stock_movements(id, batch_id, type, qty, unit_cost, ref_type, ref_id, user_id, occurred_at)
                 VALUES (?1, ?2, 'sale', ?3, ?4, 'sale', ?5, ?6, ?7)",
                params![new_id(), a.batch_id, -a.qty, unit_cost, sale_id, user_id, now],
            )
            .map_err(err)?;
        }
    }

    for (method, amount, reference) in &applied {
        tx.execute(
            "INSERT INTO payments(id, sale_id, method, amount, reference) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![new_id(), sale_id, method, amount, reference],
        )
        .map_err(err)?;
    }
    if on_credit > 0 {
        let pid = draft.patient_id.clone().unwrap_or_default();
        let ok = tx
            .execute(
                "UPDATE patients SET balance = balance + ?1 WHERE id = ?2 AND balance + ?1 <= credit_limit",
                params![on_credit, pid],
            )
            .map_err(err)?;
        if ok != 1 {
            return Err("المبلغ الآجل يتجاوز سقف الائتمان لهذا العميل".into());
        }
    }

    let payload = serde_json::json!({
        "invoiceNo": invoice_no,
        "total": total,
        "lines": draft.lines.len(),
        "discount": line_discounts + invoice_discount,
        "rxNo": prescription.as_ref().map(|(no, _)| no),
    })
    .to_string();
    append_audit(&tx, user_id, "sale.create", "sales", &sale_id, &payload, &now).map_err(err)?;
    tx.commit().map_err(err)?;

    Ok(SaleResult { sale_id, invoice_no, total, paid, change, created_at: now })
}

// ── Inventory ──

fn session_user(session: &State<'_, Session>) -> Result<String, String> {
    session.0.lock().map_err(err)?.clone().ok_or_else(|| "سجّل الدخول أولاً".to_string())
}

/// True when `d` is a real calendar date written as YYYY-MM-DD.
fn is_iso_date(conn: &Connection, d: &str) -> Result<bool, String> {
    conn.query_row("SELECT date(?1) IS NOT NULL AND date(?1) = ?1", params![d], |r| r.get(0)).map_err(err)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InventoryItem {
    id: String,
    barcode: Option<String>,
    trade_name: String,
    trade_name_ar: Option<String>,
    category: Option<String>,
    form: String,
    strength: String,
    pack_size: i64,
    price: i64,
    requires_rx: bool,
    /// Sellable quantity: active batches that have not expired.
    stock: i64,
    /// Quantity still on the shelf in expired batches (must be removed, never sold).
    expired_qty: i64,
    /// Earliest expiry among sellable batches — the next one FEFO will sell.
    nearest_expiry: Option<String>,
    /// From reorder_rules; at or below this the item counts as low stock.
    reorder_level: Option<i64>,
}

const INVENTORY_SELECT: &str = "SELECT p.id,
  (SELECT code FROM product_barcodes pb WHERE pb.product_id = p.id ORDER BY code LIMIT 1),
  p.trade_name, p.trade_name_ar, c.name_ar, p.dosage_form, p.strength_label, p.pack_size, p.sell_price, p.requires_rx,
  COALESCE((SELECT SUM(b.qty_on_hand) FROM batches b WHERE b.product_id = p.id AND b.status = 'active'
            AND b.expiry_date > date('now', 'localtime')), 0),
  COALESCE((SELECT SUM(b.qty_on_hand) FROM batches b WHERE b.product_id = p.id
            AND (b.status = 'expired' OR b.expiry_date <= date('now', 'localtime'))), 0),
  (SELECT MIN(b.expiry_date) FROM batches b WHERE b.product_id = p.id AND b.status = 'active'
            AND b.qty_on_hand > 0 AND b.expiry_date > date('now', 'localtime')),
  (SELECT rr.reorder_level FROM reorder_rules rr WHERE rr.product_id = p.id LIMIT 1)
  FROM products p LEFT JOIN categories c ON c.id = p.category_id
  WHERE p.is_active = 1";

fn map_inventory(r: &rusqlite::Row) -> rusqlite::Result<InventoryItem> {
    Ok(InventoryItem {
        id: r.get(0)?,
        barcode: r.get(1)?,
        trade_name: r.get(2)?,
        trade_name_ar: r.get(3)?,
        category: r.get(4)?,
        form: r.get(5)?,
        strength: r.get(6)?,
        pack_size: r.get(7)?,
        price: r.get(8)?,
        requires_rx: r.get::<_, i64>(9)? != 0,
        stock: r.get(10)?,
        expired_qty: r.get(11)?,
        nearest_expiry: r.get(12)?,
        reorder_level: r.get(13)?,
    })
}

fn inventory_list_inner(conn: &Connection) -> Result<Vec<InventoryItem>, String> {
    let mut stmt = conn.prepare(&format!("{INVENTORY_SELECT} ORDER BY p.trade_name")).map_err(err)?;
    let rows = stmt.query_map([], map_inventory).map_err(err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
}

fn inventory_item(conn: &Connection, product_id: &str) -> Result<InventoryItem, String> {
    conn.query_row(&format!("{INVENTORY_SELECT} AND p.id = ?1"), params![product_id], map_inventory).map_err(err)
}

#[tauri::command]
fn inventory_list(db: State<'_, Db>, session: State<'_, Session>) -> Result<Vec<InventoryItem>, String> {
    session_user(&session)?;
    let conn = db.0.lock().map_err(err)?;
    inventory_list_inner(&conn)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryBatch {
    id: String,
    batch_no: String,
    expiry_date: String,
    qty_on_hand: i64,
    unit_cost: i64,
    sell_price: i64,
    status: String,
    received_at: String,
}

/// Every batch of a product that still holds stock, expired ones included, in FEFO order.
fn inventory_batches_inner(conn: &Connection, product_id: &str) -> Result<Vec<InventoryBatch>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, batch_no, expiry_date, qty_on_hand, unit_cost, sell_price, status, received_at
             FROM batches WHERE product_id = ?1 AND qty_on_hand > 0 ORDER BY expiry_date, received_at",
        )
        .map_err(err)?;
    let rows = stmt
        .query_map(params![product_id], |r| {
            Ok(InventoryBatch {
                id: r.get(0)?,
                batch_no: r.get(1)?,
                expiry_date: r.get(2)?,
                qty_on_hand: r.get(3)?,
                unit_cost: r.get(4)?,
                sell_price: r.get(5)?,
                status: r.get(6)?,
                received_at: r.get(7)?,
            })
        })
        .map_err(err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
}

#[tauri::command]
fn inventory_batches(
    db: State<'_, Db>,
    session: State<'_, Session>,
    product_id: String,
) -> Result<Vec<InventoryBatch>, String> {
    session_user(&session)?;
    let conn = db.0.lock().map_err(err)?;
    inventory_batches_inner(&conn, &product_id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    id: String,
    name_ar: String,
}

#[tauri::command]
fn list_categories(db: State<'_, Db>, session: State<'_, Session>) -> Result<Vec<Category>, String> {
    session_user(&session)?;
    let conn = db.0.lock().map_err(err)?;
    let mut stmt = conn.prepare("SELECT id, name_ar FROM categories ORDER BY name_ar").map_err(err)?;
    let rows = stmt.query_map([], |r| Ok(Category { id: r.get(0)?, name_ar: r.get(1)? })).map_err(err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProduct {
    trade_name: String,
    trade_name_ar: Option<String>,
    category_id: Option<String>,
    dosage_form: String,
    strength: String,
    pack_size: i64,
    price: i64,
    requires_rx: bool,
    barcode: Option<String>,
    reorder_level: Option<i64>,
}

fn non_empty(s: &Option<String>) -> Option<String> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

fn add_product_inner(conn: &mut Connection, user_id: &str, p: NewProduct) -> Result<InventoryItem, String> {
    let tx = conn.transaction().map_err(err)?;
    require_permission(&tx, user_id, &["modify_inventory"])?;
    let (name, form, strength) = (p.trade_name.trim(), p.dosage_form.trim(), p.strength.trim());
    if name.is_empty() || form.is_empty() || strength.is_empty() {
        return Err("الاسم التجاري والشكل الدوائي والتركيز حقول مطلوبة".into());
    }
    if p.price <= 0 {
        return Err("سعر البيع يجب أن يكون أكبر من صفر".into());
    }
    if p.pack_size < 1 {
        return Err("حجم العبوة يجب أن يكون ١ على الأقل".into());
    }
    if p.reorder_level.is_some_and(|n| n < 0) {
        return Err("حد إعادة الطلب لا يكون سالباً".into());
    }
    let barcode = non_empty(&p.barcode);
    if let Some(code) = &barcode {
        if !code.chars().all(|c| c.is_ascii_digit()) || !(8..=14).contains(&code.len()) {
            return Err("الباركود يجب أن يكون من ٨ إلى ١٤ رقماً".into());
        }
        let owner: Option<String> = tx
            .query_row(
                "SELECT p.trade_name FROM product_barcodes b JOIN products p ON p.id = b.product_id WHERE b.code = ?1",
                params![code],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        if let Some(owner) = owner {
            return Err(format!("الباركود مسجّل مسبقاً للصنف {owner}"));
        }
    }
    let category = non_empty(&p.category_id);
    if let Some(c) = &category {
        let exists: bool = tx
            .query_row("SELECT EXISTS (SELECT 1 FROM categories WHERE id = ?1)", params![c], |r| r.get(0))
            .map_err(err)?;
        if !exists {
            return Err("التصنيف غير موجود".into());
        }
    }

    let id = new_id();
    tx.execute(
        "INSERT INTO products(id, trade_name, trade_name_ar, category_id, dosage_form, strength_label, pack_size,
                              requires_rx, sell_price)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, name, non_empty(&p.trade_name_ar), category, form, strength, p.pack_size, p.requires_rx, p.price],
    )
    .map_err(err)?;
    if let Some(code) = &barcode {
        tx.execute("INSERT INTO product_barcodes(code, product_id) VALUES (?1, ?2)", params![code, id]).map_err(err)?;
    }
    if let Some(level) = p.reorder_level {
        tx.execute(
            "INSERT INTO reorder_rules(product_id, branch_id, reorder_level)
             SELECT ?1, id, ?2 FROM branches ORDER BY created_at LIMIT 1",
            params![id, level],
        )
        .map_err(err)?;
    }
    let now = utc_now(&tx)?;
    let payload = serde_json::json!({ "tradeName": name, "price": p.price, "barcode": barcode }).to_string();
    append_audit(&tx, user_id, "product.create", "products", &id, &payload, &now).map_err(err)?;
    let item = inventory_item(&tx, &id)?;
    tx.commit().map_err(err)?;
    Ok(item)
}

#[tauri::command]
fn add_product(db: State<'_, Db>, session: State<'_, Session>, product: NewProduct) -> Result<InventoryItem, String> {
    let user_id = session_user(&session)?;
    let mut conn = db.0.lock().map_err(err)?;
    add_product_inner(&mut conn, &user_id, product)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiveBatch {
    product_id: String,
    batch_no: String,
    expiry_date: String,
    qty: i64,
    unit_cost: i64,
}

/// Adds stock as a new batch (goods received without a purchase invoice).
fn receive_batch_inner(conn: &mut Connection, user_id: &str, b: ReceiveBatch) -> Result<InventoryItem, String> {
    let tx = conn.transaction().map_err(err)?;
    require_permission(&tx, user_id, &["modify_inventory"])?;
    let batch_no = b.batch_no.trim();
    if batch_no.is_empty() {
        return Err("رقم الدفعة مطلوب".into());
    }
    if b.qty <= 0 {
        return Err("الكمية يجب أن تكون أكبر من صفر".into());
    }
    if b.unit_cost < 0 {
        return Err("سعر الشراء لا يكون سالباً".into());
    }
    if !is_iso_date(&tx, &b.expiry_date)? {
        return Err("تاريخ الانتهاء غير صالح".into());
    }
    let future: bool = tx
        .query_row("SELECT ?1 > date('now', 'localtime')", params![b.expiry_date], |r| r.get(0))
        .map_err(err)?;
    if !future {
        return Err("لا يُستلم مخزون منتهي الصلاحية".into());
    }
    let price: i64 = tx
        .query_row("SELECT sell_price FROM products WHERE id = ?1 AND is_active = 1", params![b.product_id], |r| r.get(0))
        .optional()
        .map_err(err)?
        .ok_or("صنف غير موجود أو موقوف")?;
    let branch_id: String = tx
        .query_row("SELECT id FROM branches ORDER BY created_at LIMIT 1", [], |r| r.get(0))
        .map_err(err)?;
    let duplicate: bool = tx
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM batches WHERE product_id = ?1 AND branch_id = ?2 AND batch_no = ?3)",
            params![b.product_id, branch_id, batch_no],
            |r| r.get(0),
        )
        .map_err(err)?;
    if duplicate {
        return Err(format!("الدفعة {batch_no} موجودة مسبقاً لهذا الصنف، عدّل كميتها بدلاً من ذلك"));
    }

    let id = new_id();
    let now = utc_now(&tx)?;
    tx.execute(
        "INSERT INTO batches(id, product_id, branch_id, batch_no, expiry_date, unit_cost, sell_price, qty_on_hand, received_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, b.product_id, branch_id, batch_no, b.expiry_date, b.unit_cost, price, b.qty, now],
    )
    .map_err(err)?;
    tx.execute(
        "INSERT INTO stock_movements(id, batch_id, type, qty, unit_cost, ref_type, user_id, occurred_at)
         VALUES (?1, ?2, 'purchase', ?3, ?4, 'manual_receipt', ?5, ?6)",
        params![new_id(), id, b.qty, b.unit_cost, user_id, now],
    )
    .map_err(err)?;
    let payload = serde_json::json!({ "productId": b.product_id, "batchNo": batch_no, "qty": b.qty }).to_string();
    append_audit(&tx, user_id, "batch.receive", "batches", &id, &payload, &now).map_err(err)?;
    let item = inventory_item(&tx, &b.product_id)?;
    tx.commit().map_err(err)?;
    Ok(item)
}

#[tauri::command]
fn receive_batch(db: State<'_, Db>, session: State<'_, Session>, batch: ReceiveBatch) -> Result<InventoryItem, String> {
    let user_id = session_user(&session)?;
    let mut conn = db.0.lock().map_err(err)?;
    receive_batch_inner(&mut conn, &user_id, batch)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustBatch {
    batch_id: String,
    /// The quantity actually counted on the shelf.
    new_qty: i64,
    reason: String,
}

/// Stock count correction: sets a batch to the counted quantity and records the difference as an 'adjust' movement.
fn adjust_batch_inner(conn: &mut Connection, user_id: &str, a: AdjustBatch) -> Result<InventoryItem, String> {
    let tx = conn.transaction().map_err(err)?;
    require_permission(&tx, user_id, &["modify_inventory"])?;
    let reason = a.reason.trim();
    if reason.is_empty() {
        return Err("سبب التعديل مطلوب".into());
    }
    if a.new_qty < 0 {
        return Err("الكمية لا تكون سالبة".into());
    }
    let (product_id, old_qty, unit_cost): (String, i64, i64) = tx
        .query_row("SELECT product_id, qty_on_hand, unit_cost FROM batches WHERE id = ?1", params![a.batch_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()
        .map_err(err)?
        .ok_or("الدفعة غير موجودة")?;
    let delta = a.new_qty - old_qty;
    if delta == 0 {
        return Err("الكمية الجديدة مساوية للحالية".into());
    }
    let now = utc_now(&tx)?;
    tx.execute("UPDATE batches SET qty_on_hand = ?1 WHERE id = ?2", params![a.new_qty, a.batch_id]).map_err(err)?;
    tx.execute(
        "INSERT INTO stock_movements(id, batch_id, type, qty, unit_cost, ref_type, user_id, occurred_at)
         VALUES (?1, ?2, 'adjust', ?3, ?4, 'stock_count', ?5, ?6)",
        params![new_id(), a.batch_id, delta, unit_cost, user_id, now],
    )
    .map_err(err)?;
    let payload =
        serde_json::json!({ "from": old_qty, "to": a.new_qty, "reason": reason }).to_string();
    append_audit(&tx, user_id, "batch.adjust", "batches", &a.batch_id, &payload, &now).map_err(err)?;
    let item = inventory_item(&tx, &product_id)?;
    tx.commit().map_err(err)?;
    Ok(item)
}

#[tauri::command]
fn adjust_batch(db: State<'_, Db>, session: State<'_, Session>, adjustment: AdjustBatch) -> Result<InventoryItem, String> {
    let user_id = session_user(&session)?;
    let mut conn = db.0.lock().map_err(err)?;
    adjust_batch_inner(&mut conn, &user_id, adjustment)
}

// ── Purchasing ──

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Supplier {
    id: String,
    name: String,
    phone: Option<String>,
    payment_terms_days: i64,
    /// What the pharmacy owes this supplier.
    balance: i64,
}

fn map_supplier(r: &rusqlite::Row) -> rusqlite::Result<Supplier> {
    Ok(Supplier { id: r.get(0)?, name: r.get(1)?, phone: r.get(2)?, payment_terms_days: r.get(3)?, balance: r.get(4)? })
}

const SUPPLIER_SELECT: &str = "SELECT id, name, phone, payment_terms_days, balance FROM suppliers";

#[tauri::command]
fn list_suppliers(db: State<'_, Db>, session: State<'_, Session>) -> Result<Vec<Supplier>, String> {
    session_user(&session)?;
    let conn = db.0.lock().map_err(err)?;
    let mut stmt = conn.prepare(&format!("{SUPPLIER_SELECT} ORDER BY name")).map_err(err)?;
    let rows = stmt.query_map([], map_supplier).map_err(err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSupplier {
    name: String,
    phone: Option<String>,
    payment_terms_days: Option<i64>,
}

fn add_supplier_inner(conn: &mut Connection, user_id: &str, s: NewSupplier) -> Result<Supplier, String> {
    let tx = conn.transaction().map_err(err)?;
    require_permission(&tx, user_id, &["modify_inventory"])?;
    let name = s.name.trim();
    if name.is_empty() {
        return Err("اسم المورد مطلوب".into());
    }
    let terms = s.payment_terms_days.unwrap_or(30);
    if !(0..=365).contains(&terms) {
        return Err("مدة السداد بين ٠ و٣٦٥ يوماً".into());
    }
    let taken: bool = tx
        .query_row("SELECT EXISTS (SELECT 1 FROM suppliers WHERE name = ?1 COLLATE NOCASE)", params![name], |r| r.get(0))
        .map_err(err)?;
    if taken {
        return Err(format!("المورد {name} موجود مسبقاً"));
    }
    let id = new_id();
    tx.execute(
        "INSERT INTO suppliers(id, name, phone, payment_terms_days) VALUES (?1, ?2, ?3, ?4)",
        params![id, name, non_empty(&s.phone), terms],
    )
    .map_err(err)?;
    let now = utc_now(&tx)?;
    let payload = serde_json::json!({ "name": name }).to_string();
    append_audit(&tx, user_id, "supplier.create", "suppliers", &id, &payload, &now).map_err(err)?;
    let supplier = tx
        .query_row(&format!("{SUPPLIER_SELECT} WHERE id = ?1"), params![id], map_supplier)
        .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(supplier)
}

#[tauri::command]
fn add_supplier(db: State<'_, Db>, session: State<'_, Session>, supplier: NewSupplier) -> Result<Supplier, String> {
    let user_id = session_user(&session)?;
    let mut conn = db.0.lock().map_err(err)?;
    add_supplier_inner(&mut conn, &user_id, supplier)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseLineIn {
    product_id: String,
    batch_no: String,
    expiry_date: String,
    qty: i64,
    /// Purchase price per unit.
    unit_cost: i64,
    /// Retail price per unit; becomes the product's selling price.
    sell_price: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseInvoiceIn {
    supplier_id: String,
    supplier_invoice_no: String,
    invoice_date: String,
    /// "cash": paid on delivery. "credit": added to what we owe the supplier.
    payment: String,
    lines: Vec<PurchaseLineIn>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseResult {
    invoice_id: String,
    total: i64,
    units: i64,
    batches_created: i64,
    batches_updated: i64,
    /// Products whose selling price this invoice changed.
    price_changes: Vec<String>,
    due_date: Option<String>,
    supplier_balance: i64,
}

/// Posts a supplier invoice in one transaction: the invoice and its lines, stock into batches (new batch, or added to
/// the same batch number if it is already on the shelf), stock movements, selling prices, the supplier ledger and audit.
/// Stock posted here is sellable immediately: post_sale draws from the same batches in FEFO order.
fn post_purchase_inner(conn: &mut Connection, user_id: &str, inv: PurchaseInvoiceIn) -> Result<PurchaseResult, String> {
    let tx = conn.transaction().map_err(err)?;
    require_permission(&tx, user_id, &["modify_inventory"])?;

    let (supplier_name, terms): (String, i64) = tx
        .query_row("SELECT name, payment_terms_days FROM suppliers WHERE id = ?1", params![inv.supplier_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()
        .map_err(err)?
        .ok_or("اختر المورد")?;
    let invoice_no = inv.supplier_invoice_no.trim();
    if invoice_no.is_empty() {
        return Err("رقم فاتورة الشراء مطلوب".into());
    }
    let posted_before: bool = tx
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM purchase_invoices WHERE supplier_id = ?1 AND supplier_invoice_no = ?2)",
            params![inv.supplier_id, invoice_no],
            |r| r.get(0),
        )
        .map_err(err)?;
    if posted_before {
        return Err(format!("الفاتورة {invoice_no} من {supplier_name} مُرحّلة مسبقاً"));
    }
    if !is_iso_date(&tx, &inv.invoice_date)? {
        return Err("تاريخ الفاتورة غير صالح".into());
    }
    let future: bool = tx
        .query_row("SELECT ?1 > date('now', 'localtime')", params![inv.invoice_date], |r| r.get(0))
        .map_err(err)?;
    if future {
        return Err("تاريخ الفاتورة في المستقبل".into());
    }
    let on_credit = match inv.payment.as_str() {
        "cash" => false,
        "credit" => true,
        _ => return Err("حالة الدفع يجب أن تكون نقداً أو آجلاً".into()),
    };
    if inv.lines.is_empty() {
        return Err("أضف صنفاً واحداً على الأقل".into());
    }

    // Validate every line before writing anything.
    let mut seen_batches = std::collections::HashSet::new();
    let mut new_prices: std::collections::HashMap<&str, i64> = std::collections::HashMap::new();
    let mut subtotal = 0i64;
    let mut units = 0i64;
    for (i, l) in inv.lines.iter().enumerate() {
        let n = i + 1;
        let name: String = tx
            .query_row("SELECT trade_name FROM products WHERE id = ?1 AND is_active = 1", params![l.product_id], |r| r.get(0))
            .optional()
            .map_err(err)?
            .ok_or_else(|| format!("السطر {n}: صنف غير موجود أو موقوف"))?;
        let batch_no = l.batch_no.trim();
        if batch_no.is_empty() {
            return Err(format!("السطر {n} ({name}): رقم التشغيلة مطلوب"));
        }
        if !is_iso_date(&tx, &l.expiry_date)? {
            return Err(format!("السطر {n} ({name}): تاريخ الانتهاء غير صالح"));
        }
        let sellable: bool = tx
            .query_row("SELECT ?1 > date('now', 'localtime')", params![l.expiry_date], |r| r.get(0))
            .map_err(err)?;
        if !sellable {
            return Err(format!("السطر {n} ({name}): لا يُستلم مخزون منتهي الصلاحية"));
        }
        if l.qty <= 0 {
            return Err(format!("السطر {n} ({name}): الكمية يجب أن تكون أكبر من صفر"));
        }
        if l.unit_cost < 0 {
            return Err(format!("السطر {n} ({name}): سعر الشراء لا يكون سالباً"));
        }
        if l.sell_price <= 0 {
            return Err(format!("السطر {n} ({name}): سعر البيع يجب أن يكون أكبر من صفر"));
        }
        if !seen_batches.insert((l.product_id.as_str(), batch_no)) {
            return Err(format!("السطر {n} ({name}): التشغيلة {batch_no} مكررة في الفاتورة، اجمع الكمية في سطر واحد"));
        }
        if let Some(p) = new_prices.insert(&l.product_id, l.sell_price) {
            if p != l.sell_price {
                return Err(format!("{name}: سعر البيع مختلف بين أسطر الفاتورة"));
            }
        }
        subtotal += l.qty.checked_mul(l.unit_cost).ok_or_else(|| format!("السطر {n}: المبلغ كبير جداً"))?;
        units += l.qty;
    }
    let total = subtotal;

    let branch_id: String = tx
        .query_row("SELECT id FROM branches ORDER BY created_at LIMIT 1", [], |r| r.get(0))
        .map_err(err)?;
    let now = utc_now(&tx)?;
    let due_date: Option<String> = if on_credit {
        Some(
            tx.query_row("SELECT date(?1, '+' || ?2 || ' days')", params![inv.invoice_date, terms], |r| r.get(0))
                .map_err(err)?,
        )
    } else {
        None
    };
    let invoice_id = new_id();
    tx.execute(
        "INSERT INTO purchase_invoices(id, branch_id, supplier_id, supplier_invoice_no, invoice_date, due_date,
                                       subtotal, total, paid, status, posted_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            invoice_id,
            branch_id,
            inv.supplier_id,
            invoice_no,
            inv.invoice_date,
            due_date,
            subtotal,
            total,
            if on_credit { 0 } else { total },
            if on_credit { "posted" } else { "paid" },
            user_id,
            now
        ],
    )
    .map_err(err)?;

    let (mut created, mut updated) = (0i64, 0i64);
    for l in &inv.lines {
        let batch_no = l.batch_no.trim();
        let item_id = new_id();
        tx.execute(
            "INSERT INTO purchase_invoice_items(id, invoice_id, product_id, batch_no, expiry_date, qty, unit_cost, sell_price)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![item_id, invoice_id, l.product_id, batch_no, l.expiry_date, l.qty, l.unit_cost, l.sell_price],
        )
        .map_err(err)?;

        let existing: Option<(String, String, String, i64, i64)> = tx
            .query_row(
                "SELECT id, expiry_date, status, qty_on_hand, unit_cost FROM batches
                 WHERE product_id = ?1 AND branch_id = ?2 AND batch_no = ?3",
                params![l.product_id, branch_id, batch_no],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
            .map_err(err)?;
        let batch_id = match existing {
            Some((id, expiry, status, old_qty, old_cost)) => {
                if expiry != l.expiry_date {
                    return Err(format!(
                        "التشغيلة {batch_no} مسجّلة بتاريخ انتهاء {expiry}، والفاتورة تذكر {}. تحقّق من العبوة",
                        l.expiry_date
                    ));
                }
                if status != "active" {
                    return Err(format!("التشغيلة {batch_no} موقوفة ({status}) ولا تُضاف إليها كمية"));
                }
                // Weighted average cost, so profit on later sales stays right.
                let qty = old_qty + l.qty;
                let cost = (old_qty * old_cost + l.qty * l.unit_cost + qty / 2) / qty;
                tx.execute(
                    "UPDATE batches SET qty_on_hand = ?1, unit_cost = ?2, sell_price = ?3, source_item_id = ?4,
                                        supplier_id = ?5
                     WHERE id = ?6",
                    params![qty, cost, l.sell_price, item_id, inv.supplier_id, id],
                )
                .map_err(err)?;
                updated += 1;
                id
            }
            None => {
                let id = new_id();
                tx.execute(
                    "INSERT INTO batches(id, product_id, branch_id, batch_no, expiry_date, unit_cost, sell_price, qty_on_hand,
                                         supplier_id, source_item_id, received_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![
                        id,
                        l.product_id,
                        branch_id,
                        batch_no,
                        l.expiry_date,
                        l.unit_cost,
                        l.sell_price,
                        l.qty,
                        inv.supplier_id,
                        item_id,
                        now
                    ],
                )
                .map_err(err)?;
                created += 1;
                id
            }
        };
        tx.execute(
            "INSERT INTO stock_movements(id, batch_id, type, qty, unit_cost, ref_type, ref_id, user_id, occurred_at)
             VALUES (?1, ?2, 'purchase', ?3, ?4, 'purchase_invoice', ?5, ?6, ?7)",
            params![new_id(), batch_id, l.qty, l.unit_cost, invoice_id, user_id, now],
        )
        .map_err(err)?;
    }

    // The invoice's retail price becomes the product's price; the till checks sales against it.
    let mut price_changes = vec![];
    let mut changed: Vec<(&str, i64)> = new_prices.into_iter().collect();
    changed.sort();
    for (product_id, price) in changed {
        let (name, old): (String, i64) = tx
            .query_row("SELECT trade_name, sell_price FROM products WHERE id = ?1", params![product_id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(err)?;
        if old != price {
            tx.execute("UPDATE products SET sell_price = ?1 WHERE id = ?2", params![price, product_id]).map_err(err)?;
            let payload = serde_json::json!({ "from": old, "to": price, "invoiceId": invoice_id }).to_string();
            append_audit(&tx, user_id, "product.price", "products", product_id, &payload, &now).map_err(err)?;
            price_changes.push(name);
        }
    }

    // Supplier account: the invoice is what we owe; a cash invoice is settled by a payment at once.
    tx.execute(
        "INSERT INTO supplier_ledger(id, supplier_id, entry_type, ref_id, credit, entry_date, note)
         VALUES (?1, ?2, 'invoice', ?3, ?4, ?5, ?6)",
        params![new_id(), inv.supplier_id, invoice_id, total, inv.invoice_date, invoice_no],
    )
    .map_err(err)?;
    if on_credit {
        tx.execute("UPDATE suppliers SET balance = balance + ?1 WHERE id = ?2", params![total, inv.supplier_id])
            .map_err(err)?;
    } else {
        tx.execute(
            "INSERT INTO supplier_ledger(id, supplier_id, entry_type, ref_id, debit, entry_date, note)
             VALUES (?1, ?2, 'payment', ?3, ?4, ?5, 'نقداً عند الاستلام')",
            params![new_id(), inv.supplier_id, invoice_id, total, inv.invoice_date],
        )
        .map_err(err)?;
    }
    let supplier_balance: i64 = tx
        .query_row("SELECT balance FROM suppliers WHERE id = ?1", params![inv.supplier_id], |r| r.get(0))
        .map_err(err)?;

    let payload = serde_json::json!({
        "supplierId": inv.supplier_id,
        "invoiceNo": invoice_no,
        "total": total,
        "lines": inv.lines.len(),
        "payment": inv.payment,
    })
    .to_string();
    append_audit(&tx, user_id, "purchase.post", "purchase_invoices", &invoice_id, &payload, &now).map_err(err)?;
    tx.commit().map_err(err)?;

    Ok(PurchaseResult {
        invoice_id,
        total,
        units,
        batches_created: created,
        batches_updated: updated,
        price_changes,
        due_date,
        supplier_balance,
    })
}

#[tauri::command]
fn post_purchase_invoice(
    db: State<'_, Db>,
    session: State<'_, Session>,
    invoice: PurchaseInvoiceIn,
) -> Result<PurchaseResult, String> {
    let user_id = session_user(&session)?;
    let mut conn = db.0.lock().map_err(err)?;
    post_purchase_inner(&mut conn, &user_id, invoice)
}

// ── Reports ──
// All read-only. Sales, profit and prescription reports need `view_reports`; stock reports `modify_inventory` or
// `view_reports`.
// Dates in filters are local calendar days (YYYY-MM-DD), both ends included.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportFilter {
    from: String,
    to: String,
    cashier_id: Option<String>,
    category_id: Option<String>,
}

fn check_range(conn: &Connection, f: &ReportFilter) -> Result<(), String> {
    if !is_iso_date(conn, &f.from)? || !is_iso_date(conn, &f.to)? {
        return Err("تاريخ البداية أو النهاية غير صالح".into());
    }
    if f.from > f.to {
        return Err("تاريخ البداية بعد تاريخ النهاية".into());
    }
    Ok(())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UserRef {
    id: String,
    full_name: String,
}

/// Users who can appear in a report filter (everyone who has sold, active or not).
#[tauri::command]
fn report_users(db: State<'_, Db>, session: State<'_, Session>) -> Result<Vec<UserRef>, String> {
    let user_id = session_user(&session)?;
    let conn = db.0.lock().map_err(err)?;
    require_permission(&conn, &user_id, &["view_reports"])?;
    let mut stmt = conn.prepare("SELECT id, full_name FROM users ORDER BY full_name").map_err(err)?;
    let rows = stmt.query_map([], |r| Ok(UserRef { id: r.get(0)?, full_name: r.get(1)? })).map_err(err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
}

// ── Sales and profit ──

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SalesTotals {
    invoices: i64,
    units: i64,
    /// Before any discount.
    gross: i64,
    /// Line discounts plus each invoice's discount, shared over its lines.
    discounts: i64,
    net: i64,
    /// What the stock sold cost us (batch unit cost at the time of sale).
    cost: i64,
    profit: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SalesRow {
    /// Cashier id, day or product id, depending on the grouping.
    key: String,
    label: String,
    invoices: i64,
    units: i64,
    discounts: i64,
    net: i64,
    profit: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SalesReport {
    totals: SalesTotals,
    by_cashier: Vec<SalesRow>,
    by_day: Vec<SalesRow>,
    top_products: Vec<SalesRow>,
}

/// One row per sale item in the filter. The invoice discount is shared over the sale's lines by value, so totals per
/// cashier, day, product or category add up to the invoice totals. ?1 from, ?2 to, ?3 cashier, ?4 category.
const SALE_ITEMS_CTE: &str = "WITH s AS (
    SELECT s.id, s.cashier_id, date(s.created_at, 'localtime') AS day,
           s.discount_total - COALESCE((SELECT SUM(discount) FROM sale_items WHERE sale_id = s.id), 0) AS inv_disc,
           COALESCE((SELECT SUM(line_total) FROM sale_items WHERE sale_id = s.id), 0) AS lines_total
    FROM sales s
    WHERE s.status = 'paid' AND date(s.created_at, 'localtime') BETWEEN ?1 AND ?2 AND (?3 IS NULL OR s.cashier_id = ?3)
  ), i AS (
    SELECT s.id AS sale_id, s.cashier_id, s.day, it.product_id, p.trade_name, it.qty,
           it.qty * it.unit_price AS gross,
           it.qty * it.unit_cost AS cost,
           it.discount + CASE WHEN s.lines_total > 0 THEN s.inv_disc * 1.0 * it.line_total / s.lines_total ELSE 0 END AS disc
    FROM s JOIN sale_items it ON it.sale_id = s.id JOIN products p ON p.id = it.product_id
    WHERE (?4 IS NULL OR p.category_id = ?4)
  )";

const SALES_AGG: &str = "COUNT(DISTINCT sale_id), COALESCE(SUM(qty), 0),
  CAST(ROUND(COALESCE(SUM(disc), 0)) AS INTEGER),
  CAST(ROUND(COALESCE(SUM(gross - disc), 0)) AS INTEGER),
  CAST(ROUND(COALESCE(SUM(gross - disc - cost), 0)) AS INTEGER)";

fn sales_rows(conn: &Connection, f: &ReportFilter, key: &str, label: &str, tail: &str) -> Result<Vec<SalesRow>, String> {
    let sql = format!("{SALE_ITEMS_CTE} SELECT {key}, {label}, {SALES_AGG} FROM i {tail}");
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let rows = stmt
        .query_map(params![f.from, f.to, f.cashier_id, f.category_id], |r| {
            Ok(SalesRow {
                key: r.get(0)?,
                label: r.get(1)?,
                invoices: r.get(2)?,
                units: r.get(3)?,
                discounts: r.get(4)?,
                net: r.get(5)?,
                profit: r.get(6)?,
            })
        })
        .map_err(err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
}

fn report_sales_inner(conn: &Connection, f: &ReportFilter) -> Result<SalesReport, String> {
    check_range(conn, f)?;
    let totals = conn
        .query_row(
            &format!(
                "{SALE_ITEMS_CTE} SELECT COUNT(DISTINCT sale_id), COALESCE(SUM(qty), 0), COALESCE(SUM(gross), 0),
                   CAST(ROUND(COALESCE(SUM(disc), 0)) AS INTEGER), COALESCE(SUM(cost), 0) FROM i"
            ),
            params![f.from, f.to, f.cashier_id, f.category_id],
            |r| {
                let (gross, discounts, cost): (i64, i64, i64) = (r.get(2)?, r.get(3)?, r.get(4)?);
                Ok(SalesTotals {
                    invoices: r.get(0)?,
                    units: r.get(1)?,
                    gross,
                    discounts,
                    net: gross - discounts,
                    cost,
                    profit: gross - discounts - cost,
                })
            },
        )
        .map_err(err)?;
    Ok(SalesReport {
        totals,
        by_cashier: sales_rows(
            conn,
            f,
            "i.cashier_id",
            "COALESCE((SELECT full_name FROM users WHERE id = i.cashier_id), '—')",
            "GROUP BY i.cashier_id ORDER BY 6 DESC",
        )?,
        by_day: sales_rows(conn, f, "day", "day", "GROUP BY day ORDER BY day")?,
        top_products: sales_rows(conn, f, "product_id", "trade_name", "GROUP BY product_id ORDER BY 6 DESC LIMIT 20")?,
    })
}

#[tauri::command]
fn report_sales(db: State<'_, Db>, session: State<'_, Session>, filter: ReportFilter) -> Result<SalesReport, String> {
    let user_id = session_user(&session)?;
    let conn = db.0.lock().map_err(err)?;
    require_permission(&conn, &user_id, &["view_reports"])?;
    report_sales_inner(&conn, &filter)
}

// ── Expiry and write-offs ──

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpiryRow {
    batch_id: String,
    product: String,
    category: Option<String>,
    batch_no: String,
    expiry_date: String,
    /// Negative once expired.
    days_left: i64,
    qty: i64,
    unit_cost: i64,
    value: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WriteOffRow {
    day: String,
    product: String,
    batch_no: String,
    qty: i64,
    value: i64,
    reason: Option<String>,
    user: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpiryReport {
    expired_qty: i64,
    expired_value: i64,
    near_qty: i64,
    near_value: i64,
    /// Batches with stock that have expired or expire within the horizon, soonest first (FEFO order).
    batches: Vec<ExpiryRow>,
    /// Stock removed by count corrections in the date range (damaged, destroyed, expired disposal).
    write_offs: Vec<WriteOffRow>,
    written_off_value: i64,
}

fn report_expiry_inner(conn: &Connection, f: &ReportFilter, within_days: i64) -> Result<ExpiryReport, String> {
    check_range(conn, f)?;
    if !(0..=730).contains(&within_days) {
        return Err("مدة التنبيه بين ٠ و٧٣٠ يوماً".into());
    }
    let mut stmt = conn
        .prepare(
            "SELECT b.id, p.trade_name, c.name_ar, b.batch_no, b.expiry_date,
                    CAST(julianday(b.expiry_date) - julianday(date('now', 'localtime')) AS INTEGER),
                    b.qty_on_hand, b.unit_cost
             FROM batches b JOIN products p ON p.id = b.product_id LEFT JOIN categories c ON c.id = p.category_id
             WHERE b.qty_on_hand > 0 AND b.expiry_date <= date('now', 'localtime', '+' || ?1 || ' days')
               AND (?2 IS NULL OR p.category_id = ?2)
             ORDER BY b.expiry_date, p.trade_name",
        )
        .map_err(err)?;
    let batches = stmt
        .query_map(params![within_days, f.category_id], |r| {
            let (qty, unit_cost): (i64, i64) = (r.get(6)?, r.get(7)?);
            Ok(ExpiryRow {
                batch_id: r.get(0)?,
                product: r.get(1)?,
                category: r.get(2)?,
                batch_no: r.get(3)?,
                expiry_date: r.get(4)?,
                days_left: r.get(5)?,
                qty,
                unit_cost,
                value: qty * unit_cost,
            })
        })
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)?;

    // The reason lives in the audit entry written in the same transaction, with the same timestamp.
    let mut stmt = conn
        .prepare(
            "SELECT date(m.occurred_at, 'localtime'), p.trade_name, b.batch_no, -m.qty, -m.qty * m.unit_cost,
                    (SELECT json_extract(a.payload, '$.reason') FROM audit_log a
                      WHERE a.entity = 'batches' AND a.entity_id = m.batch_id AND a.occurred_at = m.occurred_at LIMIT 1),
                    u.full_name
             FROM stock_movements m
             JOIN batches b ON b.id = m.batch_id JOIN products p ON p.id = b.product_id
             LEFT JOIN users u ON u.id = m.user_id
             WHERE m.type IN ('adjust', 'damage', 'destroy') AND m.qty < 0
               AND date(m.occurred_at, 'localtime') BETWEEN ?1 AND ?2 AND (?3 IS NULL OR p.category_id = ?3)
             ORDER BY m.occurred_at DESC",
        )
        .map_err(err)?;
    let write_offs = stmt
        .query_map(params![f.from, f.to, f.category_id], |r| {
            Ok(WriteOffRow {
                day: r.get(0)?,
                product: r.get(1)?,
                batch_no: r.get(2)?,
                qty: r.get(3)?,
                value: r.get(4)?,
                reason: r.get(5)?,
                user: r.get(6)?,
            })
        })
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)?;

    let (expired, near): (Vec<&ExpiryRow>, Vec<&ExpiryRow>) = batches.iter().partition(|b| b.days_left <= 0);
    Ok(ExpiryReport {
        expired_qty: expired.iter().map(|b| b.qty).sum(),
        expired_value: expired.iter().map(|b| b.value).sum(),
        near_qty: near.iter().map(|b| b.qty).sum(),
        near_value: near.iter().map(|b| b.value).sum(),
        written_off_value: write_offs.iter().map(|w| w.value).sum(),
        batches,
        write_offs,
    })
}

#[tauri::command]
fn report_expiry(
    db: State<'_, Db>,
    session: State<'_, Session>,
    filter: ReportFilter,
    within_days: i64,
) -> Result<ExpiryReport, String> {
    let user_id = session_user(&session)?;
    let conn = db.0.lock().map_err(err)?;
    require_permission(&conn, &user_id, &["modify_inventory", "view_reports"])?;
    report_expiry_inner(&conn, &filter, within_days)
}

// ── Reorder ──

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReorderRow {
    product_id: String,
    product: String,
    barcode: Option<String>,
    category: Option<String>,
    stock: i64,
    reorder_level: Option<i64>,
    /// Units sold in the last 30 days.
    sold_30d: i64,
    /// Days the sellable stock lasts at the last 30 days' pace; None when nothing sold.
    days_of_cover: Option<i64>,
    suggested_qty: i64,
    supplier: Option<String>,
    last_cost: Option<i64>,
}

/// Products out of stock or at/below their reorder level, the most urgent first.
fn report_reorder_inner(conn: &Connection, category_id: Option<&str>) -> Result<Vec<ReorderRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.trade_name,
               (SELECT code FROM product_barcodes pb WHERE pb.product_id = p.id ORDER BY code LIMIT 1),
               c.name_ar,
               COALESCE((SELECT SUM(b.qty_on_hand) FROM batches b WHERE b.product_id = p.id AND b.status = 'active'
                         AND b.expiry_date > date('now', 'localtime')), 0) AS stock,
               rr.reorder_level, COALESCE(rr.max_qty, 0),
               COALESCE((SELECT SUM(si.qty) FROM sale_items si JOIN sales s ON s.id = si.sale_id
                         WHERE si.product_id = p.id AND s.status = 'paid'
                           AND date(s.created_at, 'localtime') > date('now', 'localtime', '-30 days')), 0),
               (SELECT name FROM suppliers WHERE id = rr.preferred_supplier_id),
               (SELECT unit_cost FROM batches b WHERE b.product_id = p.id ORDER BY b.received_at DESC LIMIT 1)
             FROM products p
             LEFT JOIN categories c ON c.id = p.category_id
             LEFT JOIN reorder_rules rr ON rr.product_id = p.id
             WHERE p.is_active = 1 AND (?1 IS NULL OR p.category_id = ?1)",
        )
        .map_err(err)?;
    let mut rows: Vec<ReorderRow> = stmt
        .query_map(params![category_id], |r| {
            let stock: i64 = r.get(4)?;
            let level: Option<i64> = r.get(5)?;
            let max_qty: i64 = r.get(6)?;
            let sold: i64 = r.get(7)?;
            // Order up to the max level; without one, to twice the reorder level; without that, a month's sales.
            let target = if max_qty > 0 { max_qty } else { level.map(|l| l * 2).filter(|t| *t > 0).unwrap_or(sold.max(1)) };
            Ok(ReorderRow {
                product_id: r.get(0)?,
                product: r.get(1)?,
                barcode: r.get(2)?,
                category: r.get(3)?,
                stock,
                reorder_level: level,
                sold_30d: sold,
                days_of_cover: (sold > 0).then(|| stock * 30 / sold),
                suggested_qty: (target - stock).max(0),
                supplier: r.get(8)?,
                last_cost: r.get(9)?,
            })
        })
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)?;
    rows.retain(|r| r.stock == 0 || r.reorder_level.is_some_and(|l| r.stock <= l));
    rows.sort_by_key(|r| (r.stock > 0, r.days_of_cover.unwrap_or(i64::MAX), r.stock));
    Ok(rows)
}

#[tauri::command]
fn report_reorder(
    db: State<'_, Db>,
    session: State<'_, Session>,
    category_id: Option<String>,
) -> Result<Vec<ReorderRow>, String> {
    let user_id = session_user(&session)?;
    let conn = db.0.lock().map_err(err)?;
    require_permission(&conn, &user_id, &["modify_inventory", "view_reports"])?;
    report_reorder_inner(&conn, category_id.as_deref())
}

// ── Prescriptions ──

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RxRow {
    sale_id: String,
    invoice_no: String,
    /// Local date and time of the sale.
    sold_at: String,
    rx_no: String,
    prescriber: String,
    pharmacist: Option<String>,
    /// Prescription-only items, e.g. "Augmentin 1 g ×1، Concor 5 mg ×2".
    items: String,
    rx_total: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrescriberRow {
    prescriber: String,
    prescriptions: i64,
    units: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RxReport {
    rows: Vec<RxRow>,
    by_prescriber: Vec<PrescriberRow>,
}

fn report_prescriptions_inner(conn: &Connection, f: &ReportFilter) -> Result<RxReport, String> {
    check_range(conn, f)?;
    // ?3 is the cashier who rang the sale up; ?4 keeps prescriptions with at least one item in the category.
    let base = "FROM sale_prescriptions sp JOIN sales s ON s.id = sp.sale_id
      WHERE s.status = 'paid' AND date(s.created_at, 'localtime') BETWEEN ?1 AND ?2
        AND (?3 IS NULL OR s.cashier_id = ?3)
        AND (?4 IS NULL OR EXISTS (SELECT 1 FROM sale_items si JOIN products p ON p.id = si.product_id
                                   WHERE si.sale_id = s.id AND p.category_id = ?4))";
    let rx_items = "FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = s.id AND p.requires_rx = 1";
    let mut stmt = conn
        .prepare(&format!(
            "SELECT s.id, s.invoice_no, datetime(s.created_at, 'localtime'), sp.rx_no, sp.prescriber,
                    (SELECT full_name FROM users WHERE id = sp.verified_by),
                    COALESCE((SELECT group_concat(name || ' ×' || qty, '، ') FROM
                               (SELECT p.trade_name AS name, SUM(si.qty) AS qty {rx_items} GROUP BY p.id)), ''),
                    COALESCE((SELECT SUM(si.line_total) {rx_items}), 0)
             {base} ORDER BY s.created_at DESC"
        ))
        .map_err(err)?;
    let rows = stmt
        .query_map(params![f.from, f.to, f.cashier_id, f.category_id], |r| {
            Ok(RxRow {
                sale_id: r.get(0)?,
                invoice_no: r.get(1)?,
                sold_at: r.get(2)?,
                rx_no: r.get(3)?,
                prescriber: r.get(4)?,
                pharmacist: r.get(5)?,
                items: r.get(6)?,
                rx_total: r.get(7)?,
            })
        })
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT sp.prescriber, COUNT(*), COALESCE(SUM((SELECT SUM(si.qty) {rx_items})), 0)
             {base} GROUP BY sp.prescriber COLLATE NOCASE ORDER BY 2 DESC, 1"
        ))
        .map_err(err)?;
    let by_prescriber = stmt
        .query_map(params![f.from, f.to, f.cashier_id, f.category_id], |r| {
            Ok(PrescriberRow { prescriber: r.get(0)?, prescriptions: r.get(1)?, units: r.get(2)? })
        })
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)?;
    Ok(RxReport { rows, by_prescriber })
}

#[tauri::command]
fn report_prescriptions(db: State<'_, Db>, session: State<'_, Session>, filter: ReportFilter) -> Result<RxReport, String> {
    let user_id = session_user(&session)?;
    let conn = db.0.lock().map_err(err)?;
    require_permission(&conn, &user_id, &["view_reports"])?;
    report_prescriptions_inner(&conn, &filter)
}

// ── Export ──

/// Writes an exported report into the user's Downloads folder and returns the full path.
/// Only a plain file name ending in .csv is accepted; an existing file is never overwritten.
#[tauri::command]
fn save_export(
    app: tauri::AppHandle,
    session: State<'_, Session>,
    file_name: String,
    content: String,
) -> Result<String, String> {
    session_user(&session)?;
    let safe = !file_name.is_empty()
        && file_name.len() <= 100
        && file_name.ends_with(".csv")
        && file_name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !file_name.starts_with('.');
    if !safe {
        return Err("اسم الملف غير صالح".into());
    }
    let dir = app.path().download_dir().map_err(err)?;
    let stem = file_name.trim_end_matches(".csv");
    let mut path = dir.join(&file_name);
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("{stem}-{n}.csv"));
        n += 1;
    }
    std::fs::write(&path, content).map_err(err)?;
    Ok(path.display().to_string())
}

// ── Employees ──
// Admin only. Passwords are stored as Argon2 hashes and never leave this file; every change is audit-logged.
// Safety rules: an admin cannot disable or demote themselves, and the last active admin cannot be removed.

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UserRow {
    id: String,
    username: String,
    full_name: String,
    role: String,
    active: bool,
    has_password: bool,
    last_login: Option<String>,
    overrides: PermissionOverrides,
    permissions: Permissions,
}

fn user_rows(conn: &Connection, only_id: Option<&str>) -> Result<Vec<UserRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.password_hash IS NOT NULL,
                    (SELECT datetime(MAX(a.occurred_at), 'localtime') FROM audit_log a
                      WHERE a.action = 'user.login' AND a.user_id = u.id)
             FROM users u WHERE (?1 IS NULL OR u.id = ?1)
             ORDER BY u.is_active DESC, u.full_name",
        )
        .map_err(err)?;
    let base = stmt
        .query_map(params![only_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)? != 0,
                r.get::<_, bool>(5)?,
                r.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)?;
    base.into_iter()
        .map(|(id, username, full_name, role, active, has_password, last_login)| {
            let overrides = load_overrides(conn, &id)?;
            let permissions = effective_permissions(conn, &id, &role)?;
            Ok(UserRow { id, username, full_name, role, active, has_password, last_login, overrides, permissions })
        })
        .collect()
}

fn user_row(conn: &Connection, id: &str) -> Result<UserRow, String> {
    user_rows(conn, Some(id))?.pop().ok_or_else(|| "الموظف غير موجود".to_string())
}

fn check_password(password: &str) -> Result<(), String> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(format!("كلمة المرور يجب ألا تقل عن {MIN_PASSWORD_LEN} أحرف"));
    }
    Ok(())
}

fn check_role(role: &str) -> Result<(), String> {
    if !ROLES.contains(&role) {
        return Err("الدور غير معروف".into());
    }
    Ok(())
}

/// Replaces a user's overrides. Admins have every permission, so they never keep overrides.
fn write_overrides(conn: &Connection, user_id: &str, role: &str, o: &PermissionOverrides) -> Result<(), String> {
    conn.execute("DELETE FROM user_permissions WHERE user_id = ?1", params![user_id]).map_err(err)?;
    if role == "admin" {
        return Ok(());
    }
    for p in PERMISSIONS {
        // An override equal to the role's default changes nothing; store only real exceptions.
        if let Some(granted) = o.get(p).filter(|g| *g != role_default(role, p)) {
            conn.execute(
                "INSERT INTO user_permissions(user_id, permission, granted) VALUES (?1, ?2, ?3)",
                params![user_id, p, granted],
            )
            .map_err(err)?;
        }
    }
    Ok(())
}

/// Active admins other than `except` that can sign in.
fn other_active_admins(conn: &Connection, except: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1 AND password_hash IS NOT NULL AND id != ?1",
        params![except],
        |r| r.get(0),
    )
    .map_err(err)
}

fn list_users_inner(conn: &Connection, admin_id: &str) -> Result<Vec<UserRow>, String> {
    require_admin(conn, admin_id)?;
    user_rows(conn, None)
}

#[tauri::command]
fn list_users(db: State<'_, Db>, session: State<'_, Session>) -> Result<Vec<UserRow>, String> {
    let admin_id = session_user(&session)?;
    let conn = db.0.lock().map_err(err)?;
    list_users_inner(&conn, &admin_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewUser {
    username: String,
    full_name: String,
    password: String,
    role: String,
    #[serde(default)]
    overrides: PermissionOverrides,
}

fn create_user_inner(conn: &mut Connection, admin_id: &str, u: NewUser) -> Result<UserRow, String> {
    let tx = conn.transaction().map_err(err)?;
    require_admin(&tx, admin_id)?;
    let username = u.username.trim().to_lowercase();
    let valid = (3..=32).contains(&username.len())
        && username.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'));
    if !valid {
        return Err("اسم المستخدم من ٣ إلى ٣٢ حرفاً لاتينياً صغيراً أو رقماً أو . _ -".into());
    }
    let full_name = u.full_name.trim();
    if full_name.is_empty() || full_name.chars().count() > 80 {
        return Err("الاسم الكامل مطلوب (حتى ٨٠ حرفاً)".into());
    }
    check_role(&u.role)?;
    check_password(&u.password)?;
    let taken: bool = tx
        .query_row("SELECT EXISTS (SELECT 1 FROM users WHERE username = ?1 COLLATE NOCASE)", params![username], |r| {
            r.get(0)
        })
        .map_err(err)?;
    if taken {
        return Err(format!("اسم المستخدم {username} مستخدم مسبقاً"));
    }
    let id = new_id();
    let now = utc_now(&tx)?;
    tx.execute(
        "INSERT INTO users(id, username, full_name, role, password_hash, is_active, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
        params![id, username, full_name, u.role, hash_password(&u.password)?, now],
    )
    .map_err(err)?;
    write_overrides(&tx, &id, &u.role, &u.overrides)?;
    let row = user_row(&tx, &id)?;
    let payload = serde_json::json!({ "username": username, "fullName": full_name, "role": u.role, "overrides": row.overrides })
        .to_string();
    append_audit(&tx, admin_id, "user.create", "users", &id, &payload, &now).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(row)
}

#[tauri::command]
fn create_user(db: State<'_, Db>, session: State<'_, Session>, user: NewUser) -> Result<UserRow, String> {
    let admin_id = session_user(&session)?;
    let mut conn = db.0.lock().map_err(err)?;
    create_user_inner(&mut conn, &admin_id, user)
}

/// Sets a user's role and permission overrides together.
fn update_user_role_inner(
    conn: &mut Connection,
    admin_id: &str,
    user_id: &str,
    role: &str,
    overrides: PermissionOverrides,
) -> Result<UserRow, String> {
    let tx = conn.transaction().map_err(err)?;
    require_admin(&tx, admin_id)?;
    check_role(role)?;
    let before = user_row(&tx, user_id)?;
    if before.role == "admin" && role != "admin" {
        if user_id == admin_id {
            return Err("لا يمكنك إزالة صلاحية المدير عن حسابك".into());
        }
        if before.active && other_active_admins(&tx, user_id)? == 0 {
            return Err("يجب أن يبقى مدير واحد نشط على الأقل".into());
        }
    }
    tx.execute("UPDATE users SET role = ?1 WHERE id = ?2", params![role, user_id]).map_err(err)?;
    write_overrides(&tx, user_id, role, &overrides)?;
    let after = user_row(&tx, user_id)?;
    let now = utc_now(&tx)?;
    let payload = serde_json::json!({
        "from": { "role": before.role, "overrides": before.overrides },
        "to": { "role": after.role, "overrides": after.overrides },
    })
    .to_string();
    append_audit(&tx, admin_id, "user.role", "users", user_id, &payload, &now).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(after)
}

#[tauri::command]
fn update_user_role(
    db: State<'_, Db>,
    session: State<'_, Session>,
    user_id: String,
    role: String,
    overrides: PermissionOverrides,
) -> Result<UserRow, String> {
    let admin_id = session_user(&session)?;
    let mut conn = db.0.lock().map_err(err)?;
    update_user_role_inner(&mut conn, &admin_id, &user_id, &role, overrides)
}

/// Activates or deactivates an account. Takes the wanted state, so a repeated click cannot flip it back.
fn toggle_user_status_inner(conn: &mut Connection, admin_id: &str, user_id: &str, active: bool) -> Result<UserRow, String> {
    let tx = conn.transaction().map_err(err)?;
    require_admin(&tx, admin_id)?;
    let before = user_row(&tx, user_id)?;
    if !active {
        if user_id == admin_id {
            return Err("لا يمكنك تعطيل حسابك".into());
        }
        if before.role == "admin" && other_active_admins(&tx, user_id)? == 0 {
            return Err("يجب أن يبقى مدير واحد نشط على الأقل".into());
        }
    }
    if before.active != active {
        tx.execute("UPDATE users SET is_active = ?1 WHERE id = ?2", params![active, user_id]).map_err(err)?;
        let now = utc_now(&tx)?;
        let payload = serde_json::json!({ "active": active }).to_string();
        append_audit(&tx, admin_id, "user.status", "users", user_id, &payload, &now).map_err(err)?;
    }
    let row = user_row(&tx, user_id)?;
    tx.commit().map_err(err)?;
    Ok(row)
}

#[tauri::command]
fn toggle_user_status(
    db: State<'_, Db>,
    session: State<'_, Session>,
    user_id: String,
    active: bool,
) -> Result<UserRow, String> {
    let admin_id = session_user(&session)?;
    let mut conn = db.0.lock().map_err(err)?;
    toggle_user_status_inner(&mut conn, &admin_id, &user_id, active)
}

fn reset_user_password_inner(conn: &mut Connection, admin_id: &str, user_id: &str, password: &str) -> Result<UserRow, String> {
    let tx = conn.transaction().map_err(err)?;
    require_admin(&tx, admin_id)?;
    check_password(password)?;
    user_row(&tx, user_id)?;
    tx.execute("UPDATE users SET password_hash = ?1 WHERE id = ?2", params![hash_password(password)?, user_id])
        .map_err(err)?;
    let now = utc_now(&tx)?;
    // Never the password itself, not even hashed.
    append_audit(&tx, admin_id, "user.password_reset", "users", user_id, "{}", &now).map_err(err)?;
    let row = user_row(&tx, user_id)?;
    tx.commit().map_err(err)?;
    Ok(row)
}

#[tauri::command]
fn reset_user_password(
    db: State<'_, Db>,
    session: State<'_, Session>,
    user_id: String,
    password: String,
) -> Result<UserRow, String> {
    let admin_id = session_user(&session)?;
    let mut conn = db.0.lock().map_err(err)?;
    reset_user_password_inner(&mut conn, &admin_id, &user_id, &password)
}

// ── Phone scanner ──

/// The computer's address on the local network (e.g. 192.168.1.20).
#[tauri::command]
fn get_local_ip() -> Result<String, String> {
    phone_scanner::local_ip().map(|ip| ip.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannerDevice {
    device: String,
    seconds_ago: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneScannerInfo {
    /// What the QR code opens; carries this run's pairing token.
    url: String,
    ip: String,
    port: u16,
    qr_svg: String,
    running: bool,
    error: Option<String>,
    /// Phones heard from in the last 10 seconds.
    devices: Vec<ScannerDevice>,
}

#[tauri::command]
fn phone_scanner_info(
    session: State<'_, Session>,
    scanner: State<'_, Arc<phone_scanner::Scanner>>,
) -> Result<PhoneScannerInfo, String> {
    session_user(&session)?;
    let ip = phone_scanner::local_ip()?.to_string();
    let url = format!("https://{ip}:{}/scan?t={}", phone_scanner::PORT, scanner.token());
    let status = scanner.status.lock().map_err(err)?.clone();
    let devices = scanner
        .connected(std::time::Duration::from_secs(10))
        .into_iter()
        .map(|(device, seconds_ago)| ScannerDevice { device, seconds_ago })
        .collect();
    Ok(PhoneScannerInfo {
        qr_svg: phone_scanner::qr_svg(&url)?,
        url,
        ip,
        port: phone_scanner::PORT,
        running: status.running,
        error: status.error,
        devices,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = Connection::open(dir.join("pharmacy.db"))?;
            migrate(&conn)?;
            app.manage(Db(Mutex::new(conn)));
            app.manage(Session::default());

            // Phone scanner: scans arrive as the `phone-barcode-scanned` event. A new pairing token on every start.
            let handle = app.handle().clone();
            let sink: phone_scanner::Sink = Arc::new(move |scan| {
                let _ = handle.emit(phone_scanner::EVENT, scan);
            });
            let scanner = Arc::new(phone_scanner::Scanner::new(uuid::Uuid::new_v4().simple().to_string(), sink));
            phone_scanner::start(dir.clone(), scanner.clone());
            app.manage(scanner);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            setup_admin,
            login,
            logout,
            search_products,
            find_by_code,
            alternatives,
            product_batches,
            post_sale,
            inventory_list,
            inventory_batches,
            list_categories,
            add_product,
            receive_batch,
            adjust_batch,
            list_suppliers,
            add_supplier,
            post_purchase_invoice,
            report_users,
            report_sales,
            report_expiry,
            report_reorder,
            report_prescriptions,
            save_export,
            list_users,
            create_user,
            update_user_role,
            toggle_user_status,
            reset_user_password,
            get_local_ip,
            phone_scanner_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running the pharmacy app");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn qty(conn: &Connection, batch: &str) -> i64 {
        conn.query_row("SELECT qty_on_hand FROM batches WHERE id = ?1", params![batch], |r| r.get(0)).unwrap()
    }

    const ADMIN: &str = "u-admin";

    fn add_user(conn: &Connection, id: &str, role: &str) {
        conn.execute(
            "INSERT INTO users(id, username, full_name, role) VALUES (?1, ?1, ?1, ?2)",
            params![id, role],
        )
        .unwrap();
    }

    /// Cash sale with a prescription attached, so prescription-only items pass unless a test removes it.
    fn cash_sale(lines: Vec<SaleLineIn>, cash: i64) -> SaleDraft {
        SaleDraft {
            lines,
            invoice_discount: 0,
            payments: vec![PaymentIn { method: "cash".into(), amount: cash, reference: None }],
            patient_id: None,
            prescription: Some(PrescriptionIn { rx_no: "RX-1".into(), prescriber: "د. علي".into() }),
        }
    }

    fn line(product: &str, price: i64, allocs: &[(&str, i64)]) -> SaleLineIn {
        SaleLineIn {
            product_id: product.into(),
            unit_price: price,
            discount: 0,
            allocations: allocs.iter().map(|(b, q)| AllocationIn { batch_id: (*b).into(), qty: *q }).collect(),
            fefo_override_reason: None,
        }
    }

    #[test]
    fn migrates_and_seeds_demo_data() {
        let conn = db();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM products", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 12);
        migrate(&conn).unwrap(); // running twice is harmless
    }

    #[test]
    fn search_by_generic_name_in_arabic_and_strength() {
        let conn = db();
        let hits = search_inner(&conn, "ميتفورمين 850", "generic").unwrap();
        let names: Vec<_> = hits.iter().map(|h| h.trade_name.as_str()).collect();
        assert_eq!(names.len(), 2, "{names:?}");
        assert!(hits.iter().all(|h| h.stock > 0));
    }

    #[test]
    fn alternatives_share_composition() {
        let conn = db();
        let hits = search_inner(&conn, "fevadol", "alternatives").unwrap();
        assert_eq!(hits.len(), 2); // Fevadol 500 + Panadol 500
    }

    #[test]
    fn expired_batches_are_not_counted_as_stock() {
        let conn = db();
        let hits = search_inner(&conn, "amoxil", "trade").unwrap();
        assert_eq!(hits[0].stock, 18);
    }

    #[test]
    fn sale_reduces_stock_and_writes_ledger() {
        let mut conn = db();
        let draft = cash_sale(vec![line("p-panadol-extra", 3000, &[("b-px-0921", 24), ("b-px-1104", 6)])], 100_000);
        let r = post_sale_inner(&mut conn, ADMIN, draft).unwrap();
        assert_eq!(r.total, 90_000);
        assert_eq!(r.change, 10_000);
        assert!(r.invoice_no.ends_with("-000001"));
        assert_eq!(qty(&conn, "b-px-0921"), 0);
        assert_eq!(qty(&conn, "b-px-1104"), 54);
        let moved: i64 = conn
            .query_row("SELECT SUM(qty) FROM stock_movements WHERE type = 'sale'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(moved, -30);
        let audits: i64 = conn.query_row("SELECT COUNT(*) FROM audit_log", [], |r| r.get(0)).unwrap();
        assert_eq!(audits, 1);
    }

    #[test]
    fn oversell_is_rejected_and_rolled_back() {
        let mut conn = db();
        let draft = cash_sale(
            vec![line("p-brufen-400", 3500, &[("b-br-400", 1)]), line("p-ventolin", 7000, &[("b-vt-501", 99)])],
            10_000_000,
        );
        assert_rejected(&mut conn, ADMIN, draft, "لم تعد تكفي");
        assert_eq!(qty(&conn, "b-br-400"), 55, "first line must roll back too");
    }

    #[test]
    fn expired_batch_cannot_be_sold() {
        let mut conn = db();
        let draft = cash_sale(vec![line("p-amoxil-500", 4500, &[("b-am-009", 1)])], 4500);
        assert_rejected(&mut conn, ADMIN, draft, "انتهت صلاحيتها");
    }

    #[test]
    fn underpayment_is_rejected() {
        let mut conn = db();
        let draft = cash_sale(vec![line("p-concor-5", 9000, &[("b-cn-118", 1)])], 5000);
        assert_rejected(&mut conn, ADMIN, draft, "أقل من المطلوب");
    }

    #[test]
    fn audit_log_is_hash_chained_and_append_only() {
        let mut conn = db();
        for _ in 0..2 {
            let d = cash_sale(vec![line("p-brufen-400", 3500, &[("b-br-400", 1)])], 3500);
            post_sale_inner(&mut conn, ADMIN, d).unwrap();
        }
        let (prev2, hash1): (String, String) = conn
            .query_row(
                "SELECT (SELECT prev_hash FROM audit_log WHERE seq = 2), (SELECT hash FROM audit_log WHERE seq = 1)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(prev2, hash1);
        assert!(conn.execute("DELETE FROM audit_log", []).is_err());
    }

    /// The sale must fail with a message containing `reason`, and leave no sale behind.
    fn assert_rejected(conn: &mut Connection, user: &str, draft: SaleDraft, reason: &str) {
        match post_sale_inner(conn, user, draft) {
            Ok(r) => panic!("sale {} was accepted; expected rejection: {reason}", r.invoice_no),
            Err(e) => assert!(e.contains(reason), "expected {reason:?}, got {e:?}"),
        }
        let sales: i64 = conn.query_row("SELECT COUNT(*) FROM sales", [], |r| r.get(0)).unwrap();
        assert_eq!(sales, 0, "a rejected sale must roll back");
    }

    fn brufen(qty: i64, discount: i64) -> SaleLineIn {
        SaleLineIn { discount, ..line("p-brufen-400", 3500, &[("b-br-400", qty)]) }
    }

    // ── Prices ──

    #[test]
    fn price_lower_than_database_is_rejected() {
        let mut conn = db();
        let draft = cash_sale(vec![line("p-brufen-400", 1, &[("b-br-400", 10)])], 10);
        assert_rejected(&mut conn, ADMIN, draft, "أصبح 3500");
        assert_eq!(qty(&conn, "b-br-400"), 55);
    }

    #[test]
    fn price_higher_than_database_is_rejected() {
        let mut conn = db();
        let draft = cash_sale(vec![line("p-brufen-400", 9999, &[("b-br-400", 1)])], 9999);
        assert_rejected(&mut conn, ADMIN, draft, "أصبح 3500");
    }

    #[test]
    fn inactive_or_unknown_product_is_rejected() {
        let mut conn = db();
        conn.execute("UPDATE products SET is_active = 0 WHERE id = 'p-brufen-400'", []).unwrap();
        assert_rejected(&mut conn, ADMIN, cash_sale(vec![brufen(1, 0)], 3500), "موقوف");
        let ghost = cash_sale(vec![line("p-nope", 3500, &[("b-br-400", 1)])], 3500);
        assert_rejected(&mut conn, ADMIN, ghost, "غير موجود");
    }

    #[test]
    fn batch_of_another_product_is_rejected() {
        let mut conn = db();
        // Brufen's price, but stock taken from a Panadol Extra batch.
        let draft = cash_sale(vec![line("p-brufen-400", 3500, &[("b-px-1104", 1)])], 3500);
        assert_rejected(&mut conn, ADMIN, draft, "دفعة غير موجودة");
        assert_eq!(qty(&conn, "b-px-1104"), 60);
    }

    // ── Discounts ──

    #[test]
    fn negative_line_discount_is_rejected() {
        let mut conn = db();
        assert_rejected(&mut conn, ADMIN, cash_sale(vec![brufen(1, -500)], 4000), "خصم غير صالح");
    }

    #[test]
    fn line_discount_above_line_total_is_rejected() {
        let mut conn = db();
        assert_rejected(&mut conn, ADMIN, cash_sale(vec![brufen(1, 3501)], 0), "خصم غير صالح");
    }

    #[test]
    fn invoice_discount_out_of_range_is_rejected() {
        let mut conn = db();
        let mut d = cash_sale(vec![brufen(1, 0)], 0);
        d.invoice_discount = 3501;
        assert_rejected(&mut conn, ADMIN, d, "خصم الفاتورة");
        let mut d = cash_sale(vec![brufen(1, 0)], 4000);
        d.invoice_discount = -500;
        assert_rejected(&mut conn, ADMIN, d, "خصم الفاتورة");
    }

    #[test]
    fn cashier_discount_is_capped_by_setting() {
        let mut conn = db();
        add_user(&conn, "u-cash", "cashier");
        // 10 × 3500 = 35,000; the default 10% ceiling allows 3,500 in total (line + invoice).
        let mut over = cash_sale(vec![brufen(10, 3000)], 35_000);
        over.invoice_discount = 501;
        assert_rejected(&mut conn, "u-cash", over, "الحد المسموح (10٪");

        let mut at_limit = cash_sale(vec![brufen(10, 3000)], 31_500);
        at_limit.invoice_discount = 500;
        let r = post_sale_inner(&mut conn, "u-cash", at_limit).unwrap();
        assert_eq!(r.total, 31_500);
    }

    #[test]
    fn discount_ceiling_follows_the_setting() {
        let mut conn = db();
        add_user(&conn, "u-cash", "cashier");
        conn.execute("UPDATE settings SET value = '0' WHERE key = 'max_discount_pct'", []).unwrap();
        assert_rejected(&mut conn, "u-cash", cash_sale(vec![brufen(1, 1)], 3500), "الحد المسموح (0٪");
    }

    #[test]
    fn admin_may_exceed_the_discount_ceiling() {
        let mut conn = db();
        let r = post_sale_inner(&mut conn, ADMIN, cash_sale(vec![brufen(1, 1750)], 1750)).unwrap();
        assert_eq!(r.total, 1750);
        let stored: i64 = conn.query_row("SELECT discount_total FROM sales", [], |r| r.get(0)).unwrap();
        assert_eq!(stored, 1750);
    }

    // ── Prescriptions ──

    fn augmentin() -> SaleLineIn {
        line("p-augmentin-1g", 18500, &[("b-au-2311", 1)])
    }

    #[test]
    fn rx_item_without_prescription_is_rejected() {
        let mut conn = db();
        let mut d = cash_sale(vec![brufen(1, 0), augmentin()], 22_000);
        d.prescription = None;
        assert_rejected(&mut conn, ADMIN, d, "أدخل رقم الوصفة");
        assert_eq!(qty(&conn, "b-au-2311"), 18);
    }

    #[test]
    fn rx_item_with_blank_prescription_is_rejected() {
        let mut conn = db();
        let mut d = cash_sale(vec![augmentin()], 18_500);
        d.prescription = Some(PrescriptionIn { rx_no: "  ".into(), prescriber: "د. علي".into() });
        assert_rejected(&mut conn, ADMIN, d, "أدخل رقم الوصفة");
    }

    #[test]
    fn cashier_cannot_dispense_rx_items_even_with_prescription() {
        let mut conn = db();
        add_user(&conn, "u-cash", "cashier");
        assert_rejected(&mut conn, "u-cash", cash_sale(vec![augmentin()], 18_500), "يصرفها صيدلاني");
        assert_eq!(qty(&conn, "b-au-2311"), 18);
    }

    #[test]
    fn cashier_can_sell_otc_items_without_prescription() {
        let mut conn = db();
        add_user(&conn, "u-cash", "cashier");
        let mut d = cash_sale(vec![brufen(2, 0)], 7000);
        d.prescription = None;
        post_sale_inner(&mut conn, "u-cash", d).unwrap();
        let rx: i64 = conn.query_row("SELECT COUNT(*) FROM sale_prescriptions", [], |r| r.get(0)).unwrap();
        assert_eq!(rx, 0);
    }

    #[test]
    fn pharmacist_rx_sale_records_the_prescription() {
        let mut conn = db();
        add_user(&conn, "u-ph", "pharmacist");
        let r = post_sale_inner(&mut conn, "u-ph", cash_sale(vec![augmentin()], 18_500)).unwrap();
        let (rx_no, by, verified): (String, String, String) = conn
            .query_row(
                "SELECT rx_no, prescriber, verified_by FROM sale_prescriptions WHERE sale_id = ?1",
                params![r.sale_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((rx_no.as_str(), by.as_str(), verified.as_str()), ("RX-1", "د. علي", "u-ph"));
    }

    // ── Users and sign-in ──

    #[test]
    fn sale_is_recorded_under_the_given_user() {
        let mut conn = db();
        add_user(&conn, "u-ph", "pharmacist");
        let r = post_sale_inner(&mut conn, "u-ph", cash_sale(vec![brufen(1, 0)], 3500)).unwrap();
        let cashier: String =
            conn.query_row("SELECT cashier_id FROM sales WHERE id = ?1", params![r.sale_id], |r| r.get(0)).unwrap();
        assert_eq!(cashier, "u-ph");
    }

    #[test]
    fn unknown_or_disabled_user_cannot_sell() {
        let mut conn = db();
        assert_rejected(&mut conn, "u-ghost", cash_sale(vec![brufen(1, 0)], 3500), "معطّل");
        add_user(&conn, "u-gone", "pharmacist");
        conn.execute("UPDATE users SET is_active = 0 WHERE id = 'u-gone'", []).unwrap();
        assert_rejected(&mut conn, "u-gone", cash_sale(vec![brufen(1, 0)], 3500), "معطّل");
    }

    #[test]
    fn first_run_setup_then_login() {
        let mut conn = db();
        assert!(needs_setup(&conn).unwrap());
        assert!(login_inner(&mut conn, "admin", "").is_err(), "no password set yet: nobody can sign in");
        assert!(setup_admin_inner(&mut conn, "short").unwrap_err().contains("8"));

        let u = setup_admin_inner(&mut conn, "correct horse").unwrap();
        assert_eq!((u.id.as_str(), u.role.as_str()), (ADMIN, "admin"));
        assert!(!needs_setup(&conn).unwrap());
        let stored: String =
            conn.query_row("SELECT password_hash FROM users WHERE id = ?1", params![ADMIN], |r| r.get(0)).unwrap();
        assert!(stored.starts_with("$argon2") && !stored.contains("correct horse"));

        assert!(setup_admin_inner(&mut conn, "another password").is_err(), "setup runs only once");
        assert_eq!(login_inner(&mut conn, "admin", "correct horse").unwrap().id, ADMIN);
        assert_eq!(login_inner(&mut conn, "admin", "wrong password").unwrap_err(), BAD_LOGIN);
        assert_eq!(login_inner(&mut conn, "nobody", "correct horse").unwrap_err(), BAD_LOGIN);

        conn.execute("UPDATE users SET is_active = 0 WHERE id = ?1", params![ADMIN]).unwrap();
        assert_eq!(login_inner(&mut conn, "admin", "correct horse").unwrap_err(), BAD_LOGIN);
    }

    #[test]
    fn upgrades_a_version_1_database() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(INIT_SQL).unwrap();
        conn.execute_batch("PRAGMA user_version = 1;").unwrap();
        migrate(&conn).unwrap();
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 3);
        let pct: String =
            conn.query_row("SELECT value FROM settings WHERE key = 'max_discount_pct'", [], |r| r.get(0)).unwrap();
        assert_eq!(pct, "10");
    }

    // ── Inventory ──

    fn find<'a>(items: &'a [InventoryItem], id: &str) -> &'a InventoryItem {
        items.iter().find(|i| i.id == id).unwrap()
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn new_product(name: &str, barcode: Option<&str>) -> NewProduct {
        NewProduct {
            trade_name: name.into(),
            trade_name_ar: Some("زيرتك".into()),
            category_id: Some("cat-otc".into()),
            dosage_form: "قرص".into(),
            strength: "10 mg".into(),
            pack_size: 10,
            price: 5000,
            requires_rx: false,
            barcode: barcode.map(String::from),
            reorder_level: Some(20),
        }
    }

    fn receive(product: &str, batch_no: &str, expiry: &str, qty: i64) -> ReceiveBatch {
        ReceiveBatch {
            product_id: product.into(),
            batch_no: batch_no.into(),
            expiry_date: expiry.into(),
            qty,
            unit_cost: 3500,
        }
    }

    #[test]
    fn inventory_lists_every_product_with_stock_expiry_and_category() {
        let conn = db();
        let items = inventory_list_inner(&conn).unwrap();
        assert_eq!(items.len(), 12);
        let amoxil = find(&items, "p-amoxil-500");
        assert_eq!((amoxil.stock, amoxil.expired_qty), (18, 4), "expired batch is counted apart");
        assert_eq!(amoxil.reorder_level, Some(25));
        assert_eq!(amoxil.barcode.as_deref(), Some("2000000000084"));
        assert_eq!(amoxil.category.as_deref(), Some("أدوية بوصفة"));
        let px = find(&items, "p-panadol-extra");
        assert_eq!(px.stock, 180);
        let earliest: String = conn
            .query_row("SELECT expiry_date FROM batches WHERE id = 'b-px-0921'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(px.nearest_expiry.as_deref(), Some(earliest.as_str()));
    }

    #[test]
    fn inventory_batches_include_expired_stock_in_fefo_order() {
        let conn = db();
        let batches = inventory_batches_inner(&conn, "p-amoxil-500").unwrap();
        let nos: Vec<_> = batches.iter().map(|b| b.batch_no.as_str()).collect();
        assert_eq!(nos, ["AM009", "AM014"]);
    }

    #[test]
    fn add_product_creates_product_barcode_reorder_rule_and_audit() {
        let mut conn = db();
        let item = add_product_inner(&mut conn, ADMIN, new_product("Zyrtec 10 mg", Some("6281000000017"))).unwrap();
        assert_eq!((item.stock, item.price, item.reorder_level), (0, 5000, Some(20)));
        assert_eq!(item.category.as_deref(), Some("أدوية بدون وصفة"));
        let hit = search_inner(&conn, "zyrtec", "trade").unwrap();
        assert_eq!(hit.len(), 1, "a new product is searchable at the till");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM audit_log WHERE action = 'product.create'"), 1);
    }

    #[test]
    fn add_product_rejects_bad_input() {
        let mut conn = db();
        let dup = new_product("Copy", Some("2000000000046"));
        assert!(add_product_inner(&mut conn, ADMIN, dup).unwrap_err().contains("Panadol Extra"));
        let bad_code = new_product("X", Some("12ab"));
        assert!(add_product_inner(&mut conn, ADMIN, bad_code).unwrap_err().contains("الباركود"));
        let free = NewProduct { price: 0, ..new_product("X", None) };
        assert!(add_product_inner(&mut conn, ADMIN, free).unwrap_err().contains("سعر البيع"));
        let blank = NewProduct { trade_name: "  ".into(), ..new_product("X", None) };
        assert!(add_product_inner(&mut conn, ADMIN, blank).unwrap_err().contains("مطلوبة"));
        let ghost_cat = NewProduct { category_id: Some("cat-nope".into()), ..new_product("X", None) };
        assert!(add_product_inner(&mut conn, ADMIN, ghost_cat).unwrap_err().contains("التصنيف"));
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM products"), 12, "nothing was saved");
    }

    #[test]
    fn cashier_cannot_change_inventory() {
        let mut conn = db();
        add_user(&conn, "u-cash", "cashier");
        let e = add_product_inner(&mut conn, "u-cash", new_product("X", None)).unwrap_err();
        assert!(e.contains("صلاحية"));
        let e = receive_batch_inner(&mut conn, "u-cash", receive("p-brufen-400", "BR9", "2099-01-01", 5)).unwrap_err();
        assert!(e.contains("صلاحية"));
        let adj = AdjustBatch { batch_id: "b-br-400".into(), new_qty: 0, reason: "جرد".into() };
        assert!(adjust_batch_inner(&mut conn, "u-cash", adj).unwrap_err().contains("صلاحية"));
        assert_eq!(qty(&conn, "b-br-400"), 55);
    }

    #[test]
    fn storekeeper_receives_a_new_batch() {
        let mut conn = db();
        add_user(&conn, "u-store", "storekeeper");
        let item = receive_batch_inner(&mut conn, "u-store", receive("p-brufen-400", "BR500", "2099-06-30", 40)).unwrap();
        assert_eq!(item.stock, 95);
        let (sell, kind, moved): (i64, String, i64) = conn
            .query_row(
                "SELECT b.sell_price, m.type, m.qty FROM batches b JOIN stock_movements m ON m.batch_id = b.id
                 WHERE b.batch_no = 'BR500'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((sell, kind.as_str(), moved), (3500, "purchase", 40), "priced from the product, logged as a movement");
    }

    #[test]
    fn receive_batch_rejects_bad_input() {
        let mut conn = db();
        let cases = [
            (receive("p-brufen-400", "BR400", "2099-01-01", 5), "موجودة مسبقاً"),
            (receive("p-brufen-400", "X1", "2020-01-01", 5), "منتهي الصلاحية"),
            (receive("p-brufen-400", "X1", "2099-02-30", 5), "تاريخ الانتهاء غير صالح"),
            (receive("p-brufen-400", "X1", "next year", 5), "تاريخ الانتهاء غير صالح"),
            (receive("p-brufen-400", "X1", "2099-01-01", 0), "الكمية"),
            (receive("p-brufen-400", " ", "2099-01-01", 5), "رقم الدفعة"),
            (receive("p-nope", "X1", "2099-01-01", 5), "غير موجود"),
        ];
        for (input, reason) in cases {
            let e = receive_batch_inner(&mut conn, ADMIN, input).unwrap_err();
            assert!(e.contains(reason), "expected {reason:?}, got {e:?}");
        }
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM batches"), 15);
    }

    #[test]
    fn stock_count_adjustment_records_the_difference() {
        let mut conn = db();
        let adj = AdjustBatch { batch_id: "b-br-400".into(), new_qty: 50, reason: "جرد شهري".into() };
        let item = adjust_batch_inner(&mut conn, ADMIN, adj).unwrap();
        assert_eq!(item.stock, 50);
        assert_eq!(count(&conn, "SELECT qty FROM stock_movements WHERE type = 'adjust'"), -5);
        // Stock still equals the sum of movements.
        assert_eq!(count(&conn, "SELECT SUM(qty) FROM stock_movements WHERE batch_id = 'b-br-400'"), 50);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM audit_log WHERE action = 'batch.adjust'"), 1);
    }

    #[test]
    fn adjustment_rejects_bad_input() {
        let mut conn = db();
        let adj = |qty: i64, reason: &str| AdjustBatch { batch_id: "b-br-400".into(), new_qty: qty, reason: reason.into() };
        assert!(adjust_batch_inner(&mut conn, ADMIN, adj(40, " ")).unwrap_err().contains("سبب"));
        assert!(adjust_batch_inner(&mut conn, ADMIN, adj(-1, "جرد")).unwrap_err().contains("سالبة"));
        assert!(adjust_batch_inner(&mut conn, ADMIN, adj(55, "جرد")).unwrap_err().contains("مساوية"));
        let ghost = AdjustBatch { batch_id: "b-nope".into(), new_qty: 1, reason: "جرد".into() };
        assert!(adjust_batch_inner(&mut conn, ADMIN, ghost).unwrap_err().contains("غير موجودة"));
        assert_eq!(qty(&conn, "b-br-400"), 55);
    }

    // ── Purchasing ──

    fn pline(product: &str, batch_no: &str, expiry: &str, qty: i64, cost: i64, sell: i64) -> PurchaseLineIn {
        PurchaseLineIn {
            product_id: product.into(),
            batch_no: batch_no.into(),
            expiry_date: expiry.into(),
            qty,
            unit_cost: cost,
            sell_price: sell,
        }
    }

    fn purchase(no: &str, payment: &str, lines: Vec<PurchaseLineIn>) -> PurchaseInvoiceIn {
        PurchaseInvoiceIn {
            supplier_id: "s-a".into(),
            supplier_invoice_no: no.into(),
            invoice_date: "2026-01-15".into(),
            payment: payment.into(),
            lines,
        }
    }

    fn supplier_balance(conn: &Connection) -> i64 {
        count(conn, "SELECT balance FROM suppliers WHERE id = 's-a'")
    }

    /// The purchase must fail with `reason` and leave no trace.
    fn assert_purchase_rejected(conn: &mut Connection, user: &str, inv: PurchaseInvoiceIn, reason: &str) {
        let e = post_purchase_inner(conn, user, inv).unwrap_err();
        assert!(e.contains(reason), "expected {reason:?}, got {e:?}");
        assert_eq!(count(conn, "SELECT COUNT(*) FROM purchase_invoices"), 0);
        assert_eq!(count(conn, "SELECT COUNT(*) FROM batches"), 15);
        assert_eq!(count(conn, "SELECT COUNT(*) FROM stock_movements WHERE type = 'purchase'"), 0);
        assert_eq!(supplier_balance(conn), 0);
    }

    #[test]
    fn cash_purchase_creates_batches_movements_and_settled_ledger() {
        let mut conn = db();
        let inv = purchase(
            "INV-100",
            "cash",
            vec![
                pline("p-brufen-400", "BR500", "2099-06-30", 40, 2500, 3500),
                pline("p-concor-5", "CN200", "2099-03-31", 10, 7300, 9000),
            ],
        );
        let r = post_purchase_inner(&mut conn, ADMIN, inv).unwrap();
        assert_eq!((r.total, r.units, r.batches_created, r.batches_updated), (40 * 2500 + 10 * 7300, 50, 2, 0));
        assert!(r.price_changes.is_empty() && r.due_date.is_none());
        let status: String = conn.query_row("SELECT status FROM purchase_invoices", [], |r| r.get(0)).unwrap();
        assert_eq!(status, "paid");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM purchase_invoice_items"), 2);
        assert_eq!(count(&conn, "SELECT SUM(qty) FROM stock_movements WHERE type = 'purchase'"), 50);
        assert_eq!(count(&conn, "SELECT SUM(credit) - SUM(debit) FROM supplier_ledger"), 0, "cash invoice is settled");
        assert_eq!(supplier_balance(&conn), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM audit_log WHERE action = 'purchase.post'"), 1);
        let source: i64 = count(
            &conn,
            "SELECT COUNT(*) FROM batches b JOIN purchase_invoice_items i ON i.id = b.source_item_id WHERE b.batch_no = 'BR500'",
        );
        assert_eq!(source, 1, "batch links back to the invoice line");
    }

    #[test]
    fn credit_purchase_adds_to_supplier_balance_with_due_date() {
        let mut conn = db();
        let inv = purchase("INV-200", "credit", vec![pline("p-brufen-400", "BR500", "2099-06-30", 10, 2500, 3500)]);
        let r = post_purchase_inner(&mut conn, ADMIN, inv).unwrap();
        assert_eq!(r.supplier_balance, 25_000);
        assert_eq!(r.due_date.as_deref(), Some("2026-02-14"), "supplier s-a has 30-day terms");
        let (status, paid): (String, i64) =
            conn.query_row("SELECT status, paid FROM purchase_invoices", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((status.as_str(), paid), ("posted", 0));
    }

    #[test]
    fn purchased_stock_is_sold_by_fefo_right_away() {
        let mut conn = db();
        // A batch that expires before the shelf stock: FEFO must offer it first.
        let soon: String = conn.query_row("SELECT date('now', 'localtime', '+30 days')", [], |r| r.get(0)).unwrap();
        let inv = purchase("INV-300", "cash", vec![pline("p-brufen-400", "BR-SOON", &soon, 5, 2400, 3500)]);
        post_purchase_inner(&mut conn, ADMIN, inv).unwrap();
        let batches = product_batches_rows(&conn, "p-brufen-400");
        assert_eq!(batches[0].batch_no, "BR-SOON");
        assert_eq!(search_inner(&conn, "brufen", "trade").unwrap()[0].stock, 60);

        let id = batches[0].id.clone();
        let r = post_sale_inner(&mut conn, ADMIN, cash_sale(vec![line("p-brufen-400", 3500, &[(&id, 5)])], 17_500));
        assert!(r.is_ok(), "{r:?}");
        assert_eq!(qty(&conn, &id), 0);
    }

    fn product_batches_rows(conn: &Connection, product: &str) -> Vec<InventoryBatch> {
        inventory_batches_inner(conn, product).unwrap()
    }

    #[test]
    fn same_batch_number_tops_up_with_weighted_cost() {
        let mut conn = db();
        let expiry: String = conn.query_row("SELECT expiry_date FROM batches WHERE id = 'b-br-400'", [], |r| r.get(0)).unwrap();
        // Shelf: 55 at 2400. Received: 45 at 2600. Average: (55×2400 + 45×2600) / 100 = 2490.
        let inv = purchase("INV-400", "cash", vec![pline("p-brufen-400", "BR400", &expiry, 45, 2600, 3500)]);
        let r = post_purchase_inner(&mut conn, ADMIN, inv).unwrap();
        assert_eq!((r.batches_created, r.batches_updated), (0, 1));
        assert_eq!(qty(&conn, "b-br-400"), 100);
        assert_eq!(count(&conn, "SELECT unit_cost FROM batches WHERE id = 'b-br-400'"), 2490);
        assert_eq!(count(&conn, "SELECT SUM(qty) FROM stock_movements WHERE batch_id = 'b-br-400'"), 100);
    }

    #[test]
    fn new_retail_price_updates_the_product_and_the_till() {
        let mut conn = db();
        let inv = purchase("INV-500", "cash", vec![pline("p-brufen-400", "BR500", "2099-06-30", 10, 2600, 3750)]);
        let r = post_purchase_inner(&mut conn, ADMIN, inv).unwrap();
        assert_eq!(r.price_changes, ["Brufen 400 mg"]);
        assert_eq!(count(&conn, "SELECT sell_price FROM products WHERE id = 'p-brufen-400'"), 3750);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM audit_log WHERE action = 'product.price'"), 1);
        // The till now refuses the old price and accepts the new one.
        assert_rejected(&mut conn, ADMIN, cash_sale(vec![brufen(1, 0)], 3500), "أصبح 3750");
        post_sale_inner(&mut conn, ADMIN, cash_sale(vec![line("p-brufen-400", 3750, &[("b-br-400", 1)])], 3750)).unwrap();
    }

    #[test]
    fn purchase_rejects_bad_invoices_without_writing_anything() {
        let mut conn = db();
        let ok = || pline("p-brufen-400", "BR500", "2099-06-30", 10, 2500, 3500);
        let shelf_expiry: String =
            conn.query_row("SELECT expiry_date FROM batches WHERE id = 'b-br-400'", [], |r| r.get(0)).unwrap();
        let mismatch = format!("مسجّلة بتاريخ انتهاء {shelf_expiry}");
        let cases: Vec<(PurchaseInvoiceIn, &str)> = vec![
            (PurchaseInvoiceIn { supplier_id: "s-nope".into(), ..purchase("A", "cash", vec![ok()]) }, "اختر المورد"),
            (purchase(" ", "cash", vec![ok()]), "رقم فاتورة الشراء"),
            (PurchaseInvoiceIn { invoice_date: "2099-01-01".into(), ..purchase("A", "cash", vec![ok()]) }, "المستقبل"),
            (PurchaseInvoiceIn { invoice_date: "15/01/2026".into(), ..purchase("A", "cash", vec![ok()]) }, "تاريخ الفاتورة"),
            (purchase("A", "cheque", vec![ok()]), "حالة الدفع"),
            (purchase("A", "cash", vec![]), "أضف صنفاً"),
            // A bad second line must roll back the good first line too.
            (purchase("A", "cash", vec![ok(), pline("p-concor-5", "C1", "2020-01-01", 5, 7000, 9000)]), "منتهي الصلاحية"),
            (purchase("A", "cash", vec![ok(), pline("p-concor-5", "C1", "2099-13-01", 5, 7000, 9000)]), "تاريخ الانتهاء غير صالح"),
            (purchase("A", "cash", vec![pline("p-brufen-400", " ", "2099-06-30", 10, 2500, 3500)]), "رقم التشغيلة"),
            (purchase("A", "cash", vec![pline("p-brufen-400", "X", "2099-06-30", 0, 2500, 3500)]), "الكمية"),
            (purchase("A", "cash", vec![pline("p-brufen-400", "X", "2099-06-30", 5, -1, 3500)]), "سعر الشراء"),
            (purchase("A", "cash", vec![pline("p-brufen-400", "X", "2099-06-30", 5, 2500, 0)]), "سعر البيع"),
            (purchase("A", "cash", vec![pline("p-nope", "X", "2099-06-30", 5, 2500, 3500)]), "صنف غير موجود"),
            (purchase("A", "cash", vec![ok(), ok()]), "مكررة"),
            (
                purchase("A", "cash", vec![ok(), pline("p-brufen-400", "BR501", "2099-06-30", 5, 2500, 3600)]),
                "سعر البيع مختلف",
            ),
            (
                purchase("A", "cash", vec![ok(), pline("p-brufen-400", "BR400", "2099-12-31", 5, 2500, 3500)]),
                &mismatch,
            ),
        ];
        for (inv, reason) in cases {
            assert_purchase_rejected(&mut conn, ADMIN, inv, reason);
        }
        assert_eq!(count(&conn, "SELECT sell_price FROM products WHERE id = 'p-brufen-400'"), 3500);
    }

    #[test]
    fn same_supplier_invoice_cannot_be_posted_twice() {
        let mut conn = db();
        let inv = || purchase("INV-600", "credit", vec![pline("p-brufen-400", "BR500", "2099-06-30", 10, 2500, 3500)]);
        post_purchase_inner(&mut conn, ADMIN, inv()).unwrap();
        let e = post_purchase_inner(&mut conn, ADMIN, inv()).unwrap_err();
        assert!(e.contains("مُرحّلة مسبقاً"), "{e}");
        assert_eq!(supplier_balance(&conn), 25_000, "balance counted once");
        assert_eq!(count(&conn, "SELECT qty_on_hand FROM batches WHERE batch_no = 'BR500'"), 10, "stock counted once");
    }

    #[test]
    fn cashier_cannot_post_purchases_or_add_suppliers() {
        let mut conn = db();
        add_user(&conn, "u-cash", "cashier");
        let inv = purchase("INV-700", "cash", vec![pline("p-brufen-400", "BR500", "2099-06-30", 10, 2500, 3500)]);
        assert_purchase_rejected(&mut conn, "u-cash", inv, "صلاحية");
        let s = NewSupplier { name: "مورد".into(), phone: None, payment_terms_days: None };
        assert!(add_supplier_inner(&mut conn, "u-cash", s).unwrap_err().contains("صلاحية"));
    }

    #[test]
    fn add_supplier_validates_and_rejects_duplicates() {
        let mut conn = db();
        let s = |name: &str, terms: Option<i64>| NewSupplier { name: name.into(), phone: Some("0770".into()), payment_terms_days: terms };
        let added = add_supplier_inner(&mut conn, ADMIN, s("شركة الرافدين", Some(60))).unwrap();
        assert_eq!((added.payment_terms_days, added.balance, added.phone.as_deref()), (60, 0, Some("0770")));
        assert!(add_supplier_inner(&mut conn, ADMIN, s("شركة الرافدين", None)).unwrap_err().contains("موجود مسبقاً"));
        assert!(add_supplier_inner(&mut conn, ADMIN, s("  ", None)).unwrap_err().contains("مطلوب"));
        assert!(add_supplier_inner(&mut conn, ADMIN, s("X", Some(400))).unwrap_err().contains("مدة السداد"));
    }

    // ── Reports ──

    fn today(conn: &Connection) -> String {
        conn.query_row("SELECT date('now', 'localtime')", [], |r| r.get(0)).unwrap()
    }

    fn filter(conn: &Connection, cashier: Option<&str>, category: Option<&str>) -> ReportFilter {
        let d = today(conn);
        ReportFilter { from: d.clone(), to: d, cashier_id: cashier.map(String::from), category_id: category.map(String::from) }
    }

    /// Two sales: the admin sells 10 Brufen (line discount 1,000, invoice discount 500) plus one Augmentin;
    /// a pharmacist sells 2 Brufen with no discount.
    fn two_sales(conn: &mut Connection) {
        add_user(conn, "u-ph", "pharmacist");
        let mut d = cash_sale(vec![brufen(10, 1000), augmentin()], 100_000);
        d.invoice_discount = 500;
        post_sale_inner(conn, ADMIN, d).unwrap();
        post_sale_inner(conn, "u-ph", cash_sale(vec![brufen(2, 0)], 7000)).unwrap();
    }

    #[test]
    fn sales_report_totals_profit_and_breakdowns_agree() {
        let mut conn = db();
        two_sales(&mut conn);
        let r = report_sales_inner(&conn, &filter(&conn, None, None)).unwrap();
        let t = &r.totals;
        // Gross: 12 × 3,500 + 18,500 = 60,500. Discounts: 1,000 + 500. Cost: 12 × 2,400 + 14,800 = 43,600.
        assert_eq!((t.invoices, t.units, t.gross, t.discounts), (2, 13, 60_500, 1_500));
        assert_eq!((t.net, t.cost, t.profit), (59_000, 43_600, 15_400));
        let net: i64 = conn.query_row("SELECT SUM(total) FROM sales", [], |r| r.get(0)).unwrap();
        assert_eq!(t.net, net, "net sales equal the invoices' totals");

        for rows in [&r.by_cashier, &r.by_day, &r.top_products] {
            assert_eq!(rows.iter().map(|x| x.net).sum::<i64>(), t.net);
            assert_eq!(rows.iter().map(|x| x.profit).sum::<i64>(), t.profit);
        }
        assert_eq!(r.by_cashier.len(), 2);
        assert_eq!(r.by_cashier[0].label, "مدير النظام", "biggest seller first");
        assert_eq!((r.by_cashier[1].key.as_str(), r.by_cashier[1].net), ("u-ph", 7000));
        assert_eq!(r.by_day[0].key, today(&conn));
        assert_eq!(r.top_products[0].label, "Brufen 400 mg");
    }

    #[test]
    fn sales_report_filters_by_cashier_category_and_dates() {
        let mut conn = db();
        two_sales(&mut conn);
        let ph = report_sales_inner(&conn, &filter(&conn, Some("u-ph"), None)).unwrap().totals;
        assert_eq!((ph.invoices, ph.net, ph.profit), (1, 7000, 2200));

        // Only the Rx line of the first sale; it carries its share of the invoice discount.
        let rx = report_sales_inner(&conn, &filter(&conn, None, Some("cat-rx"))).unwrap().totals;
        assert_eq!((rx.invoices, rx.units, rx.gross), (1, 1, 18_500));
        let share: f64 = 500.0 * 18_500.0 / (34_000.0 + 18_500.0);
        assert_eq!(rx.discounts, share.round() as i64);

        let old = ReportFilter { from: "2020-01-01".into(), to: "2020-12-31".into(), cashier_id: None, category_id: None };
        let none = report_sales_inner(&conn, &old).unwrap();
        assert_eq!((none.totals.invoices, none.totals.net, none.by_day.len()), (0, 0, 0));

        let backwards = ReportFilter { from: "2026-02-01".into(), to: "2026-01-01".into(), cashier_id: None, category_id: None };
        assert!(report_sales_inner(&conn, &backwards).unwrap_err().contains("بعد"));
        let bad = ReportFilter { from: "yesterday".into(), to: "2026-01-01".into(), cashier_id: None, category_id: None };
        assert!(report_sales_inner(&conn, &bad).unwrap_err().contains("غير صالح"));
    }

    #[test]
    fn only_managers_see_money_reports() {
        let conn = db();
        for (id, role) in [("u-cash", "cashier"), ("u-ph", "pharmacist"), ("u-store", "storekeeper")] {
            add_user(&conn, id, role);
            assert!(require_permission(&conn, id, &["view_reports"]).is_err(), "{role}");
        }
        add_user(&conn, "u-chief", "chief_pharmacist");
        assert!(require_permission(&conn, "u-chief", &["view_reports"]).is_ok());
        let stock_reports = ["modify_inventory", "view_reports"];
        assert!(require_permission(&conn, "u-store", &stock_reports).is_ok(), "stock reports for the storekeeper");
        assert!(require_permission(&conn, "u-cash", &stock_reports).is_err());
    }

    #[test]
    fn expiry_report_lists_expired_and_near_batches_with_value() {
        let conn = db();
        let r = report_expiry_inner(&conn, &filter(&conn, None, None), 30).unwrap();
        let nos: Vec<_> = r.batches.iter().map(|b| b.batch_no.as_str()).collect();
        assert_eq!(nos, ["AM009", "AM014"], "expired first, then within 30 days");
        assert_eq!((r.expired_qty, r.expired_value), (4, 4 * 2900));
        assert_eq!((r.near_qty, r.near_value), (18, 18 * 2900));
        assert!(r.batches[0].days_left < 0 && r.batches[1].days_left == 22);

        let wide = report_expiry_inner(&conn, &filter(&conn, None, None), 90).unwrap();
        assert_eq!(wide.batches.len(), 4, "adds Panadol Extra (48 days) and Ventolin (75 days)");
        let otc = report_expiry_inner(&conn, &filter(&conn, None, Some("cat-otc")), 90).unwrap();
        assert_eq!(otc.batches.iter().map(|b| b.batch_no.as_str()).collect::<Vec<_>>(), ["PX0921"]);
        assert!(report_expiry_inner(&conn, &filter(&conn, None, None), -1).is_err());
    }

    #[test]
    fn expiry_report_shows_write_offs_with_their_reason() {
        let mut conn = db();
        let adj = AdjustBatch { batch_id: "b-am-009".into(), new_qty: 0, reason: "إتلاف منتهي الصلاحية".into() };
        adjust_batch_inner(&mut conn, ADMIN, adj).unwrap();
        // A count that found extra stock is not a write-off.
        let up = AdjustBatch { batch_id: "b-br-400".into(), new_qty: 56, reason: "جرد".into() };
        adjust_batch_inner(&mut conn, ADMIN, up).unwrap();

        let r = report_expiry_inner(&conn, &filter(&conn, None, None), 30).unwrap();
        assert_eq!(r.write_offs.len(), 1);
        let w = &r.write_offs[0];
        assert_eq!((w.batch_no.as_str(), w.qty, w.value), ("AM009", 4, 4 * 2900));
        assert_eq!(w.reason.as_deref(), Some("إتلاف منتهي الصلاحية"));
        assert_eq!(w.user.as_deref(), Some("مدير النظام"));
        assert_eq!(r.written_off_value, 4 * 2900);
        assert_eq!(r.expired_qty, 0, "disposed stock no longer counts as on the shelf");
    }

    #[test]
    fn reorder_report_puts_out_of_stock_first_and_suggests_quantities() {
        let mut conn = db();
        // Sell 3 Ventolin today: 6 left at 3 a month = 60 days of cover.
        post_sale_inner(&mut conn, ADMIN, cash_sale(vec![line("p-ventolin", 7000, &[("b-vt-501", 3)])], 21_000)).unwrap();
        let rows = report_reorder_inner(&conn, None).unwrap();
        let ids: Vec<_> = rows.iter().map(|r| r.product_id.as_str()).collect();
        assert_eq!(ids, ["p-glucophage-xr", "p-ventolin", "p-amoxil-500"]);

        let xr = &rows[0];
        assert_eq!((xr.stock, xr.reorder_level, xr.suggested_qty), (0, None, 1));
        let vt = &rows[1];
        assert_eq!((vt.stock, vt.sold_30d, vt.days_of_cover), (6, 3, Some(60)));
        assert_eq!((vt.suggested_qty, vt.supplier.as_deref(), vt.last_cost), (50 - 6, Some("المورد أ (تجريبي)"), Some(5400)));
        let am = &rows[2];
        assert_eq!((am.stock, am.reorder_level, am.suggested_qty, am.days_of_cover), (18, Some(25), 80 - 18, None));

        assert!(report_reorder_inner(&conn, Some("cat-otc")).unwrap().is_empty());
    }

    #[test]
    fn prescription_report_lists_rx_items_doctor_and_pharmacist() {
        let mut conn = db();
        add_user(&conn, "u-ph", "pharmacist");
        // Rx sale with an OTC item on the same invoice: only the Rx item is listed.
        let mut d = cash_sale(vec![augmentin(), brufen(1, 0)], 22_000);
        d.prescription = Some(PrescriptionIn { rx_no: "RX-9".into(), prescriber: "د. سارة".into() });
        post_sale_inner(&mut conn, "u-ph", d).unwrap();
        let concor = line("p-concor-5", 9000, &[("b-cn-118", 2)]);
        post_sale_inner(&mut conn, ADMIN, cash_sale(vec![concor], 18_000)).unwrap(); // prescriber "د. علي"
        let mut d = cash_sale(vec![augmentin()], 18_500);
        d.prescription = Some(PrescriptionIn { rx_no: "RX-10".into(), prescriber: "د. سارة".into() });
        post_sale_inner(&mut conn, ADMIN, d).unwrap();
        post_sale_inner(&mut conn, ADMIN, cash_sale(vec![brufen(1, 0)], 3500)).unwrap(); // no Rx items: not listed

        let r = report_prescriptions_inner(&conn, &filter(&conn, None, None)).unwrap();
        assert_eq!(r.rows.len(), 3);
        let first = r.rows.iter().find(|x| x.rx_no == "RX-9").unwrap();
        assert_eq!((first.items.as_str(), first.rx_total), ("Augmentin 1 g ×1", 18_500));
        assert_eq!((first.prescriber.as_str(), first.pharmacist.as_deref()), ("د. سارة", Some("u-ph")));
        let concor = r.rows.iter().find(|x| x.rx_no == "RX-1").unwrap();
        assert_eq!(concor.items, "Concor 5 mg ×2");

        let docs: Vec<_> = r.by_prescriber.iter().map(|p| (p.prescriber.as_str(), p.prescriptions, p.units)).collect();
        assert_eq!(docs, [("د. سارة", 2, 2), ("د. علي", 1, 2)]);

        let only_ph = report_prescriptions_inner(&conn, &filter(&conn, Some("u-ph"), None)).unwrap();
        assert_eq!(only_ph.rows.len(), 1);
    }

    // ── Employees and permissions ──

    const PW: &str = "strong-pass-1";

    /// Demo database where the admin has chosen a password.
    fn admin_db() -> Connection {
        let mut conn = db();
        setup_admin_inner(&mut conn, PW).unwrap();
        conn
    }

    fn new_user(username: &str, role: &str) -> NewUser {
        NewUser {
            username: username.into(),
            full_name: format!("موظف {username}"),
            password: PW.into(),
            role: role.into(),
            overrides: PermissionOverrides::default(),
        }
    }

    fn grant(p: &str, value: bool) -> PermissionOverrides {
        let mut o = PermissionOverrides::default();
        o.set(p, Some(value));
        o
    }

    fn audits(conn: &Connection, action: &str) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM audit_log WHERE action = ?1", params![action], |r| r.get(0)).unwrap()
    }

    #[test]
    fn admin_creates_an_employee_who_can_sign_in() {
        let mut conn = admin_db();
        let u = create_user_inner(&mut conn, ADMIN, new_user("Sara.K", "cashier")).unwrap();
        assert_eq!((u.username.as_str(), u.role.as_str(), u.active, u.has_password), ("sara.k", "cashier", true, true));
        assert_eq!(
            u.permissions,
            Permissions { give_discount: true, dispense_rx: false, view_reports: false, modify_inventory: false }
        );
        let stored: String = conn.query_row("SELECT password_hash FROM users WHERE id = ?1", params![u.id], |r| r.get(0)).unwrap();
        assert!(stored.starts_with("$argon2"));
        let logged = login_inner(&mut conn, "sara.k", PW).unwrap();
        assert_eq!(logged.id, u.id);
        assert!(!logged.permissions.dispense_rx);

        assert_eq!(audits(&conn, "user.create"), 1);
        let payload: String = conn.query_row("SELECT payload FROM audit_log WHERE action = 'user.create'", [], |r| r.get(0)).unwrap();
        assert!(!payload.contains(PW) && !payload.contains("argon2"), "{payload}");
        let rows = list_users_inner(&conn, ADMIN).unwrap();
        assert!(rows.iter().find(|r| r.id == u.id).unwrap().last_login.is_some());
    }

    #[test]
    fn create_user_rejects_bad_input() {
        let mut conn = admin_db();
        let cases = [
            (NewUser { username: "ADMIN".into(), ..new_user("x", "cashier") }, "مستخدم مسبقاً"),
            (new_user("ab", "cashier"), "اسم المستخدم"),
            (new_user("سارة", "cashier"), "اسم المستخدم"),
            (new_user("has space", "cashier"), "اسم المستخدم"),
            (NewUser { password: "short".into(), ..new_user("sara", "cashier") }, "كلمة المرور"),
            (NewUser { full_name: " ".into(), ..new_user("sara", "cashier") }, "الاسم الكامل"),
            (new_user("sara", "owner"), "الدور"),
        ];
        for (u, reason) in cases {
            let e = create_user_inner(&mut conn, ADMIN, u).unwrap_err();
            assert!(e.contains(reason), "expected {reason:?}, got {e:?}");
        }
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM users"), 1);
    }

    #[test]
    fn only_admins_manage_employees() {
        let mut conn = admin_db();
        add_user(&conn, "u-ph", "pharmacist");
        add_user(&conn, "u-chief", "chief_pharmacist");
        // Overrides cannot turn anyone into a user manager.
        let all = PermissionOverrides {
            give_discount: Some(true),
            dispense_rx: Some(true),
            view_reports: Some(true),
            modify_inventory: Some(true),
        };
        update_user_role_inner(&mut conn, ADMIN, "u-chief", "chief_pharmacist", all).unwrap();
        for who in ["u-ph", "u-chief"] {
            let denied = |e: String| assert!(e.contains("للمدير فقط"), "{who}: {e}");
            denied(list_users_inner(&conn, who).unwrap_err());
            denied(create_user_inner(&mut conn, who, new_user("sara", "admin")).unwrap_err());
            denied(update_user_role_inner(&mut conn, who, who, "admin", PermissionOverrides::default()).unwrap_err());
            denied(toggle_user_status_inner(&mut conn, who, ADMIN, false).unwrap_err());
            denied(reset_user_password_inner(&mut conn, who, ADMIN, "takeover-123").unwrap_err());
        }
        assert_eq!(active_role(&conn, ADMIN).unwrap(), "admin");
        assert!(login_inner(&mut conn, "admin", PW).is_ok(), "admin password unchanged");
    }

    #[test]
    fn overrides_grant_and_deny_at_the_till() {
        let mut conn = admin_db();
        add_user(&conn, "u-cash", "cashier");
        add_user(&conn, "u-ph", "pharmacist");
        // Cashier allowed to dispense, pharmacist not.
        update_user_role_inner(&mut conn, ADMIN, "u-cash", "cashier", grant("dispense_rx", true)).unwrap();
        update_user_role_inner(&mut conn, ADMIN, "u-ph", "pharmacist", grant("dispense_rx", false)).unwrap();
        post_sale_inner(&mut conn, "u-cash", cash_sale(vec![augmentin()], 18_500)).unwrap();
        let e = post_sale_inner(&mut conn, "u-ph", cash_sale(vec![augmentin()], 18_500)).unwrap_err();
        assert!(e.contains("صيدلاني"), "{e}");

        // Cashier barred from discounts: any discount refused, a full-price sale still fine.
        update_user_role_inner(&mut conn, ADMIN, "u-cash", "cashier", grant("give_discount", false)).unwrap();
        let e = post_sale_inner(&mut conn, "u-cash", cash_sale(vec![brufen(10, 100)], 35_000)).unwrap_err();
        assert!(e.contains("خصم"), "{e}");
        post_sale_inner(&mut conn, "u-cash", cash_sale(vec![brufen(1, 0)], 3500)).unwrap();
        assert!(!user_row(&conn, "u-cash").unwrap().permissions.dispense_rx, "the role change reset the old override");
    }

    #[test]
    fn overrides_grant_and_deny_inventory_and_reports() {
        let mut conn = admin_db();
        add_user(&conn, "u-store", "storekeeper");
        add_user(&conn, "u-ph", "pharmacist");
        update_user_role_inner(&mut conn, ADMIN, "u-store", "storekeeper", grant("view_reports", true)).unwrap();
        update_user_role_inner(&mut conn, ADMIN, "u-ph", "pharmacist", grant("modify_inventory", false)).unwrap();
        assert!(require_permission(&conn, "u-store", &["view_reports"]).is_ok());
        let e = add_product_inner(&mut conn, "u-ph", new_product("X", None)).unwrap_err();
        assert!(e.contains("صلاحية"), "{e}");
        assert!(require_permission(&conn, "u-ph", &["modify_inventory", "view_reports"]).is_err());
    }

    #[test]
    fn only_real_exceptions_are_stored_and_admins_keep_everything() {
        let mut conn = admin_db();
        add_user(&conn, "u-ph", "pharmacist");
        // Granting a pharmacist what the role already has is not an exception.
        let same = PermissionOverrides { dispense_rx: Some(true), view_reports: Some(true), ..Default::default() };
        let r = update_user_role_inner(&mut conn, ADMIN, "u-ph", "pharmacist", same).unwrap();
        assert_eq!(r.overrides, PermissionOverrides { view_reports: Some(true), ..Default::default() });
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM user_permissions"), 1);

        // Promoting to admin drops overrides; an admin always has every permission.
        let r = update_user_role_inner(&mut conn, ADMIN, "u-ph", "admin", grant("dispense_rx", false)).unwrap();
        assert_eq!(r.overrides, PermissionOverrides::default());
        assert!(r.permissions.dispense_rx && r.permissions.view_reports);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM user_permissions"), 0);
        assert_eq!(audits(&conn, "user.role"), 2);
    }

    #[test]
    fn deactivated_accounts_stop_working_at_once() {
        let mut conn = admin_db();
        let u = create_user_inner(&mut conn, ADMIN, new_user("sara", "cashier")).unwrap();
        let off = toggle_user_status_inner(&mut conn, ADMIN, &u.id, false).unwrap();
        assert!(!off.active);
        assert_eq!(login_inner(&mut conn, "sara", PW).unwrap_err(), BAD_LOGIN);
        // Already signed in elsewhere: the next sale is refused.
        assert!(post_sale_inner(&mut conn, &u.id, cash_sale(vec![brufen(1, 0)], 3500)).unwrap_err().contains("معطّل"));
        toggle_user_status_inner(&mut conn, ADMIN, &u.id, false).unwrap();
        assert_eq!(audits(&conn, "user.status"), 1, "repeating the same state changes nothing");

        toggle_user_status_inner(&mut conn, ADMIN, &u.id, true).unwrap();
        assert!(login_inner(&mut conn, "sara", PW).is_ok());
        assert_eq!(audits(&conn, "user.status"), 2);
    }

    #[test]
    fn admins_cannot_lock_themselves_out() {
        let mut conn = admin_db();
        let e = toggle_user_status_inner(&mut conn, ADMIN, ADMIN, false).unwrap_err();
        assert!(e.contains("حسابك"), "{e}");
        let e = update_user_role_inner(&mut conn, ADMIN, ADMIN, "pharmacist", PermissionOverrides::default()).unwrap_err();
        assert!(e.contains("حسابك"), "{e}");

        // With a second admin, one admin may demote the other.
        let second = create_user_inner(&mut conn, ADMIN, new_user("boss2", "admin")).unwrap();
        update_user_role_inner(&mut conn, &second.id, ADMIN, "pharmacist", PermissionOverrides::default()).unwrap();
        assert!(list_users_inner(&conn, ADMIN).unwrap_err().contains("للمدير فقط"));
        // Now boss2 is the last admin; nobody else can remove them.
        assert!(toggle_user_status_inner(&mut conn, &second.id, &second.id, false).is_err());
        assert_eq!(other_active_admins(&conn, &second.id).unwrap(), 0);
    }

    #[test]
    fn reset_password_replaces_the_hash_and_logs_no_secret() {
        let mut conn = admin_db();
        let u = create_user_inner(&mut conn, ADMIN, new_user("sara", "cashier")).unwrap();
        assert!(reset_user_password_inner(&mut conn, ADMIN, &u.id, "short").unwrap_err().contains("كلمة المرور"));
        reset_user_password_inner(&mut conn, ADMIN, &u.id, "new-secret-99").unwrap();
        assert_eq!(login_inner(&mut conn, "sara", PW).unwrap_err(), BAD_LOGIN);
        assert!(login_inner(&mut conn, "sara", "new-secret-99").is_ok());
        let payload: String =
            conn.query_row("SELECT payload FROM audit_log WHERE action = 'user.password_reset'", [], |r| r.get(0)).unwrap();
        assert_eq!(payload, "{}");
        assert!(reset_user_password_inner(&mut conn, ADMIN, "u-ghost", "new-secret-99").is_err());
    }
}
