//! Pharmacy POS — local data layer.
//! Everything is stored in one SQLite file in the app's data folder, so the shop keeps selling with no internet.
//! All stock-changing writes happen here inside a single transaction.

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tauri::{Manager, State};

pub struct Db(pub Mutex<Connection>);

const INIT_SQL: &str = include_str!("../migrations/0001_init.sql");
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
pub struct SaleDraft {
    lines: Vec<SaleLineIn>,
    invoice_discount: i64,
    payments: Vec<PaymentIn>,
    patient_id: Option<String>,
    user_id: String,
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

#[tauri::command]
fn post_sale(db: State<'_, Db>, draft: SaleDraft) -> Result<SaleResult, String> {
    let mut conn = db.0.lock().map_err(err)?;
    post_sale_inner(&mut conn, draft)
}

fn post_sale_inner(conn: &mut Connection, draft: SaleDraft) -> Result<SaleResult, String> {
    if draft.lines.is_empty() {
        return Err("الفاتورة فارغة".into());
    }
    let tx = conn.transaction().map_err(err)?;

    // Totals are recomputed here; the screen's numbers are never trusted blindly.
    let mut subtotal = 0i64;
    let mut line_discounts = 0i64;
    for l in &draft.lines {
        let qty: i64 = l.allocations.iter().map(|a| a.qty).sum();
        if qty <= 0 || l.allocations.iter().any(|a| a.qty <= 0) {
            return Err("كمية غير صالحة في أحد الأسطر".into());
        }
        let gross = l.unit_price * qty;
        subtotal += gross;
        line_discounts += l.discount.clamp(0, gross);
    }
    let after_lines = subtotal - line_discounts;
    let invoice_discount = draft.invoice_discount.clamp(0, after_lines);
    let total = after_lines - invoice_discount;

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
            draft.user_id,
            subtotal,
            line_discounts + invoice_discount,
            total,
            paid,
            change,
            now
        ],
    )
    .map_err(err)?;

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
                params![new_id(), a.batch_id, -a.qty, unit_cost, sale_id, draft.user_id, now],
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

    let payload = serde_json::json!({ "invoiceNo": invoice_no, "total": total, "lines": draft.lines.len() }).to_string();
    append_audit(&tx, &draft.user_id, "sale.create", "sales", &sale_id, &payload, &now).map_err(err)?;
    tx.commit().map_err(err)?;

    Ok(SaleResult { sale_id, invoice_no, total, paid, change, created_at: now })
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search_products,
            find_by_code,
            alternatives,
            product_batches,
            post_sale
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

    fn cash_sale(lines: Vec<SaleLineIn>, cash: i64) -> SaleDraft {
        SaleDraft {
            lines,
            invoice_discount: 0,
            payments: vec![PaymentIn { method: "cash".into(), amount: cash, reference: None }],
            patient_id: None,
            user_id: "u-admin".into(),
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
        let r = post_sale_inner(&mut conn, draft).unwrap();
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
        assert!(post_sale_inner(&mut conn, draft).is_err());
        assert_eq!(qty(&conn, "b-br-400"), 55, "first line must roll back too");
    }

    #[test]
    fn expired_batch_cannot_be_sold() {
        let mut conn = db();
        let draft = cash_sale(vec![line("p-amoxil-500", 4500, &[("b-am-009", 1)])], 4500);
        assert!(post_sale_inner(&mut conn, draft).is_err());
    }

    #[test]
    fn underpayment_is_rejected() {
        let mut conn = db();
        let draft = cash_sale(vec![line("p-concor-5", 9000, &[("b-cn-118", 1)])], 5000);
        assert!(post_sale_inner(&mut conn, draft).is_err());
    }

    #[test]
    fn audit_log_is_hash_chained_and_append_only() {
        let mut conn = db();
        for _ in 0..2 {
            let d = cash_sale(vec![line("p-brufen-400", 3500, &[("b-br-400", 1)])], 3500);
            post_sale_inner(&mut conn, d).unwrap();
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
}
