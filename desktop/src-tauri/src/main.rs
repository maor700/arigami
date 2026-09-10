#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! Arigami desktop shell — one app that is EITHER this computer's own Arigami
//! or a mirror of a remote one (the VPS over Tailscale).
//!
//! The law that dictates the whole shape (docs/DESKTOP.md, decision #1): the
//! window's ORIGIN must be exactly the machine serving the API.
//! web/src/lib/hostUrl.js builds every tab and every call from
//! window.location.origin, and the auth cookie is SameSite=Lax per origin.
//! So "switching machines" is a NAVIGATION of the window to another origin —
//! never a client-side merge of two machines' data, which isn't possible at
//! all. Each machine keeps its own cookie in the app's jar, so switching is a
//! navigation and not a re-login.
//!
//! Everything in this file was compiled AND run on Linux (see docs/DESKTOP.md
//! for what is and isn't proven). macOS is still unbuilt.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

// Decision #3 (docs/DESKTOP.md): the shell IS the supervisor. This value is
// what server/host-control.ts's detectManager() recognizes as "some launcher
// is committed to relaunching us after exit(0)" — without it, the cockpit's
// restart/upgrade button gets a 409 (NoSupervisorError).
const SUPERVISOR_ENV_VALUE: &str = "self";

const MAIN_WINDOW: &str = "main";
const PICKER_WINDOW: &str = "picker";
const LOCAL_ID: &str = "local";
const LOCAL_NAME: &str = "This computer";
// The local machine keeps the brand colour; remotes get visibly different
// ones. Two machines show a byte-identical cockpit, so colour + name is the
// only thing standing between the human and running something heavy on the
// wrong box (see paint_badge()).
const LOCAL_COLOR: &str = "#F9D312";
const REMOTE_COLORS: [&str; 4] = ["#7DD3FC", "#C4B5FD", "#86EFAC", "#FCA5A5"];

/// Decision #5: the local sidecar's port. Still fixed (3099) by default — a
/// desktop app owns its own machine — but overridable so this shell can be
/// built and test-run without ever touching a live host on 3099.
fn local_port() -> u16 {
    std::env::var("ARIGAMI_DESKTOP_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3099)
}

// ---------------------------------------------------------------- machines

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Machine {
    id: String,
    name: String,
    /// scheme://host[:port], no trailing slash and no path — this IS the
    /// browser origin the window will sit on.
    origin: String,
    #[serde(default)]
    local: bool,
}

fn local_machine() -> Machine {
    Machine {
        id: LOCAL_ID.into(),
        name: LOCAL_NAME.into(),
        origin: format!("http://127.0.0.1:{}", local_port()),
        local: true,
    }
}

/// Only the remote machines and the last choice are persisted; "this
/// computer" is synthesised at runtime so its port always matches this build.
#[derive(Default, Serialize, Deserialize)]
struct StoredConfig {
    #[serde(default)]
    machines: Vec<Machine>,
    #[serde(default)]
    last: Option<String>,
}

/// "vps.tailnet.ts.net" -> https://vps.tailnet.ts.net
/// "192.168.1.5:3099"   -> http://192.168.1.5:3099
/// An explicit scheme always wins. Anything with a path/query is reduced to
/// its origin — a machine is an origin, not a URL.
fn normalize_origin(input: &str) -> Result<String, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("An address is required".into());
    }
    let with_scheme = if s.contains("://") {
        s.to_string()
    } else {
        let host_part = s.split('/').next().unwrap_or(s);
        let host = host_part.rsplit_once(':').map(|(h, _)| h).unwrap_or(host_part);
        // Tailscale/MagicDNS names are served over https by `tailscale serve`;
        // bare IPs and localhost are almost always a plain http dev host.
        let plain = host == "localhost" || host.parse::<std::net::IpAddr>().is_ok();
        format!("{}://{}", if plain { "http" } else { "https" }, s)
    };
    let u = url::Url::parse(&with_scheme).map_err(|e| format!("Invalid address: {e}"))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err("Only http or https".into());
    }
    let host = u.host_str().ok_or_else(|| "The address has no host name".to_string())?;
    let mut origin = format!("{}://{}", u.scheme(), host);
    if let Some(p) = u.port() {
        origin.push_str(&format!(":{p}"));
    }
    Ok(origin)
}

fn host_url(origin: &str) -> String {
    format!("{origin}/__host/")
}

fn window_title(m: &Machine) -> String {
    if m.local {
        format!("Arigami — {} (local)", m.name)
    } else {
        format!("Arigami — {} (remote)", m.name)
    }
}

// ------------------------------------------------------------------ state

struct WinState {
    machine: Machine,
    /// "connecting" | "ready" | "error"
    phase: String,
    message: String,
    /// Bumped on every switch so a slow connect thread that lost the race
    /// can't navigate the window out from under a newer choice.
    generation: u64,
    /// This window's own local page (tauri://localhost/index.html), captured
    /// at creation instead of reconstructed per-platform.
    shell_url: String,
    /// True while the window shows a page of OURS. The navigation guard uses
    /// it to refuse any attempt by a machine origin to walk itself back into
    /// the app scheme (where capabilities/default.json would hand it IPC).
    local_page: Arc<AtomicBool>,
}

