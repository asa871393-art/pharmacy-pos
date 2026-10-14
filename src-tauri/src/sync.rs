//! Cloud sync. The local SQLite file stays the main database: every screen reads and writes it, with or without
//! internet. Writes the cloud should know about also add an entry to the `sync_queue` outbox in the same transaction;
//! this worker pushes those entries to Supabase when it can reach it, then pulls the catalog (owned by the cloud) and
//! the stock level of every batch (the sum of all tills' movements) back down. The cloud side is supabase/schema.sql.

use rusqlite::{params, types::Value as SqlValue, types::ValueRef, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::Notify;

pub const EVENT: &str = "sync-status";

/// Entries pushed per request.
const PUSH_BATCH: i64 = 50;
/// After this many rejections an entry stops being retried until someone presses "sync now".
pub const MAX_ATTEMPTS: i64 = 5;
/// Each pull re-reads this many revisions before the cursor, so a push that committed late is not missed.
const PULL_OVERLAP: i64 = 500;
/// Rows the history backfill puts in one queue entry.
const BACKFILL_CHUNK: usize = 200;

// ── Waking the worker ──

fn wake_signal() -> &'static Notify {
    static WAKE: OnceLock<Notify> = OnceLock::new();
    WAKE.get_or_init(Notify::new)
}

/// Asks the worker to sync now instead of at its next tick.
pub fn nudge() {
    wake_signal().notify_one();
}

// ── Outbox ──

/// Adds an entry to the outbox. Call it inside the transaction that made the change.
pub fn enqueue(conn: &Connection, kind: &str, payload: &Value) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO sync_queue(id, kind, payload) VALUES (?1, ?2, ?3)",
        params![uuid::Uuid::now_v7().to_string(), kind, payload.to_string()],
    )?;
    nudge();
    Ok(())
}

fn to_json(v: ValueRef) -> Value {
    match v {
        ValueRef::Null | ValueRef::Blob(_) => Value::Null,
        ValueRef::Integer(n) => n.into(),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned().into(),
    }
}

/// Every row of a query as a JSON object keyed by column name.
pub fn rows_json<P: rusqlite::Params>(conn: &Connection, sql: &str, p: P) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.query(p)?;
    let mut out = vec![];
    while let Some(r) = rows.next()? {
        let mut m = Map::new();
        for (i, n) in names.iter().enumerate() {
            m.insert(n.clone(), to_json(r.get_ref(i)?));
        }
        out.push(Value::Object(m));
    }
    Ok(out)
}

fn row_json<P: rusqlite::Params>(conn: &Connection, sql: &str, p: P) -> rusqlite::Result<Value> {
    Ok(rows_json(conn, sql, p)?.into_iter().next().unwrap_or(Value::Null))
}

/// The movements matching `filter` (a WHERE clause over stock_movements) and the batches they touch.
fn stock_parts(conn: &Connection, filter: &str, id: &str) -> rusqlite::Result<(Vec<Value>, Vec<Value>)> {
    let movements = rows_json(conn, &format!("SELECT * FROM stock_movements WHERE {filter} ORDER BY occurred_at, id"), [id])?;
    let batches =
        rows_json(conn, &format!("SELECT * FROM batches WHERE id IN (SELECT batch_id FROM stock_movements WHERE {filter})"), [id])?;
    Ok((batches, movements))
}

/// A product with its category, barcodes and reorder rules.
pub fn product_payload(conn: &Connection, product_id: &str) -> rusqlite::Result<Value> {
    Ok(json!({
        "product": row_json(conn, "SELECT * FROM products WHERE id = ?1", [product_id])?,
        "category": row_json(
            conn,
            "SELECT c.* FROM categories c JOIN products p ON p.category_id = c.id WHERE p.id = ?1",
            [product_id],
        )?,
        "barcodes": rows_json(conn, "SELECT * FROM product_barcodes WHERE product_id = ?1 ORDER BY code", [product_id])?,
        "reorder": rows_json(conn, "SELECT * FROM reorder_rules WHERE product_id = ?1", [product_id])?,
    }))
}

