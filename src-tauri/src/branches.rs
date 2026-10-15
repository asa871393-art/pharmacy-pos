//! Branches, this device's place among them, and stock transfers between branches.
//! A device works for one branch at a time (settings 'branch_id'); only an admin signing in can move it to another.
//! Transfers: the receiving branch may request stock, the sending branch ships it (stock leaves its batches at once,
//! as transfer_out movements), and the receiving branch receives it into its own batches (transfer_in movements).
//! Every step is one transaction with its audit entry and outbox entry, so it works offline and syncs later.

use super::{
    active_branch, active_role, append_audit, branch_code, device_id, device_tag, err, new_id, next_counter, require_admin,
    require_permission, session_user, sync, utc_now, Db, Session,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchDto {
    pub id: String,
    pub code: String,
    pub name: String,
    pub address: Option<String>,
    pub phone: Option<String>,
    pub active: bool,
}

const BRANCH_SELECT: &str = "SELECT id, code, name, address, phone, is_active FROM branches";

fn map_branch(r: &rusqlite::Row) -> rusqlite::Result<BranchDto> {
    Ok(BranchDto {
        id: r.get(0)?,
        code: r.get(1)?,
        name: r.get(2)?,
        address: r.get(3)?,
        phone: r.get(4)?,
        active: r.get::<_, i64>(5)? != 0,
    })
}

pub fn list_branches(conn: &Connection) -> Result<Vec<BranchDto>, String> {
    let mut stmt = conn.prepare(&format!("{BRANCH_SELECT} ORDER BY created_at, id")).map_err(err)?;
    let rows = stmt.query_map([], map_branch).map_err(err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
}

fn branch(conn: &Connection, id: &str) -> Result<Option<BranchDto>, String> {
    conn.query_row(&format!("{BRANCH_SELECT} WHERE id = ?1"), params![id], map_branch).optional().map_err(err)
}

/// What the top bar and the sign-in screen show: this device and its branch, and the branches to choose from.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub(crate) device_id: String,
    /// Short form of the device id, also used in invoice and transfer numbers.
    pub(crate) device_tag: String,
    pub(crate) device_name: String,
    pub(crate) branch: BranchDto,
    pub(crate) branches: Vec<BranchDto>,
}

pub fn device_info_inner(conn: &Connection) -> Result<DeviceInfo, String> {
    let id = active_branch(conn)?;
    Ok(DeviceInfo {
        device_id: device_id(conn)?,
        device_tag: device_tag(conn)?,
        device_name: super::setting(conn, "sync_device_name")?,
        branch: branch(conn, &id)?.ok_or("الفرع غير موجود")?,
        branches: list_branches(conn)?,
    })
}

/// Open to everyone, signed in or not: the sign-in screen offers the branch choice.
#[tauri::command]
pub fn device_info(db: State<'_, Db>) -> Result<DeviceInfo, String> {
    let conn = db.0.lock().map_err(err)?;
    device_info_inner(&conn)
}

/// Moves this device to another branch, at sign-in. Admin only; a no-op when it is already there.
pub fn set_device_branch(tx: &Connection, user_id: &str, branch_id: &str) -> Result<(), String> {
    let current = active_branch(tx)?;
    if current == branch_id {
        return Ok(());
    }
    if active_role(tx, user_id)? != "admin" {
        return Err("تغيير فرع هذا الجهاز للمدير فقط".into());
    }
    let to = branch(tx, branch_id)?.filter(|b| b.active).ok_or("الفرع غير موجود أو موقوف")?;
    tx.execute(
        "INSERT INTO settings(key, value) VALUES ('branch_id', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![branch_id],
    )
    .map_err(err)?;
    let from = branch(tx, &current)?.map(|b| b.name);
    let payload = json!({ "from": from, "to": to.name, "deviceId": device_id(tx)? }).to_string();
    append_audit(tx, user_id, "device.branch", "branches", branch_id, &payload, &utc_now(tx)?).map_err(err)
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BranchIn {
    /// None adds a branch.
    pub id: Option<String>,
    pub code: String,
    pub name: String,
    pub address: Option<String>,
    pub phone: Option<String>,
    pub active: bool,
}

fn trimmed(s: &Option<String>) -> Option<String> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

pub fn save_branch_inner(conn: &mut Connection, user_id: &str, b: BranchIn) -> Result<BranchDto, String> {
    let tx = conn.transaction().map_err(err)?;
    require_admin(&tx, user_id)?;
    let code = b.code.trim().to_uppercase();
    let name = b.name.trim();
    if !(1..=6).contains(&code.len()) || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("رمز الفرع من ١ إلى ٦ أحرف إنجليزية أو أرقام".into());
    }
    if name.is_empty() || name.chars().count() > 60 {
        return Err("اسم الفرع مطلوب (حتى ٦٠ حرفاً)".into());
    }
    let (address, phone) = (trimmed(&b.address), trimmed(&b.phone));
    if address.as_ref().is_some_and(|a| a.chars().count() > 120) || phone.as_ref().is_some_and(|p| p.chars().count() > 40) {
        return Err("العنوان أو الهاتف طويل جداً".into());
    }
    let taken: bool = tx
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM branches WHERE code = ?1 AND (?2 IS NULL OR id != ?2))",
            params![code, b.id],
            |r| r.get(0),
        )
        .map_err(err)?;
    if taken {
        return Err(format!("الرمز {code} مستخدم لفرع آخر"));
    }
    let now = utc_now(&tx)?;
    let (id, before) = match &b.id {
        Some(id) => {
            let before = branch(&tx, id)?.ok_or("الفرع غير موجود")?;
            if !b.active && *id == active_branch(&tx)? {
                return Err("لا يمكن إيقاف الفرع الذي يعمل عليه هذا الجهاز".into());
            }
            tx.execute(
                "UPDATE branches SET code = ?1, name = ?2, address = ?3, phone = ?4, is_active = ?5 WHERE id = ?6",
                params![code, name, address, phone, b.active, id],
            )
            .map_err(err)?;
            (id.clone(), Some(before))
        }
        None => {
            let id = new_id();
            tx.execute(
                "INSERT INTO branches(id, code, name, address, phone, is_active, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, code, name, address, phone, b.active, now],
            )
            .map_err(err)?;
            (id, None)
        }
    };
    let after = branch(&tx, &id)?.ok_or("الفرع غير موجود")?;
    if before.as_ref() == Some(&after) {
        return Ok(after);
    }
    let action = if before.is_some() { "branch.update" } else { "branch.create" };
    let payload = json!({ "from": before, "to": after }).to_string();
    append_audit(&tx, user_id, action, "branches", &id, &payload, &now).map_err(err)?;
    sync::enqueue(&tx, "UPSERT_BRANCH", &sync::branch_payload(&tx, &id).map_err(err)?).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(after)
}

