// On mobile the whole desktop server/tray/updater layer is compiled but unused
// (the mobile entry is a thin webview client), so quiet the expected dead-code.
#![cfg_attr(mobile, allow(dead_code, unused_imports))]

use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    env, fs,
    io::{Read, Write},
    net::TcpStream,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager, State};
// menu / tray / updater are desktop-only — these modules and the updater plugin
// don't exist on iOS, so gate every use of them.
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem};
#[cfg(desktop)]
use tauri::tray::TrayIconBuilder;
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;

pub mod native_capture;

const SERVICE_NAME: &str = "app.orca.desktop";
const TOKEN_ACCOUNT: &str = "orca-api-token";
const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 34125;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    state: String,
    host: String,
    port: u16,
    local_url: String,
    health_url: String,
    pairing_url: String,
    token_ready: bool,
    health_ready: bool,
    process_pid: Option<u32>,
    last_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingCodeResponse {
    code: String,
    expires_at: Option<String>,
    ttl_seconds: Option<u64>,
    copied_to_clipboard: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheckResponse {
    available: bool,
    current_version: String,
    version: Option<String>,
    date: Option<String>,
    body: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingEnvelope {
    pairing: PairingPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingPayload {
    code: String,
    expires_at: Option<String>,
    ttl_seconds: Option<u64>,
}

struct DesktopHost {
    host: String,
    port: u16,
    child: Option<Child>,
    token: Option<String>,
    last_error: Option<String>,
    resource_dir: Option<PathBuf>,
    data_dir: Option<PathBuf>,
    native_capture_url: Option<String>,
    native_capture_token: Option<String>,
}

struct DesktopHostState {
    host: Mutex<DesktopHost>,
}

impl DesktopHost {
    fn new() -> Self {
        let host =
            env::var("ORCA_DESKTOP_HOST").unwrap_or_else(|_| DEFAULT_HOST.to_string());
        let port = env::var("ORCA_DESKTOP_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(DEFAULT_PORT);
        Self {
            host,
            port,
            child: None,
            token: None,
            last_error: None,
            resource_dir: None,
            data_dir: None,
            native_capture_url: None,
            native_capture_token: None,
        }
    }

    fn set_runtime_paths(&mut self, resource_dir: Option<PathBuf>, data_dir: Option<PathBuf>) {
        self.resource_dir = resource_dir;
        self.data_dir = data_dir;
    }

    fn set_native_capture(&mut self, url: String, token: String) {
        self.native_capture_url = Some(url);
        self.native_capture_token = Some(token);
    }

    fn local_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    fn health_url(&self) -> String {
        format!("{}/api/health", self.local_url())
    }

    fn pairing_url(&self) -> String {
        format!("{}/api/auth/pairing-codes", self.local_url())
    }

    fn credential_entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE_NAME, TOKEN_ACCOUNT)
            .map_err(|error| format!("Could not open OS credential entry: {error}"))
    }

    fn load_or_create_token(&mut self) -> Result<String, String> {
        if let Some(token) = &self.token {
            return Ok(token.clone());
        }
        // Allow a provided token (CI/tests/headless) to avoid an OS credential prompt.
        if let Ok(token) = env::var("ORCA_API_TOKEN") {
            if !token.trim().is_empty() {
                self.token = Some(token.clone());
                return Ok(token);
            }
        }
        let entry = Self::credential_entry()?;
        match entry.get_password() {
            Ok(token) if !token.trim().is_empty() => {
                self.token = Some(token.clone());
                Ok(token)
            }
            Ok(_) | Err(_) => {
                let token = generate_token();
                entry.set_password(&token).map_err(|error| {
                    format!("Could not save API token to OS credentials: {error}")
                })?;
                self.token = Some(token.clone());
                Ok(token)
            }
        }
    }

    fn refresh_child_state(&mut self) {
        if let Some(child) = &mut self.child {
            if matches!(child.try_wait(), Ok(Some(_))) {
                self.child = None;
            }
        }
    }

    fn health_ready(&self) -> bool {
        match &self.token {
            Some(token) => auth_status_ready(&self.host, self.port, token),
            None => false,
        }
    }

    fn status(&mut self) -> DesktopStatus {
        self.refresh_child_state();
        let token_ready = self.token.is_some()
            || Self::credential_entry()
                .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
                .map(|token| !token.trim().is_empty())
                .unwrap_or(false);
        let health_ready = if token_ready {
            if self.token.is_none() {
                let _ = self.load_or_create_token();
            }
            self.health_ready()
        } else {
            false
        };
        DesktopStatus {
            state: if health_ready {
                "health-ready".to_string()
            } else if self.child.is_some() {
                "process-starting".to_string()
            } else {
                "stopped".to_string()
            },
            host: self.host.clone(),
            port: self.port,
            local_url: self.local_url(),
            health_url: self.health_url(),
            pairing_url: self.pairing_url(),
            token_ready,
            health_ready,
            process_pid: self.child.as_ref().map(|child| child.id()),
            last_error: self.last_error.clone(),
        }
    }

    fn start(&mut self) -> Result<DesktopStatus, String> {
        let token = self.load_or_create_token()?;
        self.refresh_child_state();
        if self.health_ready() {
            self.last_error = None;
            return Ok(self.status());
        }
        if self.child.is_some() {
            wait_for_health(&self.host, self.port, &token)?;
            self.last_error = None;
            return Ok(self.status());
        }

        let entry = self.server_entry()?;
        let workdir = self.server_workdir(&entry)?;
        let mut command = Command::new(
            env::var("ORCA_NODE_BINARY").unwrap_or_else(|_| "node".to_string()),
        );
        command
            .arg(entry)
            .current_dir(workdir)
            .env("ORCA_HOST", &self.host)
            .env("PORT", self.port.to_string())
            .env("ORCA_API_TOKEN", &token)
            .env("ORCA_DESKTOP_HOSTED", "true");
        if let (Some(url), Some(native_token)) =
            (self.native_capture_url.as_ref(), self.native_capture_token.as_ref())
        {
            command
                .env("ORCA_NATIVE_CAPTURE_URL", url)
                .env("ORCA_NATIVE_CAPTURE_TOKEN", native_token);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let child = command
            .spawn()
            .map_err(|error| format!("Could not start Orca server: {error}"))?;
        self.child = Some(child);
        if let Err(error) = wait_for_health(&self.host, self.port, &token) {
            if let Some(mut child) = self.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            self.last_error = Some(error.clone());
            return Err(error);
        }
        self.last_error = None;
        Ok(self.status())
    }

    fn stop(&mut self) -> Result<DesktopStatus, String> {
        self.refresh_child_state();
        if let Some(mut child) = self.child.take() {
            child
                .kill()
                .map_err(|error| format!("Could not stop Orca server: {error}"))?;
            let _ = child.wait();
        }
        self.last_error = None;
        Ok(self.status())
    }

    fn restart(&mut self) -> Result<DesktopStatus, String> {
        let _ = self.stop()?;
        self.start()
    }

    fn create_pairing_code(
        &mut self,
        label: Option<String>,
    ) -> Result<PairingCodeResponse, String> {
        let token = self.load_or_create_token()?;
        if !self.health_ready() {
            let _ = self.start()?;
        }
        let body = json!({
            "actor": "desktop",
            "label": label.unwrap_or_else(|| "Desktop-created phone/browser pairing".to_string()),
        })
        .to_string();
        let response = http_request(
            &self.host,
            self.port,
            "POST",
            "/api/auth/pairing-codes",
            Some(&token),
            Some(&body),
        )?;
        if response.status != 201 {
            return Err(format!(
                "Pairing code request failed with HTTP {}",
                response.status
            ));
        }
        let envelope: PairingEnvelope = serde_json::from_str(&response.body)
            .map_err(|error| format!("Could not parse pairing response: {error}"))?;
        let copied_to_clipboard = copy_text(&envelope.pairing.code).is_ok();
        Ok(PairingCodeResponse {
            code: envelope.pairing.code,
            expires_at: envelope.pairing.expires_at,
            ttl_seconds: envelope.pairing.ttl_seconds,
            copied_to_clipboard,
        })
    }

    fn server_roots(&self) -> Vec<PathBuf> {
        let mut roots = Vec::new();
        if let Ok(cwd) = env::var("ORCA_SERVER_CWD") {
            roots.push(PathBuf::from(cwd));
        }
        if let Ok(current_dir) = env::current_dir() {
            roots.push(current_dir);
        }
        if let Some(resource_dir) = &self.resource_dir {
            roots.push(resource_dir.clone());
            roots.push(resource_dir.join("_up_"));
        }
        roots
    }

    fn server_entry(&self) -> Result<PathBuf, String> {
        if let Ok(entry) = env::var("ORCA_SERVER_ENTRY") {
            return Ok(PathBuf::from(entry));
        }
        server_entry_from_roots(&self.server_roots())
    }

    fn server_workdir(&self, entry: &PathBuf) -> Result<PathBuf, String> {
        if let Ok(workdir) = env::var("ORCA_SERVER_WORKDIR") {
            return Ok(PathBuf::from(workdir));
        }
        if let Some(data_dir) = &self.data_dir {
            fs::create_dir_all(data_dir).map_err(|error| {
                format!(
                    "Could not create Orca desktop data directory {}: {error}",
                    data_dir.display()
                )
            })?;
            return Ok(data_dir.clone());
        }
        entry
            .parent()
            .and_then(|src_dir| src_dir.parent())
            .map(PathBuf::from)
            .ok_or_else(|| "Could not resolve Orca server working directory.".to_string())
    }
}

#[derive(Debug)]
struct HttpResponse {
    status: u16,
    body: String,
}

fn generate_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn server_entry_from_roots(roots: &[PathBuf]) -> Result<PathBuf, String> {
    let mut checked = Vec::new();
    for root in roots {
        let entry = root.join("src").join("server.js");
        checked.push(entry.display().to_string());
        if entry.exists() {
            return Ok(entry);
        }
    }
    Err(format!(
        "Orca server entry was not found. Checked {}. Set ORCA_SERVER_ENTRY for custom packaged server builds.",
        checked.join(", ")
    ))
}

fn wait_for_health(host: &str, port: u16, token: &str) -> Result<(), String> {
    for _ in 0..50 {
        if auth_status_ready(host, port, token) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("Orca server did not become healthy in time.".to_string())
}

fn auth_status_ready(host: &str, port: u16, token: &str) -> bool {
    http_request(host, port, "GET", "/api/auth/status", Some(token), None)
        .ok()
        .filter(|response| response.status == 200)
        .and_then(|response| serde_json::from_str::<serde_json::Value>(&response.body).ok())
        .and_then(|body| {
            let token_required = body.get("apiTokenRequired")?.as_bool()?;
            let token_authenticated = body.get("apiTokenAuthenticated")?.as_bool()?;
            Some(!token_required || token_authenticated)
        })
        .unwrap_or(false)
}

fn http_request(
    host: &str,
    port: u16,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> Result<HttpResponse, String> {
    let mut stream = TcpStream::connect((host, port))
        .map_err(|error| format!("Could not connect to Orca server: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| format!("Could not set HTTP read timeout: {error}"))?;

    let body = body.unwrap_or("");
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nAccept: application/json\r\n"
    );
    if let Some(token) = token {
        request.push_str(&format!("x-orca-token: {token}\r\n"));
    }
    if !body.is_empty() {
        request.push_str("Content-Type: application/json\r\n");
        request.push_str(&format!("Content-Length: {}\r\n", body.as_bytes().len()));
    }
    request.push_str("\r\n");
    request.push_str(body);

    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Could not write HTTP request: {error}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("Could not read HTTP response: {error}"))?;
    let status = response
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "Orca server returned an invalid HTTP response.".to_string())?;
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default();
    Ok(HttpResponse { status, body })
}

fn copy_text(value: &str) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|error| format!("Could not open system clipboard: {error}"))?;
    clipboard
        .set_text(value.to_string())
        .map_err(|error| format!("Could not write system clipboard: {error}"))
}

fn with_host<T>(
    state: &State<'_, DesktopHostState>,
    operation: impl FnOnce(&mut DesktopHost) -> Result<T, String>,
) -> Result<T, String> {
    let mut host = state
        .host
        .lock()
        .map_err(|_| "Desktop host state lock is poisoned.".to_string())?;
    operation(&mut host)
}

#[tauri::command]
fn server_status(state: State<'_, DesktopHostState>) -> Result<DesktopStatus, String> {
    with_host(&state, |host| Ok(host.status()))
}

#[tauri::command]
fn server_start(state: State<'_, DesktopHostState>) -> Result<DesktopStatus, String> {
    with_host(&state, |host| host.start())
}

#[tauri::command]
fn server_stop(state: State<'_, DesktopHostState>) -> Result<DesktopStatus, String> {
    with_host(&state, |host| host.stop())
}

#[tauri::command]
fn server_restart(state: State<'_, DesktopHostState>) -> Result<DesktopStatus, String> {
    with_host(&state, |host| host.restart())
}

#[tauri::command]
fn copy_phone_url(state: State<'_, DesktopHostState>) -> Result<DesktopStatus, String> {
    with_host(&state, |host| {
        let status = host.status();
        copy_text(&status.local_url)?;
        Ok(status)
    })
}

#[tauri::command]
fn create_pairing_code(
    state: State<'_, DesktopHostState>,
    label: Option<String>,
) -> Result<PairingCodeResponse, String> {
    with_host(&state, |host| host.create_pairing_code(label))
}

#[cfg(desktop)]
async fn check_for_updates_for_app(app: AppHandle) -> Result<UpdateCheckResponse, String> {
    let current_version = app.package_info().version.to_string();
    let update = app
        .updater()
        .map_err(|error| format!("Could not create updater: {error}"))?
        .check()
        .await
        .map_err(|error| format!("Could not check for updates: {error}"))?;
    Ok(match update {
        Some(update) => UpdateCheckResponse {
            available: true,
            current_version: update.current_version,
            version: Some(update.version),
            date: update.date.as_ref().map(ToString::to_string),
            body: update.body,
        },
        None => UpdateCheckResponse {
            available: false,
            current_version,
            version: None,
            date: None,
            body: None,
        },
    })
}

#[cfg(desktop)]
async fn install_update_for_app(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|error| format!("Could not create updater: {error}"))?
        .check()
        .await
        .map_err(|error| format!("Could not check for updates: {error}"))?;
    let Some(update) = update else {
        return Ok(());
    };
    let state = app.state::<DesktopHostState>();
    let _ = with_host(&state, |host| host.stop());
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("Could not download and install update: {error}"))?;
    app.restart();
}

