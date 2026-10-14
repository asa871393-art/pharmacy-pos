//! Phone barcode scanner: a small HTTPS server on the shop Wi-Fi.
//!
//! The POS shows a QR code for `https://<this-pc>:8080/scan?t=<token>`. The phone opens it, scans with its camera
//! (html5-qrcode, bundled here, so no internet is needed) and POSTs each code to `/api/scan`. The code is emitted to
//! the window as the `phone-barcode-scanned` event and the POS adds it to the cart like a USB scanner would.
//!
//! - HTTPS because phone browsers only allow the camera on secure pages. The self-signed certificate is created on
//!   first run and kept in the app data folder, so each phone accepts it once.
//! - Every API call must carry the token from the QR code. It is new on each start of the app; without it nobody
//!   else on the Wi-Fi can push items into the till.
//! - Each scan is a separate request and the page queues and retries, so a phone that sleeps, loses Wi-Fi or
//!   reloads just carries on.

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const PORT: u16 = 8080;
pub const EVENT: &str = "phone-barcode-scanned";

const PAGE: &str = include_str!("../assets/scan.html");
const LIBRARY: &str = include_str!("../assets/html5-qrcode.min.js");
const MAX_CODE_LEN: usize = 200;

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanEvent {
    pub code: String,
    pub device: String,
}

/// Where scans go: the Tauri window in the app, a Vec in tests.
pub type Sink = Arc<dyn Fn(ScanEvent) + Send + Sync>;

#[derive(Clone, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub error: Option<String>,
}

pub struct Scanner {
    token: String,
    sink: Sink,
    /// Device id → when it last called in.
    devices: Mutex<HashMap<String, Instant>>,
    pub status: Mutex<ServerStatus>,
}

impl Scanner {
    pub fn new(token: String, sink: Sink) -> Self {
        Scanner { token, sink, devices: Mutex::new(HashMap::new()), status: Mutex::new(ServerStatus::default()) }
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// Devices heard from within `within`, most recent first, with seconds since.
    pub fn connected(&self, within: Duration) -> Vec<(String, u64)> {
        let devices = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<(String, u64)> = devices
            .iter()
            .filter(|(_, at)| at.elapsed() <= within)
            .map(|(d, at)| (d.clone(), at.elapsed().as_secs()))
            .collect();
        out.sort_by_key(|(_, s)| *s);
        out
    }

    fn seen(&self, device: &str) {
        let mut devices = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        devices.insert(device.to_string(), Instant::now());
        // A forgotten phone should not stay listed forever.
        devices.retain(|_, at| at.elapsed() < Duration::from_secs(3600));
    }

    fn authorized(&self, headers: &HeaderMap) -> bool {
        let given = headers.get("x-scanner-token").and_then(|v| v.to_str().ok()).unwrap_or("");
        same_secret(&self.token, given)
    }
}

/// Compares without stopping at the first difference, so timing reveals nothing about the token.
fn same_secret(expected: &str, given: &str) -> bool {
    let (a, b) = (expected.as_bytes(), given.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A barcode as the till expects it: trimmed, printable ASCII plus the GS1 group separator (DataMatrix), ≤ 200.
pub fn clean_code(raw: &str) -> Option<String> {
    let code = raw.trim_matches(|c: char| c.is_whitespace());
    let ok = !code.is_empty()
        && code.len() <= MAX_CODE_LEN
        && code.chars().all(|c| matches!(c, '\u{20}'..='\u{7e}' | '\u{1d}'));
    ok.then(|| code.to_string())
}

fn clean_device(raw: Option<&str>) -> String {
    let d: String = raw.unwrap_or("").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect();
    if d.is_empty() {
        "phone".into()
    } else {
        d
    }
}

#[derive(Deserialize)]
struct ScanIn {
    code: String,
    device: Option<String>,
}

#[derive(Deserialize)]
struct PingIn {
    device: Option<String>,
}

fn no_store(mut r: Response) -> Response {
    r.headers_mut().insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    r
}

async fn page() -> Response {
    no_store(Html(PAGE).into_response())
}

async fn library() -> Response {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8"), (header::CACHE_CONTROL, "max-age=86400")],
        LIBRARY,
    )
        .into_response()
}

async fn ping(State(s): State<Arc<Scanner>>, headers: HeaderMap, Query(q): Query<PingIn>) -> Response {
    if !s.authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    s.seen(&clean_device(q.device.as_deref()));
    no_store(StatusCode::NO_CONTENT.into_response())
}

async fn scan(State(s): State<Arc<Scanner>>, headers: HeaderMap, Json(body): Json<ScanIn>) -> Response {
    if !s.authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let device = clean_device(body.device.as_deref());
    s.seen(&device);
    let Some(code) = clean_code(&body.code) else {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "ok": false, "error": "باركود غير صالح" })))
            .into_response();
    };
    (s.sink)(ScanEvent { code, device });
    no_store(Json(serde_json::json!({ "ok": true })).into_response())
}