/// A sale with its lines, payments, prescription and the stock it took.
pub fn sale_payload(conn: &Connection, sale_id: &str) -> rusqlite::Result<Value> {
    let (batches, movements) = stock_parts(conn, "ref_type = 'sale' AND ref_id = ?1", sale_id)?;
    Ok(json!({
        "sale": row_json(conn, "SELECT * FROM sales WHERE id = ?1", [sale_id])?,
        "items": rows_json(conn, "SELECT * FROM sale_items WHERE sale_id = ?1", [sale_id])?,
        "payments": rows_json(conn, "SELECT * FROM payments WHERE sale_id = ?1", [sale_id])?,
        "prescription": row_json(conn, "SELECT * FROM sale_prescriptions WHERE sale_id = ?1", [sale_id])?,
        "batches": batches,
        "movements": movements,
    }))
}

/// A supplier invoice with its lines and the batches and movements it created.
pub fn purchase_payload(conn: &Connection, invoice_id: &str) -> rusqlite::Result<Value> {
    let (batches, movements) = stock_parts(conn, "ref_type = 'purchase_invoice' AND ref_id = ?1", invoice_id)?;
    Ok(json!({
        "invoice": row_json(conn, "SELECT * FROM purchase_invoices WHERE id = ?1", [invoice_id])?,
        "items": rows_json(conn, "SELECT * FROM purchase_invoice_items WHERE invoice_id = ?1", [invoice_id])?,
        "supplier": row_json(
            conn,
            "SELECT s.id, s.name FROM suppliers s JOIN purchase_invoices i ON i.supplier_id = s.id WHERE i.id = ?1",
            [invoice_id],
        )?,
        "batches": batches,
        "movements": movements,
    }))
}

/// One stock movement (manual receipt, count correction) and its batch.
pub fn movement_payload(conn: &Connection, movement_id: &str) -> rusqlite::Result<Value> {
    let (batches, movements) = stock_parts(conn, "id = ?1", movement_id)?;
    Ok(json!({ "batches": batches, "movements": movements }))
}

/// Queues what was already in the database before sync existed (and the demo data of a new install), so the cloud
/// gets the whole history. Movements already covered by a sale or purchase entry are not repeated.
pub fn backfill(conn: &Connection) -> rusqlite::Result<()> {
    let ids = |sql: &str| -> rusqlite::Result<Vec<String>> {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect()
    };
    for id in ids("SELECT id FROM products ORDER BY id")? {
        enqueue(conn, "UPDATE_PRODUCT", &product_payload(conn, &id)?)?;
    }
    let covered = "(ref_type = 'sale' AND ref_id IN (SELECT id FROM sales))
                   OR (ref_type = 'purchase_invoice' AND ref_id IN (SELECT id FROM purchase_invoices))";
    let loose = rows_json(conn, &format!("SELECT * FROM stock_movements WHERE NOT ({covered}) ORDER BY occurred_at, id"), [])?;
    for chunk in loose.chunks(BACKFILL_CHUNK) {
        let batch_ids: Vec<&str> = chunk.iter().filter_map(|m| m["batch_id"].as_str()).collect();
        let placeholders = vec!["?"; batch_ids.len()].join(",");
        let batches = rows_json(
            conn,
            &format!("SELECT * FROM batches WHERE id IN ({placeholders})"),
            rusqlite::params_from_iter(batch_ids.iter()),
        )?;
        enqueue(conn, "STOCK_ADJUST", &json!({ "batches": batches, "movements": chunk }))?;
    }
    for id in ids("SELECT id FROM purchase_invoices ORDER BY created_at, id")? {
        enqueue(conn, "ADD_PURCHASE", &purchase_payload(conn, &id)?)?;
    }
    for id in ids("SELECT id FROM sales ORDER BY created_at, id")? {
        enqueue(conn, "POST_SALE", &sale_payload(conn, &id)?)?;
    }
    let audit = rows_json(conn, "SELECT * FROM audit_log ORDER BY seq", [])?;
    for chunk in audit.chunks(BACKFILL_CHUNK) {
        enqueue(conn, "AUDIT_LOG", &json!({ "entries": chunk }))?;
    }
    Ok(())
}