#[cfg(desktop)]
#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<UpdateCheckResponse, String> {
    check_for_updates_for_app(app).await
}

#[cfg(desktop)]
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    install_update_for_app(app).await
}

/// Open the workstation's NATIVE OS folder picker (desktop only) and return the
/// chosen absolute path, or None if the user cancelled. The web UI calls this via
/// `window.__TAURI__.core.invoke('pick_directory')` and falls back to the jailed
/// web picker on remote/browser where no OS dialog exists.
#[cfg(desktop)]
#[tauri::command]
async fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let picked = rx.recv().map_err(|e| e.to_string())?;
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|pb| pb.to_string_lossy().to_string()))
}

#[cfg(desktop)]
fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    let open_dashboard =
        MenuItem::with_id(app, "open_dashboard", "Open Dashboard", true, None::<&str>)?;
    let copy_phone_url = MenuItem::with_id(
        app,
        "copy_phone_url",
        "Copy Dashboard URL",
        true,
        None::<&str>,
    )?;
    let create_pairing_code = MenuItem::with_id(
        app,
        "create_pairing_code",
        "Create Pairing Code",
        true,
        None::<&str>,
    )?;
    let restart_server =
        MenuItem::with_id(app, "restart_server", "Restart Server", true, None::<&str>)?;
    let stop_server = MenuItem::with_id(app, "stop_server", "Stop Server", true, None::<&str>)?;
    let check_for_updates = MenuItem::with_id(
        app,
        "check_for_updates",
        "Check for Updates",
        true,
        None::<&str>,
    )?;
    let install_update =
        MenuItem::with_id(app, "install_update", "Install Update", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Orca", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open_dashboard,
            &copy_phone_url,
            &create_pairing_code,
            &restart_server,
            &stop_server,
            &check_for_updates,
            &install_update,
            &quit,
        ],
    )?;
    app.set_menu(menu.clone())?;
    let _tray = TrayIconBuilder::new().menu(&menu).build(app)?;
    Ok(())
}