pub fn router(state: Arc<Scanner>) -> Router {
    Router::new()
        .route("/scan", get(page))
        .route("/scan/html5-qrcode.min.js", get(library))
        .route("/api/ping", get(ping))
        .route("/api/scan", post(scan))
        .with_state(state)
}

// ── Addresses and certificate ──

/// The computer's address on the local network, as phones on the same Wi-Fi reach it.
pub fn local_ip() -> Result<IpAddr, String> {
    local_ip_address::local_ip().map_err(|e| format!("تعذّر معرفة عنوان الجهاز على الشبكة: {e}"))
}

/// Every private IPv4 address of this computer (Wi-Fi, Ethernet), for the certificate.
fn private_ips() -> Vec<IpAddr> {
    let mut ips: Vec<IpAddr> = local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .map(|(_, ip)| ip)
        .filter(|ip| matches!(ip, IpAddr::V4(v4) if v4.is_private()))
        .collect();
    if let Ok(ip) = local_ip() {
        ips.push(ip);
    }
    ips.sort();
    ips.dedup();
    ips
}

/// Reuses the saved certificate while it still names every address in `ips`; otherwise makes a new one.
/// Returns (certificate PEM, private key PEM).
pub fn load_or_create_cert(dir: &Path, ips: &[IpAddr]) -> Result<(String, String), String> {
    let cert_path = dir.join("phone-scanner-cert.pem");
    let key_path = dir.join("phone-scanner-key.pem");
    let ips_path = dir.join("phone-scanner-ips.txt");
    if let (Ok(cert), Ok(key), Ok(saved)) =
        (std::fs::read_to_string(&cert_path), std::fs::read_to_string(&key_path), std::fs::read_to_string(&ips_path))
    {
        let saved: Vec<&str> = saved.lines().collect();
        if ips.iter().all(|ip| saved.contains(&ip.to_string().as_str())) {
            return Ok((cert, key));
        }
    }
    let mut params = rcgen::CertificateParams::new(vec!["localhost".to_string()]).map_err(|e| e.to_string())?;
    params.distinguished_name.push(rcgen::DnType::CommonName, "Pharmacy POS phone scanner");
    params.subject_alt_names.push(rcgen::SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST)));
    for ip in ips {
        params.subject_alt_names.push(rcgen::SanType::IpAddress(*ip));
    }
    params.not_before = rcgen::date_time_ymd(2025, 1, 1);
    params.not_after = rcgen::date_time_ymd(2035, 1, 1);
    let key = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
    let cert = params.self_signed(&key).map_err(|e| e.to_string())?;
    let (cert_pem, key_pem) = (cert.pem(), key.serialize_pem());
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(&cert_path, &cert_pem).map_err(|e| e.to_string())?;
    std::fs::write(&key_path, &key_pem).map_err(|e| e.to_string())?;
    let list: Vec<String> = ips.iter().map(|ip| ip.to_string()).collect();
    std::fs::write(&ips_path, list.join("\n")).map_err(|e| e.to_string())?;
    Ok((cert_pem, key_pem))
}