struct Shell {
    cfg_path: PathBuf,
    cfg: Mutex<StoredConfig>,
    windows: Mutex<HashMap<String, WinState>>,
    local_pid: Mutex<Option<u32>>,
    /// The local sidecar runs only while some window is actually pointed at
    /// it. Every `claude` is 300MB+; a local server nobody is looking at is
    /// real waste, not an aesthetic one.
    local_wanted: AtomicBool,
    local_error: Mutex<Option<String>>,
    quitting: Arc<AtomicBool>,
    /// One quit dialog at a time. A single Cmd/Ctrl+Q produced TWO stacked
    /// confirmation dialogs, every time: the app-level on_menu_event and the
    /// tray's own on_menu_event both fire for the same menu id (they are both
    /// global listeners, not per-menu), so handle_menu ran twice. Both
    /// registrations are kept — the tray path can't be exercised here to
    /// prove which one is redundant — and the destructive action is made
    /// idempotent instead.
    asking_quit: AtomicBool,
    seq: AtomicU64,
    tray: Mutex<Option<TrayIcon<Wry>>>,
    /// What the menus and the tray currently SAY. refresh_chrome() is called
    /// on every focus change, so without this the whole app menu (and its
    /// accelerators) got rebuilt every time a window was clicked — on macOS
    /// that is the application menu, rebuilt under the user's cursor.
    chrome_sig: Mutex<String>,
    /// Which machine window the picker / menu / shortcut acts on.
    focused: Mutex<String>,
    win_seq: AtomicU64,
}

impl Shell {
    fn all_machines(&self) -> Vec<Machine> {
        let mut v = vec![local_machine()];
        v.extend(self.cfg.lock().unwrap().machines.iter().cloned());
        v
    }
    fn find(&self, id: &str) -> Option<Machine> {
        self.all_machines().into_iter().find(|m| m.id == id)
    }
    fn color_of(&self, id: &str) -> String {
        if id == LOCAL_ID {
            return LOCAL_COLOR.into();
        }
        match self.all_machines().iter().position(|m| m.id == id) {
            Some(i) if i > 0 => REMOTE_COLORS[(i - 1) % REMOTE_COLORS.len()].into(),
            _ => "#9CA3AF".into(),
        }
    }
    fn save(&self) {
        if let Some(dir) = self.cfg_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let cfg = self.cfg.lock().unwrap();
        if let Ok(txt) = serde_json::to_string_pretty(&*cfg) {
            let _ = std::fs::write(&self.cfg_path, txt);
        }
    }
    fn machine_of(&self, label: &str) -> Option<Machine> {
        self.windows.lock().unwrap().get(label).map(|w| w.machine.clone())
    }
    /// The machine window the menu/tray/picker should act on: the last one
    /// focused, falling back to main.
    fn target_label(&self) -> String {
        let f = self.focused.lock().unwrap().clone();
        if self.windows.lock().unwrap().contains_key(&f) {
            f
        } else {
            MAIN_WINDOW.into()
        }
    }
}

fn recompute_local_wanted(shell: &Shell) {
    let wanted = shell.windows.lock().unwrap().values().any(|w| w.machine.local);
    shell.local_wanted.store(wanted, Ordering::SeqCst);
}

// ------------------------------------------------------------- the sidecar

fn resolve_server_binary(app: &AppHandle) -> Option<PathBuf> {
    let base = app.path().resource_dir().ok()?.join("resources-staged");
    let name = if cfg!(windows) { "arigami-server.exe" } else { "arigami-server" };
    Some(base.join(name))
}

fn log_path(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_log_dir().unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    dir.join("arigami-server.log")
}

fn open_log_file(app: &AppHandle) -> Stdio {
    match std::fs::OpenOptions::new().create(true).append(true).open(log_path(app)) {
        Ok(f) => Stdio::from(f),
        Err(_) => Stdio::null(),
    }
}

fn spawn_server(app: &AppHandle) -> std::io::Result<Child> {
    let bin = resolve_server_binary(app).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "could not resolve resource_dir()")
    })?;
    Command::new(&bin)
        .env("ARIGAMI_SUPERVISOR", SUPERVISOR_ENV_VALUE)
        .env("ARIGAMI_PORT", local_port().to_string())
        .stdin(Stdio::null())
        .stdout(open_log_file(app))
        .stderr(open_log_file(app))
        .spawn()
}

/// server/index.ts's shutdown() (which calls killAll() on every active
/// session) only runs on SIGTERM/SIGINT/SIGBREAK/SIGHUP — never on SIGKILL,
/// which is what std::process::Child::kill() sends on Unix.
fn terminate(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
}

