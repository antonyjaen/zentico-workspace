// Zentico Workspace desktop shell: a Tauri window around a live Zentico Workspace server.
//
// The server is chosen at runtime on a bundled setup page (dist/index.html) and saved in the app
// config dir. At startup the saved workspace decides everything security-relevant: the only remote
// capability (just `notify`) is granted to that origin, the Notification shim is injected only
// there, and navigation is limited to it plus its sign-in and office hosts. Changing the workspace
// saves and restarts the app, so a previous origin never keeps any grant.

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Mutex,
    },
};

use serde::{Deserialize, Serialize};
use tauri::{
    ipc::CapabilityBuilder,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{NewWindowResponse, PageLoadEvent, PermissionKind, PermissionResponse},
    AppHandle, Manager, Url, UserAttentionType, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

const APP_NAME: &str = "Zentico Workspace";
const MAIN: &str = "main";
const NOTIFICATION_SHIM: &str = include_str!("notification-shim.js");

/// The chosen server. `origin` is https://host[:port] (or http://localhost for development);
/// the other hosts come from the server's /api/workspace-info.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    origin: String,
    auth_host: Option<String>,
    office_host: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    close_to_tray: bool,
    workspace: Option<Workspace>,
}

impl Default for Settings {
    fn default() -> Self {
        Self { close_to_tray: true, workspace: None }
    }
}

#[derive(Default)]
struct AppState {
    settings: Mutex<Settings>,
    /// The workspace this process was started with (what the capability and shim were built for).
    active: Mutex<Option<Workspace>>,
    /// Deep-link destination or setup prefill waiting for the launcher page.
    pending: Mutex<Launch>,
    on_app_origin: AtomicBool,
    window_seq: AtomicU32,
    unread: AtomicU32,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Launch {
    workspace: Option<Workspace>,
    /// Full URL on the workspace to open instead of its root.
    start: Option<String>,
    /// Server address to prefill on the setup screen (zentico://open?server=…).
    prefill: Option<String>,
}

/* ---------------------------------------------------------------- settings */

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    let mut s: Settings = settings_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    // Never trust the file blindly: re-validate what we will grant permissions to.
    s.workspace = s.workspace.and_then(|w| validate_workspace(&w.origin, w.auth_host.as_deref(), w.office_host.as_deref()).ok());
    s
}

fn save_settings(app: &AppHandle, s: &Settings) {
    if let Some(p) = settings_path(app) {
        let _ = p.parent().map(std::fs::create_dir_all);
        let _ = std::fs::write(p, serde_json::to_vec_pretty(s).unwrap_or_default());
    }
}

/* -------------------------------------------------------------- validation */

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// "host" or "host:port" with DNS-safe characters only.
fn valid_authority(a: &str) -> bool {
    !a.is_empty()
        && a.len() <= 253
        && a.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
}

/// https://host[:port] (http only for loopback), returned as a bare origin.
fn normalize_origin(input: &str) -> Result<String, String> {
    let url = Url::parse(input.trim()).map_err(|_| "Invalid address".to_string())?;
    let host = url.host_str().ok_or("Invalid address")?;
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(host) => {}
        _ => return Err("The workspace must use https://".into()),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Invalid address".into());
    }
    let origin = url.origin().ascii_serialization();
    if origin == "null" {
        return Err("Invalid address".into());
    }
    Ok(origin)
}

fn validate_workspace(origin: &str, auth: Option<&str>, office: Option<&str>) -> Result<Workspace, String> {
    let clean = |h: Option<&str>| -> Result<Option<String>, String> {
        match h.map(str::trim).filter(|h| !h.is_empty()) {
            None => Ok(None),
            Some(h) if valid_authority(h) => Ok(Some(h.to_ascii_lowercase())),
            Some(_) => Err("Invalid host from the server".into()),
        }
    };
    Ok(Workspace { origin: normalize_origin(origin)?, auth_host: clean(auth)?, office_host: clean(office)? })
}

/// host[:port] of a URL, port only when non-default (matches JS `URL.host`).
fn authority(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    Some(match url.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    })
}