/// The QR code for the scanner link, as an SVG image.
pub fn qr_svg(url: &str) -> Result<String, String> {
    let code = qrcode::QrCode::new(url.as_bytes()).map_err(|e| e.to_string())?;
    Ok(code.render::<qrcode::render::svg::Color>().min_dimensions(240, 240).quiet_zone(true).build())
}

// ── Windows Firewall ──
// Phones connect from the network, so Windows Firewall must let this program accept connections on PORT. Without a
// rule it silently drops them (on a "Public" network by default) and the phone shows a blank page until it times out.

pub const FIREWALL_RULE: &str = "Pharmacy POS phone scanner";

#[derive(Clone, Copy, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FirewallState {
    /// A rule allows this exact program on PORT.
    Allowed,
    /// No rule for this program: phones will not get through.
    Missing,
    /// Not Windows, or the firewall could not be queried.
    Unknown,
}

#[cfg(windows)]
fn hidden_command(program: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut c = std::process::Command::new(program);
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Looks for our rule and checks it points at the program that is running now (a dev build and the installed app live
/// in different folders). The program path is compared, not netsh's wording, which depends on the Windows language.
#[cfg(windows)]
pub fn firewall_state() -> FirewallState {
    let Ok(exe) = std::env::current_exe() else { return FirewallState::Unknown };
    let out = hidden_command("netsh")
        .args(["advfirewall", "firewall", "show", "rule", &format!("name={FIREWALL_RULE}"), "verbose"])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let text = String::from_utf8_lossy(&o.stdout).to_lowercase();
            if text.contains(&exe.display().to_string().to_lowercase()) {
                FirewallState::Allowed
            } else {
                FirewallState::Missing
            }
        }
        // netsh exits with 1 when no rule has that name.
        Ok(_) => FirewallState::Missing,
        Err(_) => FirewallState::Unknown,
    }
}

#[cfg(not(windows))]
pub fn firewall_state() -> FirewallState {
    FirewallState::Unknown
}

/// The elevated command that (re)creates the rule: this program only, TCP PORT only, any network profile.
#[cfg(windows)]
fn firewall_script(exe: &Path) -> String {
    let exe = exe.display().to_string();
    let cmd = format!(
        "/c netsh advfirewall firewall delete rule name=\"{FIREWALL_RULE}\" & \
         netsh advfirewall firewall add rule name=\"{FIREWALL_RULE}\" dir=in action=allow protocol=TCP \
         localport={PORT} program=\"{exe}\" profile=any"
    );
    // A PowerShell single-quoted string: a quote inside it is written twice.
    format!(
        "$p = Start-Process -FilePath 'cmd.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '{}'; exit $p.ExitCode",
        cmd.replace('\'', "''")
    )
}

/// Adds the rule. Windows asks the user to confirm as administrator; returns an error if they decline.
#[cfg(windows)]
pub fn allow_through_firewall() -> Result<FirewallState, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let status = hidden_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &firewall_script(&exe)])
        .status()
        .map_err(|e| format!("تعذّر تشغيل أداة جدار الحماية: {e}"))?;
    if !status.success() {
        return Err("لم تتم الموافقة على تعديل جدار الحماية".into());
    }
    match firewall_state() {
        FirewallState::Allowed => Ok(FirewallState::Allowed),
        _ => Err("لم يُضف الاستثناء إلى جدار الحماية".into()),
    }
}

#[cfg(not(windows))]
pub fn allow_through_firewall() -> Result<FirewallState, String> {
    Err("هذا الإعداد متاح في ويندوز فقط".into())
}