/// SIGTERM, then wait — but not forever: a sidecar wedged in shutdown must
/// not wedge a machine switch, so it gets 8s and then SIGKILL.
fn stop_child(child: &mut Child) {
    terminate(child.id());
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

// ------------------------------------------------------------------ probes

fn resolve_addr(host: &str, port: u16) -> Option<SocketAddr> {
    (host, port).to_socket_addrs().ok()?.next()
}

/// Hand-rolled HTTP/1.1 GET — this shell makes a handful of requests ever, so
/// an HTTP client crate isn't worth the surface. Returns the status code.
fn http_status(mut stream: TcpStream, host: &str, port: u16, path: &str) -> Option<u16> {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2500)));
    let req =
        format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let line = text.lines().next()?;
    line.split_whitespace().nth(1)?.parse::<u16>().ok()
}

/// Is this machine actually there?
///
/// http origins get a real GET of /__api/config. https origins get a TCP
/// connect only — there is no TLS client in this shell (see docs/DESKTOP.md
/// for why), so "the port accepts connections" is as far as the check goes;
/// a reachable host running something else would still get navigated to.
fn probe(origin: &str, require_ok: bool) -> Result<(), String> {
    let u = url::Url::parse(origin).map_err(|e| format!("Invalid address: {e}"))?;
    let https = u.scheme() == "https";
    let host = u
        .host_str()
        .ok_or_else(|| "The address has no host name".to_string())?
        .to_string();
    let port = u.port().unwrap_or(if https { 443 } else { 80 });
    let addr = resolve_addr(&host, port)
        .ok_or_else(|| format!("Couldn't resolve {host} to an address — is Tailscale connected?"))?;
    let stream = TcpStream::connect_timeout(&addr, Duration::from_millis(3000))
        .map_err(|_| format!("No answer from {host}:{port} — the machine is off or Tailscale is disconnected"))?;
    if https {
        return Ok(());
    }
    let code = http_status(stream, &host, port, "/__api/config")
        .ok_or_else(|| format!("{host}:{port} answered, but not as an HTTP server"))?;
    if require_ok && code != 200 {
        return Err(format!("The server answered {code} instead of 200"));
    }
    Ok(())
}

fn busy_sessions(origin: &str) -> u32 {
    let Ok(u) = url::Url::parse(origin) else { return 0 };
    if u.scheme() != "http" {
        return 0;
    }
    let Some(host) = u.host_str() else { return 0 };
    let port = u.port().unwrap_or(80);
    let Some(addr) = resolve_addr(host, port) else { return 0 };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(1500)) else {
        return 0;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let req = format!("GET /__health HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return 0;
    }
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let Some(i) = text.find("\"busySessions\":") else { return 0 };
    text[i + 15..]
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .unwrap_or(0)
}

// -------------------------------------------------------------- supervisor