#[cfg(desktop)]
fn handle_menu_event(app: &AppHandle, id: &str) {
    let state = app.state::<DesktopHostState>();
    match id {
        "open_dashboard" => {
            let _ = with_host(&state, |host| host.start());
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "copy_phone_url" => {
            let _ = with_host(&state, |host| {
                let status = host.status();
                copy_text(&status.local_url)?;
                Ok(status)
            });
        }
        "create_pairing_code" => {
            let _ = with_host(&state, |host| host.create_pairing_code(None));
        }
        "restart_server" => {
            let _ = with_host(&state, |host| host.restart());
        }
        "stop_server" => {
            let _ = with_host(&state, |host| host.stop());
        }
        "check_for_updates" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                match check_for_updates_for_app(app).await {
                    Ok(response) if response.available => {
                        log::info!("Orca update available: {:?}", response.version);
                    }
                    Ok(_) => {
                        log::info!("Orca is up to date.");
                    }
                    Err(error) => {
                        log::error!("Orca update check failed: {error}");
                    }
                }
            });
        }
        "install_update" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = install_update_for_app(app).await {
                    log::error!("Orca update install failed: {error}");
                }
            });
        }
        "quit" => {
            let _ = with_host(&state, |host| host.stop());
            app.exit(0);
        }
        _ => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    run_desktop();
    #[cfg(mobile)]
    run_mobile();
}