// ── Applying what the cloud sends ──

fn to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(SqlValue::Integer).unwrap_or_else(|| SqlValue::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

/// Inserts or updates one row from a JSON object, using only the columns the local table has. A reference to a row
/// this computer does not have (a supplier added on another till, say) is cleared when the column allows it;
/// otherwise the row is skipped. Returns whether the row was written.
fn upsert_row(conn: &Connection, table: &str, doc: &Map<String, Value>, skip: &[&str]) -> rusqlite::Result<bool> {
    // (name, not null, primary key position)
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let info: Vec<(String, bool, i64)> =
        stmt.query_map([], |r| Ok((r.get(1)?, r.get::<_, i64>(3)? != 0, r.get(5)?)))?.collect::<rusqlite::Result<_>>()?;
    let mut values: Vec<(String, Value)> = info
        .iter()
        .filter(|(name, _, _)| !skip.contains(&name.as_str()))
        .filter_map(|(name, _, _)| doc.get(name).map(|v| (name.clone(), v.clone())))
        .collect();
    let mut stmt = conn.prepare(&format!("PRAGMA foreign_key_list({table})"))?;
    let fks: Vec<(String, String, Option<String>)> =
        stmt.query_map([], |r| Ok((r.get(2)?, r.get(3)?, r.get(4)?)))?.collect::<rusqlite::Result<_>>()?;
    for (parent, from, to) in fks {
        let Some((_, v)) = values.iter_mut().find(|(c, _)| *c == from) else { continue };
        if v.is_null() {
            continue;
        }
        let to = to.unwrap_or_else(|| "id".into());
        let exists: bool =
            conn.query_row(&format!("SELECT EXISTS (SELECT 1 FROM {parent} WHERE {to} = ?1)"), [to_sql(v)], |r| r.get(0))?;
        if !exists {
            if info.iter().any(|(name, not_null, _)| *name == from && *not_null) {
                return Ok(false);
            }
            *v = Value::Null;
        }
    }
    if values.is_empty() {
        return Ok(false);
    }
    let mut pk: Vec<&(String, bool, i64)> = info.iter().filter(|c| c.2 > 0).collect();
    pk.sort_by_key(|c| c.2);
    let pk: Vec<&str> = pk.iter().map(|c| c.0.as_str()).collect();
    let cols: Vec<&str> = values.iter().map(|(c, _)| c.as_str()).collect();
    let updates: Vec<String> =
        cols.iter().filter(|c| !pk.contains(c)).map(|c| format!("{c} = excluded.{c}")).collect();
    let sql = format!(
        "INSERT INTO {table}({}) VALUES ({}) ON CONFLICT({}) DO {}",
        cols.join(", "),
        vec!["?"; cols.len()].join(", "),
        pk.join(", "),
        if updates.is_empty() { "NOTHING".to_string() } else { format!("UPDATE SET {}", updates.join(", ")) }
    );
    conn.execute(&sql, rusqlite::params_from_iter(values.iter().map(|(_, v)| to_sql(v))))?;
    Ok(true)
}

#[derive(Deserialize, Debug, Default)]
pub struct PulledProduct {
    pub doc: Map<String, Value>,
    #[serde(default)]
    pub barcodes: Vec<Map<String, Value>>,
    #[serde(default)]
    pub reorder: Vec<Map<String, Value>>,
}

#[derive(Deserialize, Debug, Default)]
pub struct PulledBatch {
    pub doc: Map<String, Value>,
    /// Sum of every till's movements for this batch.
    pub qty: i64,
}

#[derive(Deserialize, Debug, Default)]
pub struct Pull {
    #[serde(default)]
    pub categories: Vec<Map<String, Value>>,
    #[serde(default)]
    pub products: Vec<PulledProduct>,
    #[serde(default)]
    pub batches: Vec<PulledBatch>,
    pub cursor: i64,
}

/// Stock this computer has moved but not yet pushed, per batch.
pub fn pending_stock(conn: &Connection) -> rusqlite::Result<HashMap<String, i64>> {
    let mut stmt = conn.prepare(
        "SELECT json_extract(m.value, '$.batch_id'), SUM(json_extract(m.value, '$.qty'))
         FROM sync_queue q, json_each(q.payload, '$.movements') m
         WHERE q.sent_at IS NULL GROUP BY 1",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// Writes the catalog and stock levels from the cloud into the local database, in one transaction.
/// Products with an edit still waiting in the outbox keep the local version; it reaches the cloud on the next push.
/// A batch's quantity becomes the cloud's total plus this computer's unpushed movements.
pub fn apply_pull(conn: &mut Connection, pull: &Pull) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for c in &pull.categories {
        upsert_row(&tx, "categories", c, &[])?;
    }
    let edited: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT json_extract(payload, '$.product.id') FROM sync_queue WHERE sent_at IS NULL AND kind = 'UPDATE_PRODUCT'",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, Option<String>>(0))?;
        rows.filter_map(|r| r.transpose()).collect::<rusqlite::Result<_>>()?
    };
    for p in &pull.products {
        let Some(id) = p.doc.get("id").and_then(Value::as_str) else { continue };
        if edited.iter().any(|e| e == id) || !upsert_row(&tx, "products", &p.doc, &[])? {
            continue;
        }
        let codes: Vec<&str> = p.barcodes.iter().filter_map(|b| b.get("code").and_then(Value::as_str)).collect();
        tx.execute(
            "DELETE FROM product_barcodes WHERE product_id = ?1 AND code NOT IN (SELECT value FROM json_each(?2))",
            params![id, serde_json::to_string(&codes).unwrap_or_default()],
        )?;
        for b in &p.barcodes {
            upsert_row(&tx, "product_barcodes", b, &[])?;
        }
        for r in &p.reorder {
            upsert_row(&tx, "reorder_rules", r, &[])?;
        }
    }
    let pending = pending_stock(&tx)?;
    for b in &pull.batches {
        let Some(id) = b.doc.get("id").and_then(Value::as_str) else { continue };
        if upsert_row(&tx, "batches", &b.doc, &["qty_on_hand"])? {
            let qty = b.qty + pending.get(id).copied().unwrap_or(0);
            tx.execute("UPDATE batches SET qty_on_hand = ?1 WHERE id = ?2", params![qty, id])?;
        }
    }
    tx.execute("UPDATE settings SET value = ?1 WHERE key = 'sync_cursor'", [pull.cursor.to_string()])?;
    tx.commit()
}

// ── Settings and status ──

#[derive(Debug, Clone, Default)]
pub struct SyncConfig {
    pub enabled: bool,
    pub url: String,
    pub key: String,
    pub secret: String,
    pub device_id: String,
    pub device_name: String,
}

fn setting(conn: &Connection, key: &str) -> rusqlite::Result<String> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get::<_, String>(0))
        .optional()?
        .unwrap_or_default())
}