/// Runs for the whole life of the app and follows `local_wanted`: spawn the
/// sidecar when some window is on "this computer", stop it when the last one
/// leaves, respawn it when it exits on its own (restart/upgrade/crash).
/// try_wait() rather than wait() so a stop request is never blocked behind a
/// still-running child. Still no crash-loop backoff — see docs/DESKTOP.md.
fn run_supervisor(app: AppHandle, shell: Arc<Shell>) {
    let mut child: Option<Child> = None;
    loop {
        if shell.quitting.load(Ordering::SeqCst) {
            if let Some(mut c) = child.take() {
                stop_child(&mut c);
            }
            *shell.local_pid.lock().unwrap() = None;
            return;
        }
        let want = shell.local_wanted.load(Ordering::SeqCst);
        match (child.is_some(), want) {
            (true, false) => {
                let mut c = child.take().unwrap();
                stop_child(&mut c);
                *shell.local_pid.lock().unwrap() = None;
            }
            (true, true) => {
                let exited = matches!(child.as_mut().unwrap().try_wait(), Ok(Some(_)));
                if exited {
                    child = None;
                    *shell.local_pid.lock().unwrap() = None;
                }
            }
            (false, true) => match spawn_server(&app) {
                Ok(c) => {
                    *shell.local_pid.lock().unwrap() = Some(c.id());
                    *shell.local_error.lock().unwrap() = None;
                    child = Some(c);
                }
                Err(e) => {
                    *shell.local_error.lock().unwrap() = Some(format!(
                        "Couldn't start the local Arigami server: {e}\nLog: {}",
                        log_path(&app).display()
                    ));
                    std::thread::sleep(Duration::from_secs(2));
                }
            },
            (false, false) => {}
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn wait_local_ready(shell: &Arc<Shell>, origin: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(err) = shell.local_error.lock().unwrap().clone() {
            return Err(err);
        }
        if probe(origin, true).is_ok() {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(format!(
                "The local Arigami server didn't answer in time on {origin}. Is something else holding the port?"
            ));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

// ------------------------------------------------------------ the indicator

/// The two machines render a byte-identical cockpit. Without a marker the
/// human will one day run something heavy on the wrong one — so every machine
/// page gets a coloured strip along the top and a name pill in the corner,
/// re-applied on every page load (a server restart reloads the page) and
/// re-checked every few seconds in case the SPA wipes it.
///
/// This is one-way script injection from Rust (eval), NOT IPC: it hands the
/// page no window.__TAURI__ and no invoke. The pill says so out loud — if IPC
/// ever does leak into a machine origin, the badge shows "⚠ IPC" instead of
/// failing silently. See decision #2 in docs/DESKTOP.md.
const BADGE_JS: &str = r#"
(function(){
  try{
    if (window.top !== window.self) return;
    var NAME = __NAME__, COLOR = __COLOR__, ID = '__arigami_machine_badge__', IPC = '';
    if (window.__arigamiBadgeTimer) { clearInterval(window.__arigamiBadgeTimer); }
    var mk = function(){
      var root = document.documentElement;
      if (!root) return;
      var pill = document.getElementById(ID);
      if (!pill) {
        pill = document.createElement('div');
        pill.id = ID;
        pill.setAttribute('dir','rtl');
        root.appendChild(pill);
      }
      pill.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:2147483647;'
        + 'pointer-events:none;font:600 11px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
        + 'padding:3px 10px;border-radius:999px;background:' + COLOR + ';color:#111;'
        + 'box-shadow:0 1px 5px rgba(0,0,0,.4);opacity:.94;white-space:nowrap';
      pill.textContent = NAME + IPC;
      var strip = document.getElementById(ID + '_strip');
      if (!strip) {
        strip = document.createElement('div');
        strip.id = ID + '_strip';
        root.appendChild(strip);
      }
      strip.style.cssText = 'position:fixed;top:0;left:0;right:0;height:3px;z-index:2147483647;'
        + 'pointer-events:none;background:' + COLOR;
    };
    mk();
    // Tauri injects __TAURI_INTERNALS__ (and, with withGlobalTauri, __TAURI__)
    // into EVERY page in the webview, machine origins included — so the mere
    // presence of those objects says nothing. What decides it is whether a
    // command actually runs: the ACL rejects invoke() from an origin no
    // capability covers ("shell_status not allowed. Plugin not found",
    // observed live). So probe for real, once, and only warn if it resolves.
    var inv = (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)
           || (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
    if (inv) {
      try {
        var p = inv('shell_status');
        if (p && p.then) p.then(function(){ IPC = '  ⚠ IPC'; mk(); }, function(){});
      } catch (e) {}
    }
    window.__arigamiBadgeTimer = setInterval(mk, 3000);
  }catch(e){}
})();
"#;

fn badge_js(name: &str, color: &str) -> String {
    BADGE_JS
        .replace("__NAME__", &serde_json::to_string(name).unwrap_or_else(|_| "\"?\"".into()))
        .replace("__COLOR__", &serde_json::to_string(color).unwrap_or_else(|_| "\"#fff\"".into()))
}

// ------------------------------------------------------------- navigation

/// tauri://localhost (or http://tauri.localhost on Windows) — the app scheme,
/// where capabilities/default.json grants IPC.
fn is_app_url(u: &url::Url) -> bool {
    u.scheme() == "tauri" || matches!(u.host_str(), Some("tauri.localhost"))
}

fn nav(app: &AppHandle, label: &str, target: String, local_page: bool) {
    let app2 = app.clone();
    let label = label.to_string();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app2.get_webview_window(&label) {
            if let Some(st) = app2.state::<Arc<Shell>>().windows.lock().unwrap().get(&label) {
                st.local_page.store(local_page, Ordering::SeqCst);
            }
            if let Ok(u) = url::Url::parse(&target) {
                let _ = w.navigate(u);
            }
        }
    });
}

/// Point one window at one machine: show our own page while connecting, probe
/// (the local sidecar is started/stopped by the supervisor as a side effect
/// of local_wanted), then navigate — or park on an error the page can render
/// with a way out. Never a white screen.
fn go_to_machine(app: &AppHandle, shell: &Arc<Shell>, label: &str, machine: Machine, reset_view: bool) {
    let gen = shell.seq.fetch_add(1, Ordering::SeqCst) + 1;
    let shell_url = {
        let mut ws = shell.windows.lock().unwrap();
        let Some(w) = ws.get_mut(label) else { return };
        w.machine = machine.clone();
        w.phase = "connecting".into();
        w.message = String::new();
        w.generation = gen;
        w.shell_url.clone()
    };
    {
        let mut cfg = shell.cfg.lock().unwrap();
        cfg.last = Some(machine.id.clone());
    }
    shell.save();
    recompute_local_wanted(shell);
    if machine.local {
        *shell.local_error.lock().unwrap() = None;
    }

    let title = window_title(&machine);
    {
        let app2 = app.clone();
        let label2 = label.to_string();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app2.get_webview_window(&label2) {
                let _ = w.set_title(&title);
                // Bring it forward. The main window's [x] only HIDES it, so
                // without this a switch from the picker (or the tray) while
                // it was hidden changed the machine and showed nothing at
                // all — a dead end with no way back. Seen live.
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        });
    }
    if reset_view {
        nav(app, label, shell_url, true);
    }
    refresh_chrome(app, shell);

    let app2 = app.clone();
    let shell2 = shell.clone();
    let label2 = label.to_string();
    std::thread::spawn(move || {
        let res = if machine.local {
            wait_local_ready(&shell2, &machine.origin, Duration::from_secs(60))
        } else {
            let mut last = Err("".to_string());
            for attempt in 0..3 {
                last = probe(&machine.origin, false);
                if last.is_ok() {
                    break;
                }
                if attempt < 2 {
                    std::thread::sleep(Duration::from_millis(1200));
                }
            }
            last
        };
        // Lost the race to a newer switch? Leave the window alone.
        {
            let ws = shell2.windows.lock().unwrap();
            match ws.get(&label2) {
                Some(w) if w.generation == gen => {}
                _ => return,
            }
        }
        match res {
            Ok(()) => {
                {
                    let mut ws = shell2.windows.lock().unwrap();
                    if let Some(w) = ws.get_mut(&label2) {
                        w.phase = "ready".into();
                    }
                }
                nav(&app2, &label2, host_url(&machine.origin), false);
            }
            Err(msg) => {
                let mut ws = shell2.windows.lock().unwrap();
                if let Some(w) = ws.get_mut(&label2) {
                    w.phase = "error".into();
                    w.message = msg;
                }
            }
        }
    });
}

// ----------------------------------------------------------------- windows

fn create_machine_window(
    app: &AppHandle,
    shell: &Arc<Shell>,
    label: String,
    machine: Machine,
) -> tauri::Result<()> {
    let local_page = Arc::new(AtomicBool::new(true));

    let guard = local_page.clone();
    let shell_pl = shell.clone();
    let label_pl = label.clone();
    let shell_ev = shell.clone();
    let app_ev = app.clone();
    let label_ev = label.clone();
    let quitting = shell.quitting.clone();
    let is_main = label == MAIN_WINDOW;

    let w = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(window_title(&machine))
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        // A machine origin must never be able to walk itself into the app
        // scheme (history.back(), location.href, a link) — that origin is
        // where IPC lives. Only our own navigations set the flag.
        .on_navigation(move |u| {
            if is_app_url(u) {
                guard.load(Ordering::SeqCst)
            } else {
                true
            }
        })
        .on_page_load(move |webview, payload| {
            if !matches!(payload.event(), PageLoadEvent::Finished) || is_app_url(payload.url()) {
                return;
            }
            if let Some(m) = shell_pl.machine_of(&label_pl) {
                let js = badge_js(&m.name, &shell_pl.color_of(&m.id));
                let _ = webview.eval(&js);
            }
        })
        .build()?;

    let shell_url = w
        .url()
        .map(|u| u.to_string())
        .unwrap_or_else(|_| "tauri://localhost/index.html".into());

    let w_hide = w.clone();
    w.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            // The tray/menu quit is the only real quit for the main window —
            // [x] just hides it; the sidecar and tray live on. Extra windows
            // close for real.
            if is_main && !quitting.load(Ordering::SeqCst) {
                api.prevent_close();
                let _ = w_hide.hide();
            }
        }
        tauri::WindowEvent::Destroyed => {
            shell_ev.windows.lock().unwrap().remove(&label_ev);
            recompute_local_wanted(&shell_ev);
            refresh_chrome(&app_ev, &shell_ev);
        }
        tauri::WindowEvent::Focused(true) => {
            *shell_ev.focused.lock().unwrap() = label_ev.clone();
            refresh_chrome(&app_ev, &shell_ev);
        }
        _ => {}
    });

    shell.windows.lock().unwrap().insert(
        label.clone(),
        WinState {
            machine: machine.clone(),
            phase: "connecting".into(),
            message: String::new(),
            generation: 0,
            shell_url,
            local_page,
        },
    );
    *shell.focused.lock().unwrap() = label.clone();
    go_to_machine(app, shell, &label, machine, false);
    Ok(())
}