#[tauri::command]
pub fn save_branch(db: State<'_, Db>, session: State<'_, Session>, branch: BranchIn) -> Result<BranchDto, String> {
    let user_id = session_user(&session)?;
    let mut conn = db.0.lock().map_err(err)?;
    save_branch_inner(&mut conn, &user_id, branch)
}

// ── Transfers ──

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferItemDto {
    pub(crate) product_id: String,
    pub(crate) product: String,
    pub(crate) requested_qty: i64,
    pub(crate) qty: i64,
    pub(crate) batch_no: Option<String>,
    pub(crate) expiry_date: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferDto {
    pub(crate) id: String,
    pub(crate) transfer_no: String,
    pub(crate) from_branch_id: String,
    pub(crate) from_branch: String,
    pub(crate) to_branch_id: String,
    pub(crate) to_branch: String,
    /// requested, shipped, received or cancelled.
    pub(crate) status: String,
    /// "out" when this device's branch sends, "in" when it receives.
    pub(crate) direction: String,
    pub(crate) note: Option<String>,
    pub(crate) requested_by: Option<String>,
    pub(crate) requested_at: Option<String>,
    pub(crate) shipped_by: Option<String>,
    pub(crate) shipped_at: Option<String>,
    pub(crate) received_by: Option<String>,
    pub(crate) received_at: Option<String>,
    /// Units shipped (requested units while only requested).
    pub(crate) units: i64,
    pub(crate) items: Vec<TransferItemDto>,
}

fn transfer_dto(conn: &Connection, id: &str, here: &str) -> Result<TransferDto, String> {
    let mut stmt = conn
        .prepare(
            "SELECT i.product_id, p.trade_name, i.requested_qty, i.qty, i.batch_no, i.expiry_date
             FROM stock_transfer_items i JOIN products p ON p.id = i.product_id
             WHERE i.transfer_id = ?1 ORDER BY p.trade_name, i.expiry_date",
        )
        .map_err(err)?;
    let items = stmt
        .query_map(params![id], |r| {
            Ok(TransferItemDto {
                product_id: r.get(0)?,
                product: r.get(1)?,
                requested_qty: r.get(2)?,
                qty: r.get(3)?,
                batch_no: r.get(4)?,
                expiry_date: r.get(5)?,
            })
        })
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)?;
    let shipped: i64 = items.iter().map(|i| i.qty).sum();
    let requested: i64 = items.iter().map(|i| i.requested_qty).sum();
    conn.query_row(
        "SELECT t.id, t.transfer_no, t.from_branch_id, f.name, t.to_branch_id, d.name, t.status, t.note,
                t.requested_by, datetime(t.requested_at, 'localtime'), t.shipped_by, datetime(t.shipped_at, 'localtime'),
                t.received_by, datetime(t.received_at, 'localtime')
         FROM stock_transfers t JOIN branches f ON f.id = t.from_branch_id JOIN branches d ON d.id = t.to_branch_id
         WHERE t.id = ?1",
        params![id],
        |r| {
            let from: String = r.get(2)?;
            Ok(TransferDto {
                id: r.get(0)?,
                transfer_no: r.get(1)?,
                direction: if from == here { "out" } else { "in" }.into(),
                from_branch_id: from,
                from_branch: r.get(3)?,
                to_branch_id: r.get(4)?,
                to_branch: r.get(5)?,
                status: r.get(6)?,
                note: r.get(7)?,
                requested_by: r.get(8)?,
                requested_at: r.get(9)?,
                shipped_by: r.get(10)?,
                shipped_at: r.get(11)?,
                received_by: r.get(12)?,
                received_at: r.get(13)?,
                units: if shipped > 0 { shipped } else { requested },
                items: vec![],
            })
        },
    )
    .map_err(err)
    .map(|t| TransferDto { items, ..t })
}