fn is_workspace_url(ws: &Workspace, url: &Url) -> bool {
    url.origin().ascii_serialization() == ws.origin
}

/// URLs that may load inside an app window. Everything else goes to the system browser.
fn is_internal(app: &AppHandle, url: &Url) -> bool {
    match url.scheme() {
        // Bundled launcher page (tauri://localhost on macOS/Linux, http://tauri.localhost on Windows).
        "tauri" => return true,
        "http" if url.host_str() == Some("tauri.localhost") => return true,
        // Popup bootstrap and blob: downloads/previews created by the site itself.
        "about" | "blob" => return true,
        _ => {}
    }
    let state = app.state::<AppState>();
    let active = state.active.lock().unwrap();
    let Some(ws) = active.as_ref() else { return false };
    if is_workspace_url(ws, url) {
        return true;
    }
    url.scheme() == "https"
        && authority(url).is_some_and(|a| ws.auth_host.as_deref() == Some(&a) || ws.office_host.as_deref() == Some(&a))
}

fn open_external(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

/// Base URL of the bundled launcher page.
fn local_url(query: &str) -> Url {
    let base = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };
    let mut u = Url::parse(base).expect("valid url");
    u.set_query(Some(query).filter(|q| !q.is_empty()));
    u
}

/* -------------------------------------------------------------- deep links */

/// zentico://open?server=… → setup prefill; zentico://chat/abc?x=1 → <workspace>/chat/abc?x=1.
fn apply_deep_link(app: &AppHandle, link: &Url) -> bool {
    if link.scheme() != "zentico" {
        return false;
    }
    let state = app.state::<AppState>();
    let mut pending = state.pending.lock().unwrap();
    if link.host_str() == Some("open") {
        if let Some((_, server)) = link.query_pairs().find(|(k, _)| k == "server") {
            pending.prefill = Some(server.chars().take(300).collect());
            pending.start = None;
            return true;
        }
    }
    let active = state.active.lock().unwrap();
    let Some(ws) = active.as_ref() else { return true };
    let Ok(mut target) = Url::parse(&ws.origin) else { return false };
    // set_path only touches the path, so the origin stays the workspace whatever the link says.
    target.set_path(&format!("{}{}", link.host_str().unwrap_or(""), link.path()));
    target.set_query(link.query());
    target.set_fragment(link.fragment());
    pending.start = Some(target.to_string());
    true
}

fn show_main(app: &AppHandle) -> Option<WebviewWindow> {
    let w = app.get_webview_window(MAIN)?;
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    Some(w)
}

fn open_deep_links(app: &AppHandle, urls: impl IntoIterator<Item = Url>) {
    if !urls.into_iter().fold(false, |any, u| apply_deep_link(app, &u) || any) {
        return;
    }
    if let Some(w) = show_main(app) {
        // The launcher page picks up the pending destination (and shows setup for a prefill).
        let _ = w.navigate(local_url(""));
    }
}

/* ----------------------------------------------------------------- windows */