fn open_picker(app: &AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app2.get_webview_window(PICKER_WINDOW) {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
            return;
        }
        let _ = WebviewWindowBuilder::new(&app2, PICKER_WINDOW, WebviewUrl::App("picker.html".into()))
            .title("Machines — Arigami")
            .inner_size(560.0, 620.0)
            .min_inner_size(420.0, 420.0)
            .build();
    });
}

// ------------------------------------------------------------------- menus

fn machines_submenu(app: &AppHandle, shell: &Arc<Shell>, current: &str) -> tauri::Result<Submenu<Wry>> {
    let machines = shell.all_machines();
    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>> = Vec::new();
    for (i, m) in machines.iter().enumerate() {
        let mark = if m.id == current { "●" } else { "○" };
        let accel = if i < 9 { Some(format!("CmdOrCtrl+Alt+{}", i + 1)) } else { None };
        items.push(Box::new(MenuItem::with_id(
            app,
            format!("m:{}", m.id),
            format!("{mark}  {}", m.name),
            true,
            accel.as_deref(),
        )?));
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(
        app,
        "picker",
        "Machines…",
        true,
        Some("CmdOrCtrl+Shift+M"),
    )?));
    let refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = items.iter().map(|b| b.as_ref()).collect();
    let title = machines
        .iter()
        .find(|m| m.id == current)
        .map(|m| format!("Machine: {}", m.name))
        .unwrap_or_else(|| "Machine".into());
    Submenu::with_items(app, title, true, &refs)
}