/// Starts the server in the background. Failures (port taken, certificate) end up in `scanner.status`; the rest of
/// the app keeps working without the phone scanner.
pub fn start(data_dir: std::path::PathBuf, scanner: Arc<Scanner>) {
    tauri::async_runtime::spawn(async move {
        let set_status = |running: bool, error: Option<String>| {
            *scanner.status.lock().unwrap_or_else(|e| e.into_inner()) = ServerStatus { running, error };
        };
        // Several crates link rustls; pick its crypto once. An error only means it was already picked.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (cert, key) = match load_or_create_cert(&data_dir, &private_ips()) {
            Ok(pair) => pair,
            Err(e) => return set_status(false, Some(format!("تعذّر إنشاء شهادة الاتصال الآمن: {e}"))),
        };
        let config = match axum_server::tls_rustls::RustlsConfig::from_pem(cert.into_bytes(), key.into_bytes()).await {
            Ok(c) => c,
            Err(e) => return set_status(false, Some(format!("تعذّر تحميل شهادة الاتصال الآمن: {e}"))),
        };
        let addr = SocketAddr::from(([0, 0, 0, 0], PORT));
        // Bind first, so "port in use" is reported instead of failing silently inside serve().
        let listener = match std::net::TcpListener::bind(addr) {
            Ok(l) => l,
            Err(e) => {
                return set_status(false, Some(format!("المنفذ {PORT} مستخدم من برنامج آخر، أغلقه ثم أعد تشغيل البرنامج ({e})")))
            }
        };
        let _ = listener.set_nonblocking(true);
        set_status(true, None);
        let app = router(scanner.clone()).into_make_service();
        if let Err(e) = axum_server::from_tcp_rustls(listener, config).serve(app).await {
            set_status(false, Some(format!("توقف خادم قارئ الموبايل: {e}")));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn scanner() -> (Arc<Scanner>, Arc<Mutex<Vec<ScanEvent>>>) {
        let got = Arc::new(Mutex::new(vec![]));
        let sink_got = got.clone();
        let sink: Sink = Arc::new(move |e| sink_got.lock().unwrap().push(e));
        (Arc::new(Scanner::new("secret-token-123".into(), sink)), got)
    }

    async fn call(s: &Arc<Scanner>, req: Request<Body>) -> (StatusCode, String) {
        let res = router(s.clone()).oneshot(req).await.unwrap();
        let status = res.status();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    fn post_scan(token: &str, body: &str) -> Request<Body> {
        Request::post("/api/scan")
            .header("content-type", "application/json")
            .header("x-scanner-token", token)
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn scan_with_token_reaches_the_till() {
        let (s, got) = scanner();
        let (status, body) = call(&s, post_scan("secret-token-123", r#"{"code":" 2000000000046\n","device":"phone-ab12"}"#)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(*got.lock().unwrap(), [ScanEvent { code: "2000000000046".into(), device: "phone-ab12".into() }]);
        assert_eq!(s.connected(Duration::from_secs(10))[0].0, "phone-ab12");
    }

    #[tokio::test]
    async fn scan_without_the_right_token_is_refused() {
        let (s, got) = scanner();
        for token in ["", "wrong", "secret-token-12", "secret-token-1234"] {
            let (status, _) = call(&s, post_scan(token, r#"{"code":"2000000000046"}"#)).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "token {token:?}");
        }
        let req = Request::get("/api/ping").body(Body::empty()).unwrap();
        assert_eq!(call(&s, req).await.0, StatusCode::UNAUTHORIZED);
        assert!(got.lock().unwrap().is_empty());
        assert!(s.connected(Duration::from_secs(10)).is_empty(), "unknown callers are not listed");
    }

    #[tokio::test]
    async fn bad_codes_and_bodies_are_rejected() {
        let (s, got) = scanner();
        let long = format!(r#"{{"code":"{}"}}"#, "1".repeat(201));
        for body in [r#"{"code":""}"#, r#"{"code":"   "}"#, r#"{"code":"<script>\u0007"}"#, &long] {
            assert_eq!(call(&s, post_scan("secret-token-123", body)).await.0, StatusCode::BAD_REQUEST, "{body}");
        }
        assert!(call(&s, post_scan("secret-token-123", "not json")).await.0.is_client_error());
        assert!(got.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn gs1_datamatrix_keeps_its_group_separator() {
        let (s, got) = scanner();
        let body = r#"{"code":"0102000000000077172812311\u001d10B2311"}"#;
        assert_eq!(call(&s, post_scan("secret-token-123", body)).await.0, StatusCode::OK);
        assert_eq!(got.lock().unwrap()[0].code, "0102000000000077172812311\u{1d}10B2311");
    }

    #[tokio::test]
    async fn ping_marks_the_phone_connected_and_pages_are_served() {
        let (s, _) = scanner();
        let req = Request::get("/api/ping?device=phone-x%2F..%2Fy").header("x-scanner-token", "secret-token-123").body(Body::empty()).unwrap();
        assert_eq!(call(&s, req).await.0, StatusCode::NO_CONTENT);
        assert_eq!(s.connected(Duration::from_secs(10))[0].0, "phone-xy", "device id is sanitised");

        let (status, html) = call(&s, Request::get("/scan?t=x").body(Body::empty()).unwrap()).await;
        assert_eq!(status, StatusCode::OK);
        assert!(html.contains("/scan/html5-qrcode.min.js") && html.contains("x-scanner-token"));
        let (status, js) = call(&s, Request::get("/scan/html5-qrcode.min.js").body(Body::empty()).unwrap()).await;
        assert_eq!(status, StatusCode::OK);
        assert!(js.contains("Html5Qrcode"));
        assert_eq!(call(&s, Request::get("/").body(Body::empty()).unwrap()).await.0, StatusCode::NOT_FOUND);
    }

    #[test]
    fn certificate_is_kept_until_the_address_changes() {
        let dir = std::env::temp_dir().join(format!("pos-cert-test-{}", uuid::Uuid::new_v4()));
        let a: IpAddr = "192.168.1.20".parse().unwrap();
        let b: IpAddr = "192.168.1.31".parse().unwrap();
        let (cert1, key1) = load_or_create_cert(&dir, &[a]).unwrap();
        assert!(cert1.starts_with("-----BEGIN CERTIFICATE-----") && key1.contains("PRIVATE KEY"));
        let (cert2, _) = load_or_create_cert(&dir, &[a]).unwrap();
        assert_eq!(cert1, cert2, "same address: phones keep their accepted certificate");
        let (cert3, _) = load_or_create_cert(&dir, &[b]).unwrap();
        assert_ne!(cert1, cert3, "new address: new certificate naming it");
        std::fs::remove_dir_all(dir).ok();
    }

    #[cfg(windows)]
    #[test]
    fn firewall_rule_is_scoped_to_this_program_and_port() {
        let script = firewall_script(Path::new(r"C:\Program Files\PharmacyPOS\pharmacy-pos.exe"));
        assert!(script.contains(r#"program="C:\Program Files\PharmacyPOS\pharmacy-pos.exe""#), "{script}");
        assert!(script.contains("localport=8080") && script.contains("protocol=TCP") && script.contains("dir=in"));
        assert!(script.contains("-Verb RunAs"), "needs the administrator prompt");
        // A quote in the path cannot break out of the PowerShell string.
        let odd = firewall_script(Path::new(r"C:\Users\O'Neil\pos.exe"));
        assert!(odd.contains(r"O''Neil") && !odd.contains(r"O'Neil"));
    }

    #[test]
    fn secrets_and_qr() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abc", "abd") && !same_secret("abc", "ab") && !same_secret("", ""));
        let svg = qr_svg("https://192.168.1.20:8080/scan?t=abc").unwrap();
        assert!(svg.contains("<svg"));
    }
}