/// Transfers into or out of this device's branch, open ones first, then the newest.
pub fn list_transfers_inner(conn: &Connection) -> Result<Vec<TransferDto>, String> {
    let here = active_branch(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT id FROM stock_transfers WHERE from_branch_id = ?1 OR to_branch_id = ?1
             ORDER BY status IN ('received', 'cancelled'), created_at DESC LIMIT 200",
        )
        .map_err(err)?;
    let ids = stmt
        .query_map(params![here], |r| r.get::<_, String>(0))
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)?;
    ids.iter().map(|id| transfer_dto(conn, id, &here)).collect()
}

#[tauri::command]
pub fn list_transfers(db: State<'_, Db>, session: State<'_, Session>) -> Result<Vec<TransferDto>, String> {
    let user_id = session_user(&session)?;
    let conn = db.0.lock().map_err(err)?;
    require_permission(&conn, &user_id, &["modify_inventory"])?;
    list_transfers_inner(&conn)
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferLineIn {
    pub product_id: String,
    pub qty: i64,
}

/// Validates lines: at least one, positive quantities, active products, each product once. Returns (line, name).
fn check_lines(tx: &Connection, lines: &[TransferLineIn]) -> Result<Vec<(TransferLineIn, String)>, String> {
    if lines.is_empty() {
        return Err("أضف صنفاً واحداً على الأقل".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut out = vec![];
    for l in lines {
        let name: String = tx
            .query_row("SELECT trade_name FROM products WHERE id = ?1 AND is_active = 1", params![l.product_id], |r| r.get(0))
            .optional()
            .map_err(err)?
            .ok_or("صنف غير موجود أو موقوف")?;
        if l.qty <= 0 {
            return Err(format!("{name}: الكمية يجب أن تكون أكبر من صفر"));
        }
        if !seen.insert(l.product_id.as_str()) {
            return Err(format!("{name} مكرر، اجمع الكمية في سطر واحد"));
        }
        out.push((l.clone(), name));
    }
    Ok(out)
}

fn full_name(tx: &Connection, user_id: &str) -> Result<String, String> {
    tx.query_row("SELECT full_name FROM users WHERE id = ?1", params![user_id], |r| r.get(0)).map_err(err)
}

/// Checks that `other` is an active branch other than this device's.
fn other_branch(tx: &Connection, here: &str, other: &str) -> Result<BranchDto, String> {
    if other == here {
        return Err("اختر فرعاً غير فرع هذا الجهاز".into());
    }
    branch(tx, other)?.filter(|b| b.active).ok_or_else(|| "الفرع غير موجود أو موقوف".to_string())
}

fn create_transfer(tx: &Connection, from: &str, to: &str, status: &str, note: Option<String>, now: &str) -> Result<String, String> {
    let id = new_id();
    let counter = next_counter(tx, "transfer_counter")?;
    // TR-<sending branch><device tag>-<counter>, e.g. TR-MB7F3A-00012: unique across devices.
    let transfer_no = format!("TR-{}{}-{counter:05}", branch_code(tx, from)?, device_tag(tx)?);
    tx.execute(
        "INSERT INTO stock_transfers(id, transfer_no, from_branch_id, to_branch_id, status, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, transfer_no, from, to, status, note, now],
    )
    .map_err(err)?;
    Ok(id)
}

fn finish(tx: rusqlite::Transaction, user_id: &str, action: &str, id: &str, payload: serde_json::Value, now: &str) -> Result<TransferDto, String> {
    append_audit(&tx, user_id, action, "stock_transfers", id, &payload.to_string(), now).map_err(err)?;
    sync::enqueue(&tx, "TRANSFER", &sync::transfer_payload(&tx, id).map_err(err)?).map_err(err)?;
    let dto = transfer_dto(&tx, id, &active_branch(&tx)?)?;
    tx.commit().map_err(err)?;
    Ok(dto)
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequestIn {
    /// The branch asked to send; this device's branch receives.
    pub from_branch_id: String,
    pub note: Option<String>,
    pub lines: Vec<TransferLineIn>,
}

/// This branch asks another for stock. Nothing moves until the other branch ships.
pub fn request_transfer_inner(conn: &mut Connection, user_id: &str, req: TransferRequestIn) -> Result<TransferDto, String> {
    let tx = conn.transaction().map_err(err)?;
    require_permission(&tx, user_id, &["modify_inventory"])?;
    let here = active_branch(&tx)?;
    let from = other_branch(&tx, &here, &req.from_branch_id)?;
    let lines = check_lines(&tx, &req.lines)?;
    let now = utc_now(&tx)?;
    let id = create_transfer(&tx, &from.id, &here, "requested", trimmed(&req.note), &now)?;
    tx.execute(
        "UPDATE stock_transfers SET requested_by = ?1, requested_at = ?2 WHERE id = ?3",
        params![full_name(&tx, user_id)?, now, id],
    )
    .map_err(err)?;
    for (l, _) in &lines {
        tx.execute(
            "INSERT INTO stock_transfer_items(id, transfer_id, product_id, requested_qty) VALUES (?1, ?2, ?3, ?4)",
            params![new_id(), id, l.product_id, l.qty],
        )
        .map_err(err)?;
    }
    let summary: Vec<_> = lines.iter().map(|(l, name)| json!({ "product": name, "qty": l.qty })).collect();
    finish(tx, user_id, "transfer.request", &id, json!({ "from": from.name, "lines": summary }), &now)
}

#[tauri::command]
pub fn request_transfer(db: State<'_, Db>, session: State<'_, Session>, request: TransferRequestIn) -> Result<TransferDto, String> {
    let user_id = session_user(&session)?;
    let mut conn = db.0.lock().map_err(err)?;
    request_transfer_inner(&mut conn, &user_id, request)
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferShipIn {
    /// A request addressed to this branch, or None for a new transfer to `to_branch_id`.
    pub transfer_id: Option<String>,
    pub to_branch_id: Option<String>,
    pub note: Option<String>,
    pub lines: Vec<TransferLineIn>,
}

/// Sends stock from this device's branch: each line is taken from sellable batches in FEFO order (earliest expiry
/// first), one transfer_out movement per batch. The stock leaves the sender at once and reaches the receiver when it
/// receives.
pub fn ship_transfer_inner(conn: &mut Connection, user_id: &str, ship: TransferShipIn) -> Result<TransferDto, String> {
    let tx = conn.transaction().map_err(err)?;
    require_permission(&tx, user_id, &["modify_inventory"])?;
    let here = active_branch(&tx)?;
    let lines = check_lines(&tx, &ship.lines)?;
    let now = utc_now(&tx)?;
    let note = trimmed(&ship.note);
    let (id, to) = match &ship.transfer_id {
        Some(id) => {
            let (status, from, to): (String, String, String) = tx
                .query_row("SELECT status, from_branch_id, to_branch_id FROM stock_transfers WHERE id = ?1", params![id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
                .optional()
                .map_err(err)?
                .ok_or("التحويل غير موجود")?;
            if from != here {
                return Err("هذا الطلب موجّه إلى فرع آخر".into());
            }
            if status != "requested" {
                return Err("هذا الطلب لم يعد بانتظار الشحن".into());
            }
            if note.is_some() {
                tx.execute("UPDATE stock_transfers SET note = ?1 WHERE id = ?2", params![note, id]).map_err(err)?;
            }
            (id.clone(), branch(&tx, &to)?.ok_or("الفرع غير موجود")?)
        }
        None => {
            let to = other_branch(&tx, &here, ship.to_branch_id.as_deref().ok_or("اختر الفرع المستلم")?)?;
            (create_transfer(&tx, &here, &to.id, "shipped", note, &now)?, to)
        }
    };

    let mut summary = vec![];
    for (l, name) in &lines {
        let mut stmt = tx
            .prepare(
                "SELECT id, batch_no, expiry_date, qty_on_hand, unit_cost, sell_price FROM batches
                 WHERE product_id = ?1 AND branch_id = ?2 AND status = 'active' AND qty_on_hand > 0
                   AND expiry_date > date('now', 'localtime')
                 ORDER BY expiry_date, received_at",
            )
            .map_err(err)?;
        type Row = (String, String, String, i64, i64, i64);
        let batches: Vec<Row> = stmt
            .query_map(params![l.product_id, here], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
            .map_err(err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(err)?;
        drop(stmt);
        let available: i64 = batches.iter().map(|b| b.3).sum();
        if available < l.qty {
            return Err(format!("{name}: المتوفر للتحويل {available} فقط"));
        }
        let mut left = l.qty;
        for (batch_id, batch_no, expiry, on_hand, cost, price) in batches {
            if left == 0 {
                break;
            }
            let take = left.min(on_hand);
            left -= take;
            tx.execute("UPDATE batches SET qty_on_hand = qty_on_hand - ?1 WHERE id = ?2", params![take, batch_id])
                .map_err(err)?;
            tx.execute(
                "INSERT INTO stock_movements(id, batch_id, type, qty, unit_cost, ref_type, ref_id, user_id, occurred_at)
                 VALUES (?1, ?2, 'transfer_out', ?3, ?4, 'transfer', ?5, ?6, ?7)",
                params![new_id(), batch_id, -take, cost, id, user_id, now],
            )
            .map_err(err)?;
            tx.execute(
                "INSERT INTO stock_transfer_items(id, transfer_id, product_id, qty, from_batch_id, batch_no, expiry_date,
                                                  unit_cost, sell_price)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![new_id(), id, l.product_id, take, batch_id, batch_no, expiry, cost, price],
            )
            .map_err(err)?;
            summary.push(json!({ "product": name, "batchNo": batch_no, "qty": take }));
        }
    }
    tx.execute(
        "UPDATE stock_transfers SET status = 'shipped', shipped_by = ?1, shipped_at = ?2 WHERE id = ?3",
        params![full_name(&tx, user_id)?, now, id],
    )
    .map_err(err)?;
    finish(tx, user_id, "transfer.ship", &id, json!({ "to": to.name, "lines": summary }), &now)
}

#[tauri::command]
pub fn ship_transfer(db: State<'_, Db>, session: State<'_, Session>, shipment: TransferShipIn) -> Result<TransferDto, String> {
    let user_id = session_user(&session)?;
    let mut conn = db.0.lock().map_err(err)?;
    ship_transfer_inner(&mut conn, &user_id, shipment)
}

/// Puts a shipped transfer on this branch's shelf: each line tops up this branch's batch with the same number (weighted
/// cost) or becomes a new batch with the sender's expiry, cost and price; one transfer_in movement per line.
pub fn receive_transfer_inner(conn: &mut Connection, user_id: &str, transfer_id: &str) -> Result<TransferDto, String> {
    let tx = conn.transaction().map_err(err)?;
    require_permission(&tx, user_id, &["modify_inventory"])?;
    let here = active_branch(&tx)?;
    let (status, to, from_name): (String, String, String) = tx
        .query_row(
            "SELECT t.status, t.to_branch_id, f.name FROM stock_transfers t JOIN branches f ON f.id = t.from_branch_id
             WHERE t.id = ?1",
            params![transfer_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(err)?
        .ok_or("التحويل غير موجود")?;
    if to != here {
        return Err("يُستلم التحويل في الفرع المرسَل إليه".into());
    }
    match status.as_str() {
        "shipped" => {}
        "requested" => return Err("لم يُشحن التحويل بعد".into()),
        _ => return Err("التحويل مستلم أو ملغى مسبقاً".into()),
    }
    let now = utc_now(&tx)?;
    let mut stmt = tx
        .prepare(
            "SELECT i.id, i.product_id, p.trade_name, i.qty, i.batch_no, i.expiry_date, i.unit_cost, i.sell_price
             FROM stock_transfer_items i JOIN products p ON p.id = i.product_id
             WHERE i.transfer_id = ?1 AND i.qty > 0 ORDER BY i.id",
        )
        .map_err(err)?;
    type Line = (String, String, String, i64, String, String, i64, i64);
    let lines: Vec<Line> = stmt
        .query_map(params![transfer_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))
        })
        .map_err(err)?
        .collect::<rusqlite::Result<_>>()
        .map_err(err)?;
    drop(stmt);
    if lines.is_empty() {
        return Err("التحويل لا يحمل أي كمية".into());
    }
    let mut summary = vec![];
    for (item_id, product_id, name, qty, batch_no, expiry, cost, price) in lines {
        let existing: Option<(String, String, String, i64, i64)> = tx
            .query_row(
                "SELECT id, expiry_date, status, qty_on_hand, unit_cost FROM batches
                 WHERE product_id = ?1 AND branch_id = ?2 AND batch_no = ?3",
                params![product_id, here, batch_no],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
            .map_err(err)?;
        let batch_id = match existing {
            Some((id, have_expiry, status, old_qty, old_cost)) if have_expiry == expiry && status == "active" => {
                let total = old_qty + qty;
                let new_cost = (old_qty * old_cost + qty * cost + total / 2) / total;
                tx.execute(
                    "UPDATE batches SET qty_on_hand = ?1, unit_cost = ?2 WHERE id = ?3",
                    params![total, new_cost, id],
                )
                .map_err(err)?;
                id
            }
            // New here; or the number is taken by a batch with another expiry (or a stopped one), which must not be
            // mixed with this stock: it gets its own batch, "<number>-TR".
            clash => {
                let mut no = batch_no.clone();
                if clash.is_some() {
                    no = format!("{batch_no}-TR");
                    let mut n = 1;
                    while tx
                        .query_row(
                            "SELECT EXISTS (SELECT 1 FROM batches WHERE product_id = ?1 AND branch_id = ?2 AND batch_no = ?3)",
                            params![product_id, here, no],
                            |r| r.get::<_, bool>(0),
                        )
                        .map_err(err)?
                    {
                        n += 1;
                        no = format!("{batch_no}-TR{n}");
                    }
                }
                let id = new_id();
                tx.execute(
                    "INSERT INTO batches(id, product_id, branch_id, batch_no, expiry_date, unit_cost, sell_price, qty_on_hand,
                                         received_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![id, product_id, here, no, expiry, cost, price, qty, now],
                )
                .map_err(err)?;
                id
            }
        };
        tx.execute(
            "INSERT INTO stock_movements(id, batch_id, type, qty, unit_cost, ref_type, ref_id, user_id, occurred_at)
             VALUES (?1, ?2, 'transfer_in', ?3, ?4, 'transfer', ?5, ?6, ?7)",
            params![new_id(), batch_id, qty, cost, transfer_id, user_id, now],
        )
        .map_err(err)?;
        tx.execute("UPDATE stock_transfer_items SET to_batch_id = ?1 WHERE id = ?2", params![batch_id, item_id])
            .map_err(err)?;
        summary.push(json!({ "product": name, "batchNo": batch_no, "qty": qty }));
    }
    tx.execute(
        "UPDATE stock_transfers SET status = 'received', received_by = ?1, received_at = ?2 WHERE id = ?3",
        params![full_name(&tx, user_id)?, now, transfer_id],
    )
    .map_err(err)?;
    finish(tx, user_id, "transfer.receive", transfer_id, json!({ "from": from_name, "lines": summary }), &now)
}

#[tauri::command]
pub fn receive_transfer(db: State<'_, Db>, session: State<'_, Session>, transfer_id: String) -> Result<TransferDto, String> {
    let user_id = session_user(&session)?;
    let mut conn = db.0.lock().map_err(err)?;
    receive_transfer_inner(&mut conn, &user_id, &transfer_id)
}

/// Withdraws a request (the branch that asked) or declines it (the branch asked). Shipped stock cannot be cancelled:
/// the receiver receives it, and can send it back with a new transfer.
pub fn cancel_transfer_inner(conn: &mut Connection, user_id: &str, transfer_id: &str) -> Result<TransferDto, String> {
    let tx = conn.transaction().map_err(err)?;
    require_permission(&tx, user_id, &["modify_inventory"])?;
    let here = active_branch(&tx)?;
    let (status, from, to): (String, String, String) = tx
        .query_row("SELECT status, from_branch_id, to_branch_id FROM stock_transfers WHERE id = ?1", params![transfer_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()
        .map_err(err)?
        .ok_or("التحويل غير موجود")?;
    if here != from && here != to {
        return Err("التحويل لا يخص هذا الفرع".into());
    }
    if status != "requested" {
        return Err("لا يُلغى إلا طلب لم يُشحن بعد".into());
    }
    let now = utc_now(&tx)?;
    tx.execute("UPDATE stock_transfers SET status = 'cancelled' WHERE id = ?1", params![transfer_id]).map_err(err)?;
    finish(tx, user_id, "transfer.cancel", transfer_id, json!({ "from": "requested", "to": "cancelled" }), &now)
}

#[tauri::command]
pub fn cancel_transfer(db: State<'_, Db>, session: State<'_, Session>, transfer_id: String) -> Result<TransferDto, String> {
    let user_id = session_user(&session)?;
    let mut conn = db.0.lock().map_err(err)?;
    cancel_transfer_inner(&mut conn, &user_id, &transfer_id)
}
