//! Pharmacy POS — local data layer.
//! Everything is stored in one SQLite file in the app's data folder, so the shop keeps selling with no internet.
//! All stock-changing writes happen here inside a single transaction.

use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tauri::{Manager, State};

pub struct Db(pub Mutex<Connection>);

/// Id of the user signed in on this device. Write commands take the user from here, never from the screen.
#[derive(Default)]
pub struct Session(pub Mutex<Option<String>>);

const INIT_SQL: &str = include_str!("../migrations/0001_init.sql");
const SALE_CONTROLS_SQL: &str = include_str!("../migrations/0002_sale_controls.sql");
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    /// True until the first password is set; the screen then asks the admin to choose one.
    needs_setup: bool,
    user: Option<UserDto>,
}

#[derive(Serialize)]
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
    conn.query_row(
        "SELECT id, username, full_name, role FROM users WHERE id = ?1 AND is_active = 1",
        params![user_id],
        |r| Ok(UserDto { id: r.get(0)?, username: r.get(1)?, full_name: r.get(2)?, role: r.get(3)? }),
    )
    .optional()
    .map_err(err)
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

/// Roles that may give any discount; everyone else is held to the `max_discount_pct` setting.
const UNLIMITED_DISCOUNT_ROLES: [&str; 2] = ["admin", "chief_pharmacist"];
/// Roles allowed to dispense prescription-only medicines.
const RX_ROLES: [&str; 3] = ["admin", "chief_pharmacist", "pharmacist"];

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
    let role: String = tx
        .query_row("SELECT role FROM users WHERE id = ?1 AND is_active = 1", params![user_id], |r| r.get(0))
        .optional()
        .map_err(err)?
        .ok_or("الحساب غير موجود أو معطّل، سجّل الدخول من جديد")?;

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
        if !RX_ROLES.contains(&role.as_str()) {
            return Err("الفاتورة تحتوي دواءً بوصفة طبية ويجب أن يصرفها صيدلاني".into());
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

/// Roles allowed to create products and change stock. Every signed-in user may view inventory.
const INVENTORY_ROLES: [&str; 4] = ["admin", "chief_pharmacist", "pharmacist", "storekeeper"];

fn session_user(session: &State<'_, Session>) -> Result<String, String> {
    session.0.lock().map_err(err)?.clone().ok_or_else(|| "سجّل الدخول أولاً".to_string())
}

/// The user's role, read from the database; fails if the account is disabled or the role is not in `allowed`.
fn require_role(conn: &Connection, user_id: &str, allowed: &[&str]) -> Result<String, String> {
    let role: String = conn
        .query_row("SELECT role FROM users WHERE id = ?1 AND is_active = 1", params![user_id], |r| r.get(0))
        .optional()
        .map_err(err)?
        .ok_or("الحساب غير موجود أو معطّل، سجّل الدخول من جديد")?;
    if !allowed.contains(&role.as_str()) {
        return Err("ليست لديك صلاحية لتعديل المخزون".into());
    }
    Ok(role)
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
    require_role(&tx, user_id, &INVENTORY_ROLES)?;
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
    require_role(&tx, user_id, &INVENTORY_ROLES)?;
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
    require_role(&tx, user_id, &INVENTORY_ROLES)?;
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
            adjust_batch
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
        assert_eq!(v, 2);
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
}