/// Builds an app window with the navigation/permission/notification policy applied.
fn app_window<'a>(app: &'a AppHandle, label: &str, url: WebviewUrl) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let origin = app.state::<AppState>().active.lock().unwrap().as_ref().map(|w| w.origin.clone());
    let nav_app = app.clone();
    let popup_app = app.clone();
    let load_app = app.clone();
    let perm_app = app.clone();
    let is_main = label == MAIN;
    let mut builder = WebviewWindowBuilder::new(app, label, url)
        .title(APP_NAME)
        .inner_size(1280.0, 820.0)
        .min_inner_size(400.0, 500.0);
    if let Some(origin) = origin {
        let shim = NOTIFICATION_SHIM.replace("__ZENTICO_ORIGIN__", &serde_json::to_string(&origin).unwrap_or_default());
        builder = builder.initialization_script(shim);
    }
    builder
        .on_navigation(move |url| {
            if is_internal(&nav_app, url) {
                return true;
            }
            open_external(&nav_app, url);
            false
        })
        .on_new_window(move |url, features| {
            if url.scheme() != "about" && url.scheme() != "blob" && is_internal(&popup_app, &url) {
                // Same-site "open in new tab" (file previews, Meet now): a second app window.
                let state = popup_app.state::<AppState>();
                let label = format!("w{}", state.window_seq.fetch_add(1, Ordering::Relaxed) + 1);
                let blank = WebviewUrl::External("about:blank".parse().expect("valid url"));
                if let Ok(window) = app_window(&popup_app, &label, blank).window_features(features).build() {
                    return NewWindowResponse::Create { window };
                }
                return NewWindowResponse::Deny;
            }
            open_external(&popup_app, &url);
            NewWindowResponse::Deny
        })
        .on_page_load(move |_, payload| {
            if is_main && payload.event() == PageLoadEvent::Started {
                let state = load_app.state::<AppState>();
                let on_app = state.active.lock().unwrap().as_ref().is_some_and(|ws| is_workspace_url(ws, payload.url()));
                state.on_app_origin.store(on_app, Ordering::Relaxed);
            }
        })
        .on_permission_request(move |_, kind| {
            // Meetings (LiveKit) need camera + microphone; only the workspace origin gets them.
            if is_main && !perm_app.state::<AppState>().on_app_origin.load(Ordering::Relaxed) {
                return PermissionResponse::Default;
            }
            match kind {
                PermissionKind::Camera
                | PermissionKind::Microphone
                | PermissionKind::Notifications
                | PermissionKind::ClipboardRead => PermissionResponse::Allow,
                _ => PermissionResponse::Default,
            }
        })
        .on_document_title_changed(move |window, title| {
            // The site prefixes the title with "(N) " for unread notifications.
            let _ = window.set_title(&title);
            if window.label() != MAIN {
                return;
            }
            let unread = title
                .strip_prefix('(')
                .and_then(|r| r.split([')', '+']).next())
                .and_then(|n| n.parse::<u32>().ok())
                .unwrap_or(0);
            let app = window.app_handle();
            let prev = app.state::<AppState>().unread.swap(unread, Ordering::Relaxed);
            if let Some(tray) = app.tray_by_id("tray") {
                let tip = if unread > 0 { format!("{APP_NAME} ({unread} unread)") } else { APP_NAME.into() };
                let _ = tray.set_tooltip(Some(tip));
            }
            if unread > prev && !window.is_focused().unwrap_or(true) {
                let _ = window.request_user_attention(Some(UserAttentionType::Informational));
            }
        })
}

/* ---------------------------------------------------------------- commands */

/// Launcher page: the saved workspace and any pending deep link / prefill (consumed).
#[tauri::command]
fn get_launch(app: AppHandle) -> Launch {
    let state = app.state::<AppState>();
    let mut l = std::mem::take(&mut *state.pending.lock().unwrap());
    l.workspace = state.settings.lock().unwrap().workspace.clone();
    l
}

/// Launcher page: save the workspace it validated (via /api/workspace-info) and restart so the
/// capability, shim and allow-list are rebuilt for it alone. Returns false if nothing changed.
#[tauri::command]
fn set_workspace(app: AppHandle, origin: String, auth_host: Option<String>, office_host: Option<String>) -> Result<bool, String> {
    let ws = validate_workspace(&origin, auth_host.as_deref(), office_host.as_deref())?;
    let state = app.state::<AppState>();
    {
        let mut s = state.settings.lock().unwrap();
        s.workspace = Some(ws.clone());
        save_settings(&app, &s);
    }
    if state.active.lock().unwrap().as_ref() == Some(&ws) {
        return Ok(false);
    }
    app.request_restart();
    Ok(true)
}

/// Native toast for the page's `new Notification(...)`; clicking it focuses the window and
/// fires the notification's onclick in the page.
#[tauri::command]
fn notify(app: AppHandle, window: WebviewWindow, id: u32, title: String, body: String) -> Result<(), String> {
    let title: String = title.chars().take(200).collect();
    let body: String = body.chars().take(1000).collect();
    let label = window.label().to_string();
    show_toast(&app, &title, &body, move |app: &AppHandle| {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            let _ = w.eval(format!("window.__zenticoNotificationClick&&window.__zenticoNotificationClick({id})"));
        }
    })
}