/// The window/app menu. Deliberately not Menu::default(): every item here is
/// a cross-platform predefined item, so the exact menu that ships to macOS is
/// the one compiled and clicked on Linux. The first submenu becomes the
/// application menu on macOS, and the Edit submenu is what keeps ⌘C/⌘V alive
/// there once an app sets a custom menu at all.
fn build_app_menu(app: &AppHandle, shell: &Arc<Shell>, current: &str) -> tauri::Result<Menu<Wry>> {
    let quit = MenuItem::with_id(app, "quit", "Quit Arigami", true, Some("CmdOrCtrl+Q"))?;
    let app_menu = Submenu::with_items(
        app,
        "Arigami",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let machines = machines_submenu(app, shell, current)?;
    Menu::with_items(app, &[&app_menu, &edit, &machines])
}

fn build_tray_menu(app: &AppHandle, shell: &Arc<Shell>, current: &str) -> tauri::Result<Menu<Wry>> {
    let machines = shell.all_machines();
    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>> = Vec::new();
    for m in machines.iter() {
        let mark = if m.id == current { "●" } else { "○" };
        items.push(Box::new(MenuItem::with_id(
            app,
            format!("m:{}", m.id),
            format!("{mark}  {}", m.name),
            true,
            None::<&str>,
        )?));
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(app, "picker", "Machines…", true, None::<&str>)?));
    items.push(Box::new(MenuItem::with_id(app, "show", "Open Arigami", true, None::<&str>)?));
    items.push(Box::new(MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?));
    let refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = items.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// Rebuild everything that displays "which machine am I on" — the menu title,
/// the machine list, the tray tooltip. Called on every switch, every window
/// focus change and every edit of the machine list.
fn refresh_chrome(app: &AppHandle, shell: &Arc<Shell>) {
    let app2 = app.clone();
    let shell2 = shell.clone();
    let _ = app.run_on_main_thread(move || {
        let target = shell2.target_label();
        let cur = shell2
            .machine_of(&target)
            .map(|m| m.id)
            .unwrap_or_else(|| LOCAL_ID.into());
        let sig = format!(
            "{cur}\u{1}{}",
            shell2
                .all_machines()
                .iter()
                .map(|m| format!("{}={}", m.id, m.name))
                .collect::<Vec<_>>()
                .join("\u{2}")
        );
        {
            let mut prev = shell2.chrome_sig.lock().unwrap();
            if *prev == sig {
                return;
            }
            *prev = sig;
        }
        if let Ok(menu) = build_app_menu(&app2, &shell2, &cur) {
            let _ = app2.set_menu(menu);
        }
        if let Ok(menu) = build_tray_menu(&app2, &shell2, &cur) {
            if let Some(tray) = shell2.tray.lock().unwrap().as_ref() {
                let _ = tray.set_menu(Some(menu));
                let name = shell2.find(&cur).map(|m| m.name).unwrap_or_default();
                let _ = tray.set_tooltip(Some(format!("Arigami — {name}")));
            }
        }
    });
}

// -------------------------------------------------------------------- quit

fn quit_now(app: &AppHandle, shell: &Arc<Shell>) {
    shell.quitting.store(true, Ordering::SeqCst);
    shell.local_wanted.store(false, Ordering::SeqCst);
    if let Some(pid) = *shell.local_pid.lock().unwrap() {
        terminate(pid);
    }
    // Give the sidecar's own shutdown() (killAll) a moment before the process
    // group goes away with us.
    std::thread::sleep(Duration::from_millis(400));
    app.exit(0);
}

/// The dialog plugin's blocking_show() waits for a message from the main
/// thread — calling it ON the main thread deadlocks. Everything here runs on
/// a worker thread on purpose.
fn confirm_and_quit(app: &AppHandle, shell: &Arc<Shell>) {
    if shell.asking_quit.swap(true, Ordering::SeqCst) {
        return;
    }
    let app2 = app.clone();
    let shell2 = shell.clone();
    // Decision from the task brief: "confirm before quitting, and don't
    // downplay it" — say plainly that quitting kills every active session, don't
    // soften it into generic "quit?" copy.
    std::thread::spawn(move || {
        let extra = if shell2.local_wanted.load(Ordering::SeqCst) {
            let n = busy_sessions(&local_machine().origin);
            if n > 0 {
                format!("

There are {n} active sessions on this computer — they will be closed.")
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        let confirmed = app2
            .dialog()
            .message(format!(
                "Quitting shuts down the local Arigami server and ends every active session on it.{extra}\n\nContinue?"
            ))
            .title("Quit Arigami")
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show();
        shell2.asking_quit.store(false, Ordering::SeqCst);
        if confirmed {
            quit_now(&app2, &shell2);
        }
    });
}

// ---------------------------------------------------------------- commands

#[derive(Serialize)]
struct MachineView {
    id: String,
    name: String,
    origin: String,
    local: bool,
    color: String,
    current: bool,
    open_in: Vec<String>,
}

fn machine_views(shell: &Arc<Shell>, current: &str) -> Vec<MachineView> {
    let open: HashMap<String, Vec<String>> = {
        let ws = shell.windows.lock().unwrap();
        let mut m: HashMap<String, Vec<String>> = HashMap::new();
        for (label, st) in ws.iter() {
            m.entry(st.machine.id.clone()).or_default().push(label.clone());
        }
        m
    };
    shell
        .all_machines()
        .iter()
        .map(|m| MachineView {
            id: m.id.clone(),
            name: m.name.clone(),
            origin: m.origin.clone(),
            local: m.local,
            color: shell.color_of(&m.id),
            current: m.id == current,
            open_in: open.get(&m.id).cloned().unwrap_or_default(),
        })
        .collect()
}

fn target_of(window: &tauri::Window, shell: &Arc<Shell>) -> String {
    if window.label() == PICKER_WINDOW {
        shell.target_label()
    } else {
        window.label().to_string()
    }
}

#[tauri::command]
fn shell_status(window: tauri::Window, state: State<'_, Arc<Shell>>) -> serde_json::Value {
    let shell = state.inner().clone();
    let target = target_of(&window, &shell);
    let (machine, phase, message) = {
        let ws = shell.windows.lock().unwrap();
        match ws.get(&target) {
            Some(w) => (Some(w.machine.clone()), w.phase.clone(), w.message.clone()),
            None => (None, "connecting".into(), String::new()),
        }
    };
    let cur_id = machine.as_ref().map(|m| m.id.clone()).unwrap_or_default();
    serde_json::json!({
        "role": if window.label() == PICKER_WINDOW { "picker" } else { "machine" },
        "label": window.label(),
        "target": target,
        "phase": phase,
        "message": message,
        "machine": machine.as_ref().map(|m| serde_json::json!({
            "id": m.id, "name": m.name, "origin": m.origin, "local": m.local,
            "color": shell.color_of(&m.id),
        })),
        "machines": machine_views(&shell, &cur_id),
    })
}

#[tauri::command]
fn switch_machine(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, Arc<Shell>>,
    id: String,
) -> Result<(), String> {
    let shell = state.inner().clone();
    let target = target_of(&window, &shell);
    let machine = shell.find(&id).ok_or_else(|| "No such machine".to_string())?;
    let current = shell.machine_of(&target);
    if current.as_ref().map(|m| m.id.clone()).as_deref() == Some(id.as_str()) {
        // Already there: don't reload the cockpit, but do surface the window —
        // this is the only "bring it back" the picker has when the main
        // window is hidden.
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app2.get_webview_window(&target) {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        });
        return Ok(());
    }
    // Is this switch the thing that turns the local server off? Say so before
    // it takes live sessions down with it.
    let leaving_local = current.as_ref().map(|m| m.local).unwrap_or(false)
        && !machine.local
        && shell
            .windows
            .lock()
            .unwrap()
            .iter()
            .filter(|(l, _)| l.as_str() != target)
            .all(|(_, w)| !w.machine.local);
    std::thread::spawn(move || {
        if leaving_local {
            let n = busy_sessions(&local_machine().origin);
            if n > 0 {
                let ok = app
                    .dialog()
                    .message(format!(
                        "Switching to {} shuts down the local server — {n} active sessions on it will be closed.\n\nContinue?",
                        machine.name
                    ))
                    .title("Switch machine")
                    .buttons(MessageDialogButtons::OkCancel)
                    .blocking_show();
                if !ok {
                    return;
                }
            }
        }
        let shell = app.state::<Arc<Shell>>().inner().clone();
        go_to_machine(&app, &shell, &target, machine, true);
    });
    Ok(())
}

#[tauri::command]
fn add_machine(
    app: AppHandle,
    state: State<'_, Arc<Shell>>,
    name: String,
    address: String,
) -> Result<String, String> {
    let shell = state.inner().clone();
    let origin = normalize_origin(&address)?;
    if shell.all_machines().iter().any(|m| m.origin == origin) {
        return Err("This machine is already in the list".into());
    }
    let name = {
        let n = name.trim();
        if n.is_empty() {
            url::Url::parse(&origin)
                .ok()
                .and_then(|u| u.host_str().map(|h| h.to_string()))
                .unwrap_or_else(|| origin.clone())
        } else {
            n.to_string()
        }
    };
    let id = format!(
        "m{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    shell.cfg.lock().unwrap().machines.push(Machine {
        id: id.clone(),
        name,
        origin,
        local: false,
    });
    shell.save();
    refresh_chrome(&app, &shell);
    Ok(id)
}

#[tauri::command]
fn forget_machine(app: AppHandle, state: State<'_, Arc<Shell>>, id: String) -> Result<(), String> {
    let shell = state.inner().clone();
    if id == LOCAL_ID {
        return Err("This computer can't be removed".into());
    }
    if shell.windows.lock().unwrap().values().any(|w| w.machine.id == id) {
        return Err("The machine is open in a window — switch to another machine first".into());
    }
    shell.cfg.lock().unwrap().machines.retain(|m| m.id != id);
    shell.save();
    refresh_chrome(&app, &shell);
    Ok(())
}

#[tauri::command]
fn open_new_window(app: AppHandle, state: State<'_, Arc<Shell>>, id: String) -> Result<(), String> {
    let shell = state.inner().clone();
    let machine = shell.find(&id).ok_or_else(|| "No such machine".to_string())?;
    let label = format!("machine-{}", shell.win_seq.fetch_add(1, Ordering::SeqCst) + 2);
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let shell = app2.state::<Arc<Shell>>().inner().clone();
        if let Err(e) = create_machine_window(&app2, &shell, label, machine) {
            eprintln!("[arigami-desktop] could not open window: {e}");
        }
    });
    Ok(())
}