// iOS/Android: a thin client. No local Node server, tray, menu, native capture,
// or updater (none of which exist on mobile). The webview loads the bundled
// client, which shows the "Connect to a workstation" gate and then navigates to
// the workstation's tailnet URL — from there it's the normal paired remote client.
#[cfg(mobile)]
fn run_mobile() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running Orca (mobile)");
}

#[cfg(desktop)]
fn run_desktop() {
    let mut builder = tauri::Builder::default();
    // The updater plugin requires release updater config; allow disabling it for
    // dev/test runs (ORCA_DISABLE_UPDATER=1) so the app can boot without it.
    if env::var("ORCA_DISABLE_UPDATER").map(|v| v != "1").unwrap_or(true) {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopHostState {
            host: Mutex::new(DesktopHost::new()),
        })
        .invoke_handler(tauri::generate_handler![
            server_status,
            server_start,
            server_stop,
            server_restart,
            copy_phone_url,
            create_pairing_code,
            check_for_updates,
            install_update,
            pick_directory
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            install_menu(app)?;
            let state = app.state::<DesktopHostState>();
            let resource_dir = app.path().resource_dir().ok();
            let data_dir = app.path().app_data_dir().ok();
            // Start the native capture bridge (macOS: Chromium-free WKWebView
            // screenshots) before the server so its env can be passed to Node.
            let native_token = generate_token();
            if let Some(bridge) = native_capture::start(app.handle().clone(), native_token) {
                let _ = with_host(&state, |host| {
                    host.set_native_capture(bridge.endpoint, bridge.token);
                    Ok(())
                });
            }
            with_host(&state, |host| {
                host.set_runtime_paths(resource_dir, data_dir);
                host.start()
            })
            .map_err(|error| {
                log::error!("Orca desktop startup degraded: {error}");
                tauri::Error::Anyhow(anyhow::anyhow!(error))
            })?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            handle_menu_event(app, event.id().as_ref());
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let app = window.app_handle();
                let state = app.state::<DesktopHostState>();
                let _ = with_host(&state, |host| host.stop());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_api_tokens_are_long_random_hex_strings() {
        let first = generate_token();
        let second = generate_token();
        assert_eq!(first.len(), 64);
        assert_eq!(second.len(), 64);
        assert_ne!(first, second);
        assert!(first.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert!(second.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn server_entry_resolution_checks_packaged_resource_roots() {
        let root = env::temp_dir().join(format!("orca-tauri-test-{}", std::process::id()));
        let src_dir = root.join("src");
        fs::create_dir_all(&src_dir).expect("create temp server src dir");
        let server_file = src_dir.join("server.js");
        fs::write(&server_file, "export {};\n").expect("write temp server entry");

        let resolved = server_entry_from_roots(&[root.clone()]).expect("resolve server entry");
        assert_eq!(resolved, server_file);

        fs::remove_dir_all(root).expect("remove temp server root");
    }

    #[test]
    fn server_roots_include_tauri_parent_resource_folder() {
        let mut host = DesktopHost::new();
        host.set_runtime_paths(Some(PathBuf::from("/app/Contents/Resources")), None);

        let roots = host.server_roots();
        assert!(roots.contains(&PathBuf::from("/app/Contents/Resources")));
        assert!(roots.contains(&PathBuf::from("/app/Contents/Resources/_up_")));
    }
}