#[cfg(windows)]
fn show_toast(app: &AppHandle, title: &str, body: &str, on_click: impl Fn(&AppHandle) + Send + 'static) -> Result<(), String> {
    use tauri_winrt_notification::{Sound, Toast};
    // Toasts need a registered AppUserModelID: the installer's Start menu shortcut uses the
    // bundle identifier; dev builds borrow PowerShell's.
    let app_id = if tauri::is_dev() { Toast::POWERSHELL_APP_ID.to_string() } else { app.config().identifier.clone() };
    let handle = app.clone();
    Toast::new(&app_id)
        .title(title)
        .text1(body)
        .sound(Some(Sound::Default))
        .on_activated(move |_| {
            on_click(&handle);
            Ok(())
        })
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn show_toast(app: &AppHandle, title: &str, body: &str, on_click: impl Fn(&AppHandle) + Send + 'static) -> Result<(), String> {
    let handle = app.clone();
    let n = notify_rust::Notification::new()
        .appname(APP_NAME)
        .summary(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::thread::spawn(move || n.wait_for_action(|_| on_click(&handle)));
    #[cfg(target_os = "macos")]
    {
        let _ = (n, handle, on_click);
    }
    Ok(())
}

/* -------------------------------------------------------------------- tray */

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let close_to_tray = app.state::<AppState>().settings.lock().unwrap().close_to_tray;
    let open = MenuItem::with_id(app, "open", format!("Open {APP_NAME}"), true, None::<&str>)?;
    let change = MenuItem::with_id(app, "change_workspace", "Change workspace…", true, None::<&str>)?;
    let keep = CheckMenuItem::with_id(app, "close_to_tray", "Keep running when the window is closed", true, close_to_tray, None::<&str>)?;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(app, "autostart", "Start at login", true, autostart_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[&open, &change, &sep()?, &keep, &autostart, &sep()?, &quit])?;

    TrayIconBuilder::with_id("tray")
        .icon(app.default_window_icon().cloned().expect("bundle icon"))
        .tooltip(APP_NAME)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => {
                show_main(app);
            }
            "change_workspace" => {
                if let Some(w) = show_main(app) {
                    let _ = w.navigate(local_url("setup=1"));
                }
            }
            "close_to_tray" => {
                let state = app.state::<AppState>();
                let mut s = state.settings.lock().unwrap();
                s.close_to_tray = keep.is_checked().unwrap_or(!s.close_to_tray);
                save_settings(app, &s);
            }
            "autostart" => {
                let al = app.autolaunch();
                let _ = if autostart.is_checked().unwrap_or(false) { al.enable() } else { al.disable() };
                let _ = autostart.set_checked(al.is_enabled().unwrap_or(false));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/* --------------------------------------------------------------------- run */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch (or a zentico:// link) focuses the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_window_state::Builder::default().with_filter(|label| label == MAIN).build())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![get_launch, set_workspace, notify])
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = load_settings(&handle);
            let state = app.state::<AppState>();
            if let Some(ws) = &settings.workspace {
                // The only remote grant: native notifications for the chosen workspace origin.
                app.add_capability(
                    CapabilityBuilder::new("remote-workspace")
                        .remote(format!("{}/*", ws.origin))
                        .local(false)
                        .window("*")
                        .permission("allow-notify"),
                )?;
            }
            *state.active.lock().unwrap() = settings.workspace.clone();
            *state.settings.lock().unwrap() = settings;

            #[cfg(any(windows, target_os = "linux"))]
            if cfg!(debug_assertions) {
                // Installers register zentico:// themselves; dev runs need it done at runtime.
                let _ = app.deep_link().register_all();
            }
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for u in &urls {
                    apply_deep_link(&handle, u);
                }
            }
            let dl = handle.clone();
            app.deep_link().on_open_url(move |event| open_deep_links(&dl, event.urls()));

            let window = app_window(&handle, MAIN, WebviewUrl::App("index.html".into())).build()?;
            if std::env::args().any(|a| a == "--minimized") {
                let _ = window.hide();
            }
            build_tray(&handle)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN && window.state::<AppState>().settings.lock().unwrap().close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Zentico Workspace");
}