#[tauri::command]
fn retry_connect(app: AppHandle, window: tauri::Window, state: State<'_, Arc<Shell>>) {
    let shell = state.inner().clone();
    let target = target_of(&window, &shell);
    if let Some(m) = shell.machine_of(&target) {
        go_to_machine(&app, &shell, &target, m, true);
    }
}

#[tauri::command]
fn show_picker(app: AppHandle) {
    open_picker(&app);
}

#[tauri::command]
fn close_window(window: tauri::Window) {
    let _ = window.close();
}

// -------------------------------------------------------------------- main

fn handle_menu(app: &AppHandle, id: &str) {
    let shell = app.state::<Arc<Shell>>().inner().clone();
    if let Some(mid) = id.strip_prefix("m:") {
        let target = shell.target_label();
        if let Some(m) = shell.find(mid) {
            if shell.machine_of(&target).map(|c| c.id) == Some(m.id.clone()) {
                return;
            }
            let app2 = app.clone();
            let shell2 = shell.clone();
            std::thread::spawn(move || {
                go_to_machine(&app2, &shell2, &target, m, true);
            });
        }
        return;
    }
    match id {
        "picker" => open_picker(app),
        "show" => {
            if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
        "quit" => confirm_and_quit(app, &shell),
        _ => {}
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            shell_status,
            switch_machine,
            add_machine,
            forget_machine,
            open_new_window,
            retry_connect,
            show_picker,
            close_window
        ])
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .setup(|app| {
            let handle = app.handle().clone();

            let cfg_path = handle
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("machines.json");
            let cfg: StoredConfig = std::fs::read_to_string(&cfg_path)
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default();

            let shell = Arc::new(Shell {
                cfg_path,
                cfg: Mutex::new(cfg),
                windows: Mutex::new(HashMap::new()),
                local_pid: Mutex::new(None),
                local_wanted: AtomicBool::new(false),
                local_error: Mutex::new(None),
                quitting: Arc::new(AtomicBool::new(false)),
                asking_quit: AtomicBool::new(false),
                seq: AtomicU64::new(0),
                tray: Mutex::new(None),
                chrome_sig: Mutex::new(String::new()),
                focused: Mutex::new(MAIN_WINDOW.into()),
                win_seq: AtomicU64::new(0),
            });
            app.manage(shell.clone());

            // Remember the machine we were on; fall back to this computer if
            // it was forgotten in the meantime.
            // The remembered id is read into its own binding FIRST, on
            // purpose. Chaining `.and_then(|id| shell.find(&id))` straight
            // off `cfg.lock().unwrap()` keeps that temporary guard alive for
            // the whole statement, and find() -> all_machines() locks `cfg`
            // again — std::sync::Mutex is not reentrant, so setup() hung on a
            // futex here, forever, on every launch that had a remembered
            // machine (i.e. every launch after the first, since save() always
            // writes `last`). Found by running it; it compiles fine.
            let last_id = shell.cfg.lock().unwrap().last.clone();
            let start = last_id
                .and_then(|id| shell.find(&id))
                .unwrap_or_else(local_machine);

            let tray = TrayIconBuilder::new()
                .menu(&build_tray_menu(&handle, &shell, &start.id)?)
                .icon(app.default_window_icon().cloned().ok_or("no default window icon")?)
                .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
                .build(app)?;
            *shell.tray.lock().unwrap() = Some(tray);

            create_machine_window(&handle, &shell, MAIN_WINDOW.into(), start)?;

            {
                let handle = handle.clone();
                let shell = shell.clone();
                std::thread::spawn(move || run_supervisor(handle, shell));
            }

            // SIGTERM/SIGINT straight to this process (shutdown, `kill`) has
            // no handler otherwise — found live: it orphaned the sidecar. No
            // confirmation here on purpose; a signal handler must act now.
            {
                let handle = handle.clone();
                let shell = shell.clone();
                let _ = ctrlc::set_handler(move || {
                    quit_now(&handle, &shell);
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running arigami-desktop");
}