pub fn load_config(conn: &Connection) -> rusqlite::Result<SyncConfig> {
    Ok(SyncConfig {
        enabled: setting(conn, "sync_enabled")? == "1",
        url: setting(conn, "sync_url")?,
        key: setting(conn, "sync_key")?,
        secret: setting(conn, "sync_secret")?,
        device_id: setting(conn, "sync_device_id")?,
        device_name: setting(conn, "sync_device_name")?,
    })
}

impl SyncConfig {
    pub fn ready(&self) -> bool {
        self.enabled && !self.url.is_empty() && !self.key.is_empty() && !self.secret.is_empty()
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SyncState {
    /// Not set up, or switched off: the app works on its local database only.
    Disabled,
    /// The cloud cannot be reached; everything is saved locally and queued.
    Offline,
    /// Pushing the queue or pulling the catalog.
    Syncing,
    /// Everything pushed and the catalog is current.
    Synced,
    /// The cloud answered with an error (wrong key or secret, rejected entries).
    Error,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub state: SyncState,
    /// Entries waiting to be pushed.
    pub pending: i64,
    /// Entries the cloud rejected MAX_ATTEMPTS times; they wait for "sync now".
    pub failed: i64,
    /// UTC time of the last complete sync.
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
}

pub fn counts(conn: &Connection) -> rusqlite::Result<(i64, i64)> {
    conn.query_row(
        "SELECT COUNT(*) FILTER (WHERE attempts < ?1), COUNT(*) FILTER (WHERE attempts >= ?1)
         FROM sync_queue WHERE sent_at IS NULL",
        [MAX_ATTEMPTS],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

pub fn status_with(conn: &Connection, state: SyncState, last_error: Option<String>) -> rusqlite::Result<SyncStatus> {
    let (pending, failed) = counts(conn)?;
    let last = setting(conn, "sync_last_at")?;
    Ok(SyncStatus { state, pending, failed, last_sync_at: (!last.is_empty()).then_some(last), last_error })
}

/// The worker's latest status, read by the `sync_status` command and sent as the `sync-status` event.
pub struct SyncHandle(pub Mutex<SyncStatus>);

// ── Talking to the cloud ──

#[derive(Debug, PartialEq)]
pub enum SyncError {
    /// No connection to the server (no internet, DNS, timeout).
    Offline(String),
    /// The server answered with an error.
    Server(String),
    Local(String),
}

impl From<rusqlite::Error> for SyncError {
    fn from(e: rusqlite::Error) -> Self {
        SyncError::Local(e.to_string())
    }
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

/// Calls a Postgres function through Supabase's REST API.
async fn rpc(client: &reqwest::Client, cfg: &SyncConfig, name: &str, body: Value) -> Result<Value, SyncError> {
    let url = format!("{}/rest/v1/rpc/{name}", cfg.url.trim_end_matches('/'));
    let res = client
        .post(url)
        .header("apikey", &cfg.key)
        .bearer_auth(&cfg.key)
        .json(&body)
        .send()
        .await
        .map_err(|e| if e.is_connect() || e.is_timeout() { SyncError::Offline(e.to_string()) } else { SyncError::Server(e.to_string()) })?;
    let status = res.status();
    let text = res.text().await.map_err(|e| SyncError::Offline(e.to_string()))?;
    if !status.is_success() {
        // PostgREST errors look like {"message": "...", "hint": ...}.
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("message").and_then(Value::as_str).map(String::from))
            .unwrap_or(text);
        return Err(SyncError::Server(format!("{} ({})", message, status.as_u16())));
    }
    serde_json::from_str(&text).map_err(|e| SyncError::Server(format!("رد غير مفهوم من الخادم: {e}")))
}

#[derive(Deserialize, Debug, Default)]
struct PushResult {
    #[serde(default)]
    failed: Vec<Failed>,
}

#[derive(Deserialize, Debug)]
struct Failed {
    id: String,
    error: String,
}

fn lock(db: &Mutex<Connection>) -> std::sync::MutexGuard<'_, Connection> {
    db.lock().unwrap_or_else(|e| e.into_inner())
}

/// One sync round: push the whole outbox (in order, in batches), then pull the catalog and stock. `full` pulls
/// everything instead of the changes since the last pull. `report` is told when pushing starts.
pub async fn sync_once(
    db: &Mutex<Connection>,
    client: &reqwest::Client,
    full: bool,
    report: &(dyn Fn(SyncStatus) + Sync),
) -> Result<(), SyncError> {
    let cfg = load_config(&lock(db))?;
    if !cfg.ready() {
        return Ok(());
    }
    let device = json!({ "id": cfg.device_id, "name": cfg.device_name });
    // Rejected in this round: tried again next round, not straight away.
    let mut rejected: Vec<String> = vec![];
    loop {
        let batch: Vec<(String, String, String)> = {
            let conn = lock(db);
            let mut stmt = conn.prepare(
                "SELECT id, kind, payload FROM sync_queue
                 WHERE sent_at IS NULL AND attempts < ?1 AND id NOT IN (SELECT value FROM json_each(?3))
                 ORDER BY seq LIMIT ?2",
            )?;
            let skip = serde_json::to_string(&rejected).unwrap_or_default();
            let rows = stmt.query_map(params![MAX_ATTEMPTS, PUSH_BATCH, skip], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            let batch: Vec<(String, String, String)> = rows.collect::<rusqlite::Result<_>>()?;
            if !batch.is_empty() {
                report(status_with(&conn, SyncState::Syncing, None)?);
            }
            batch
        };
        if batch.is_empty() {
            break;
        }
        let entries: Vec<Value> = batch
            .iter()
            .map(|(id, kind, payload)| {
                json!({ "id": id, "kind": kind, "payload": serde_json::from_str::<Value>(payload).unwrap_or(Value::Null) })
            })
            .collect();
        let res = rpc(client, &cfg, "pos_sync_push", json!({ "p_secret": cfg.secret, "p_device": device, "p_entries": entries })).await?;
        let res: PushResult = serde_json::from_value(res).unwrap_or_default();
        let mut conn = lock(db);
        let tx = conn.transaction()?;
        for (id, _, _) in &batch {
            match res.failed.iter().find(|f| &f.id == id) {
                Some(f) => {
                    rejected.push(id.clone());
                    tx.execute("UPDATE sync_queue SET attempts = attempts + 1, last_error = ?2 WHERE id = ?1", params![id, f.error])?
                }
                None => tx.execute(
                    "UPDATE sync_queue SET sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_error = NULL WHERE id = ?1",
                    [id],
                )?,
            };
        }
        tx.commit()?;
    }

    let since = if full { 0 } else { (setting(&lock(db), "sync_cursor")?.parse::<i64>().unwrap_or(0) - PULL_OVERLAP).max(0) };
    let res = rpc(client, &cfg, "pos_sync_pull", json!({ "p_secret": cfg.secret, "p_since": since })).await?;
    let pull: Pull = serde_json::from_value(res).map_err(|e| SyncError::Server(format!("رد غير مفهوم من الخادم: {e}")))?;
    let mut conn = lock(db);
    apply_pull(&mut conn, &pull)?;
    conn.execute(
        "UPDATE settings SET value = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE key = 'sync_last_at'",
        [],
    )?;
    // Sent entries are kept a week for troubleshooting.
    conn.execute(
        "DELETE FROM sync_queue WHERE sent_at IS NOT NULL AND sent_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')",
        [],
    )?;
    Ok(())
}

/// The background worker: syncs at start, whenever something is queued, and every 30 seconds; while offline it
/// retries with a growing pause (5 s up to a minute). Each status change goes to `publish`.
pub fn start(app: tauri::AppHandle, publish: impl Fn(SyncStatus) + Send + Sync + 'static) {
    use tauri::Manager;
    tauri::async_runtime::spawn(async move {
        let client = client();
        let mut full = true; // the first pull after starting reads everything
        let mut backoff = 5;
        loop {
            let db = app.state::<crate::Db>();
            let ready = load_config(&lock(&db.0)).map(|c| c.ready()).unwrap_or(false);
            let (state, error, delay) = if !ready {
                full = true;
                (SyncState::Disabled, None, 30)
            } else {
                match sync_once(&db.0, &client, full, &publish).await {
                    Ok(()) => {
                        full = false;
                        backoff = 5;
                        (SyncState::Synced, None, 30)
                    }
                    Err(SyncError::Offline(_)) => {
                        let wait = backoff;
                        backoff = (backoff * 2).min(60);
                        (SyncState::Offline, None, wait)
                    }
                    Err(SyncError::Server(e) | SyncError::Local(e)) => (SyncState::Error, Some(e), 60),
                }
            };
            let status = {
                let conn = lock(&db.0);
                let mut s = status_with(&conn, state, error);
                if let Ok(s) = &mut s {
                    // Rejected entries keep the badge from saying everything is synced.
                    if s.state == SyncState::Synced && s.failed > 0 {
                        s.state = SyncState::Error;
                        s.last_error = conn
                            .query_row(
                                "SELECT last_error FROM sync_queue WHERE sent_at IS NULL AND attempts >= ?1 ORDER BY seq LIMIT 1",
                                [MAX_ATTEMPTS],
                                |r| r.get(0),
                            )
                            .optional()
                            .ok()
                            .flatten();
                    }
                }
                s
            };
            if let Ok(s) = status {
                publish(s);
            }
            tokio::select! {
                _ = wake_signal().notified() => {}
                _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
            }
        }
    });
}
