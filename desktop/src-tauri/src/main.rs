// Arigami desktop shell. Built and run for real on Linux, on Windows 11 and
// on macOS (Apple Silicon) — see docs/DESKTOP.md. The Tauri v2 API calls
// below are compiler-checked and were exercised live, so they are no longer
// the first suspects when something misbehaves. Still unexercised on macOS
// specifically: the tray (NSStatusItem), the app menu and multi-window
// switching — the macOS run proved boot, handoff sign-in and shutdown only.
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
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;

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

// The machine chip's click channel. Decision #2 forbids IPC to a machine
// origin, so the chip cannot `invoke()` — instead it navigates the window to
// this same-origin path, `on_navigation` recognises it, cancels the
// navigation and opens the machines window. Nothing is ever fetched. The
// path is under a `__arigami-shell/` prefix the server does not route, so if
// a cancel were ever missed the worst case is a 404 — and `on_page_load`
// catches that too and puts the window back.
const MACHINES_SENTINEL_PATH: &str = "/__arigami-shell/machines";

const MAIN_WINDOW: &str = "main";
const PICKER_WINDOW: &str = "picker";
const LOCAL_ID: &str = "local";
const LOCAL_NAME: &str = "המחשב הזה";
// The local machine keeps the brand colour; remotes get visibly different
// ones. Two machines show a byte-identical cockpit, so colour + name is the
// only thing standing between the human and running something heavy on the
// wrong box (see paint_badge()).
const LOCAL_COLOR: &str = "#F9D312";
const REMOTE_COLORS: [&str; 4] = ["#7DD3FC", "#C4B5FD", "#86EFAC", "#FCA5A5"];

// Decision #5 (REVISED): the desktop app is its own INSTANCE, not a second
// copy of the `~/.arigami` one.
//
// It used to hardcode :3099 and share `~/.arigami` with whatever `bin/host`
// the user runs. That is the same identity twice, and hostlock.ts correctly
// refuses it — which in practice meant the app simply could not start on a
// machine where the host was already running. Giving it only a different
// PORT does not fix that: judgeHostInfo() lets a differing port through, but
// then warns "two hosts sharing one dir share state.json/chat and is
// unsupported". Sharing state is the actual hazard, not the port.
//
// So the app gets its own dir AND its own port, which is exactly the
// convention the rest of the system already uses: server/lib/config.ts says a
// non-default ARIGAMI_DIR "also shifts every default port range (+1000) so a
// second instance started with no config at all doesn't fight the first one
// for ports", and bin/host encodes the same rule (`[ "$DIR" != "$HOME/.arigami" ]
// && PORT=4099`). We follow it rather than inventing a number.
//
// Deliberately NOT auto-probing for a free port: launching the app twice
// would then start a SECOND host sharing ~/.arigami-desktop on some other
// port — precisely the unsupported shared-state case above. A fixed port tied
// to a fixed dir means the second launch is refused, which is correct.
//
// Both are overridable by env for anyone who wants a different layout.
const DEFAULT_PORT: u16 = 4099;
const DESKTOP_DIR_NAME: &str = ".arigami-desktop";

/// The port this app's sidecar binds and this window points at. `ARIGAMI_PORT`
/// wins; otherwise DEFAULT_PORT. Resolved once — env can't change under us.
fn arigami_port() -> u16 {
    static PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
    *PORT.get_or_init(|| {
        std::env::var("ARIGAMI_PORT")
            .ok()
            .and_then(|v| v.trim().parse::<u16>().ok())
            .filter(|p| *p != 0)
            .unwrap_or(DEFAULT_PORT)
    })
}

/// This instance's ARIGAMI_DIR. `ARIGAMI_DIR` env wins; otherwise
/// `<home>/.arigami-desktop` — deliberately NOT `~/.arigami`, so the app never
/// shares state with a `bin/host` checkout.
fn arigami_dir(app: &AppHandle) -> PathBuf {
    if let Ok(d) = std::env::var("ARIGAMI_DIR") {
        let d = d.trim().to_string();
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    app.path()
        .home_dir()
        .map(|h| h.join(DESKTOP_DIR_NAME))
        .unwrap_or_else(|_| PathBuf::from(DESKTOP_DIR_NAME))
}

// CREATE_NO_WINDOW. `arigami-server` is a console-subsystem binary (that is
// what `bun build --compile` emits), and Rust's Command on Windows gives a
// console child its own console WINDOW. One flash at startup would be ugly
// enough; combined with the respawn loop below it was a genuine bug report:
// launching the app while a `bin/host` already owned :3099 popped a fresh
// console window twice a second, without end. Linux never showed this —
// there is no console to pop — so it only surfaced once a human ran the
// Windows build.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Crash-loop guard. A sidecar that stays up at least this long counts as a
// real boot, so an ordinary restart/upgrade cycle resets the counter; exiting
// faster than this, this many times in a row, means it is never coming up and
// respawning again just burns CPU.
const HEALTHY_RUN: Duration = Duration::from_secs(10);
const MAX_FAST_EXITS: u32 = 5;

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
        origin: format!("http://127.0.0.1:{}", arigami_port()),
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
        return Err("צריך כתובת".into());
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
    let u = url::Url::parse(&with_scheme).map_err(|e| format!("כתובת לא תקינה: {e}"))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err("רק http או https".into());
    }
    let host = u.host_str().ok_or_else(|| "חסר שם מארח בכתובת".to_string())?;
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
        format!("Arigami — {} (מקומי)", m.name)
    } else {
        format!("Arigami — {} (מרוחק)", m.name)
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
    /// Set by run_supervisor() when it refuses to keep trying: the port is
    /// held by something that is not our child, or the sidecar crash-looped.
    /// Lives here rather than inside the loop so the shell page's "try again"
    /// (retry_connect → go_to_machine) can clear it — with one machine there
    /// is no "switch away and back" to fall back on.
    local_blocked: AtomicBool,
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
    let mut cmd = Command::new(&bin);
    // Decision #3: commit to relaunching after exit(0) (restart/upgrade).
    let dir = arigami_dir(app);
    // The sidecar creates this itself on boot, but doing it here means a
    // failure to create it surfaces as a spawn error rather than a silent
    // fallback to some other directory.
    let _ = std::fs::create_dir_all(&dir);
    cmd.env("ARIGAMI_SUPERVISOR", SUPERVISOR_ENV_VALUE)
        .env("ARIGAMI_PORT", arigami_port().to_string())
        .env("ARIGAMI_DIR", &dir)
        .stdin(Stdio::null())
        .stdout(open_log_file(app))
        .stderr(open_log_file(app));

    // No pairing code on this machine — WITHOUT disarming auth for everyone.
    //
    // Pairing exists to stop a stranger on the network reaching the host, and
    // docs/AUTH.md states the premise: "possession of the code == possession
    // of the host's filesystem". Whoever double-clicked this app already has
    // the filesystem, so the code proves nothing HERE. It is also physically
    // unreachable: it is printed next to the listen line and written to
    // run/pairing-code, and an installed .exe/.msi gives the user no terminal
    // — pairing became a dead end at the first screen.
    //
    // The obvious fix, ARIGAMI_AUTH=off, is the wrong trade: the gate has no
    // notion of a request's origin (auth.ts's principal() returns {kind:'off'}
    // for EVERY request), so it also admits any second device that can reach
    // the port. Loopback bind is not the protection it looks like — the
    // supported way to reach a host remotely is `tailscale serve`, which
    // forwards TO loopback, so validateAuthBind() still passes while the
    // tailnet gets in unauthenticated. index.ts:382 warns exactly this.
    //
    // So auth stays at its default (`pairing`) and only THIS window is let in,
    // via server/handoff.ts — a mechanism already in the codebase for the same
    // problem in a different shape ("the code it would ask for lives inside a
    // pod the user cannot open a shell on"). It is threat-modelled there:
    // single-use via jti, a 10-minute ceiling enforced by the verifier, and
    // entirely inert unless ARIGAMI_HANDOFF_SECRET is set.
    //
    // The secret is random per app run and never touches disk — the only two
    // parties that need it are this process and the child it just spawned. If
    // the OS gives us no randomness we simply don't set it, and the user gets
    // the ordinary pairing screen rather than a weak key.
    if let Some(secret) = handoff_secret() {
        cmd.env("ARIGAMI_HANDOFF_SECRET", secret);
    }
    // Keep the console-subsystem sidecar from opening a window of its own.
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.spawn()
}

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// This run's handoff secret, or None when the OS gave us no randomness (in
/// which case handoff stays off and pairing behaves normally). 32 random bytes
/// base64url'd is 43 chars — well past handoff.ts's 16-char minimum.
fn handoff_secret() -> Option<&'static str> {
    static SECRET: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    SECRET
        .get_or_init(|| {
            let mut buf = [0u8; 32];
            getrandom::getrandom(&mut buf).ok().map(|_| B64.encode(buf))
        })
        .as_deref()
}

/// The identity the local window signs in as. handoff.ts requires something
/// email-shaped (`/^[^@\s]+@[^@\s]+$/`), so the OS username is stripped to
/// characters that cannot break either that regex or the JSON below.
fn local_email() -> String {
    let raw = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default();
    let user: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '_' || *c == '-')
        .collect();
    let user = if user.is_empty() { "desktop".to_string() } else { user.to_lowercase() };
    format!("{user}@desktop.local")
}

/// Mint a token in server/handoff.ts's exact wire format:
///   base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, payloadB64))
/// Note base64url here is NO-PAD, matching Node's 'base64url' encoding — a
/// padded encoder would fail the signature comparison.
fn mint_handoff(secret: &str) -> Option<String> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    // 2 minutes: this is minted immediately before we navigate to it. The
    // verifier caps anything over 10 regardless of what we ask for.
    let exp = now_ms + 2 * 60_000;
    let mut jti_raw = [0u8; 12];
    getrandom::getrandom(&mut jti_raw).ok()?;
    let jti = B64.encode(jti_raw);
    // Hand-built rather than pulling in serde: every value here is either a
    // number or already restricted to characters that need no JSON escaping.
    let payload = format!(
        "{{\"kind\":\"handoff\",\"email\":\"{}\",\"exp\":{},\"jti\":\"{}\"}}",
        local_email(),
        exp,
        jti
    );
    let p = B64.encode(payload);
    let mut mac = <Hmac<Sha256>>::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(p.as_bytes());
    let sig = B64.encode(mac.finalize().into_bytes());
    Some(format!("{p}.{sig}"))
}

/// Where the window should land on first boot: the handoff URL when we can
/// mint one (endpoint sets the cookie, then 302s to /__host/), else the plain
/// cockpit — which shows the pairing screen, the honest fallback.
fn first_boot_url() -> String {
    handoff_secret()
        .and_then(mint_handoff)
        .map(|t| format!("http://127.0.0.1:{}/__api/auth/handoff?t={}", arigami_port(), t))
        .unwrap_or_else(|| host_url(&local_machine().origin))
}

/// Someone else is already serving our port. Split out from
/// crash_loop_message() because this one is detected BEFORE we spawn anything,
/// so it can say plainly what to do instead of talking about exits.
fn port_taken_message() -> String {
    format!(
        "Arigami is already running on port {port}.{nl}{nl}This is usually a second copy of this app, or a `bin/host` started from a checkout with the same ARIGAMI_DIR. Close that one first, then reopen Arigami.",
        port = arigami_port(),
        nl = "\n"
    )
}

/// Why the sidecar will not stay up, in words a user can act on. The port
/// answering while OUR child keeps dying is the tell for the common case: a
/// `bin/host` checkout, a Docker container, or a second copy of this app
/// already owns it, and hostlock.ts is correctly refusing to run twice.
fn crash_loop_message(app: &AppHandle) -> String {
    let log_hint = app
        .path()
        .app_log_dir()
        .map(|d| d.join("arigami-server.log").display().to_string())
        .unwrap_or_else(|_| "arigami-server.log (log dir unknown)".into());
    if config_endpoint_ready() {
        format!(
            "Port {port} is already served by another Arigami host — most likely a second copy of this app, since this one uses its own directory.{nl}{nl}Close that one first, then reopen Arigami.{nl}{nl}Details: {log_hint}",
            port = arigami_port(),
            nl = "\n"
        )
    } else {
        format!(
            "The Arigami server kept exiting right after start.{0}{0}Check the log:{0}{log_hint}",
            "\n"
        )
    }
}

/// Decision #4: hand-rolled HTTP/1.1 GET over a raw TcpStream instead of
/// pulling in an HTTP client crate — this app makes exactly one request ever,
/// so a dependency for it isn't worth the extra unverified surface. A 2xx-ish
/// "HTTP/1.1 200" status line is treated as ready; anything else (connection
/// refused, timeout, non-200) is not.
fn config_endpoint_ready() -> bool {
    let addr = match format!("127.0.0.1:{}", arigami_port())
        .parse::<std::net::SocketAddr>()
    {
        Ok(a) => a,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let req = format!(
        "GET /__api/config HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
        arigami_port()
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    if stream.read_to_end(&mut buf).is_err() {
        return false;
    }
    let text = String::from_utf8_lossy(&buf);
    text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200")
}


/// Decision #3, the graceful half: server/index.ts's shutdown() (which calls
/// killAll() on every active session) only runs on SIGTERM/SIGINT/SIGBREAK/
/// SIGHUP — never on SIGKILL. std::process::Child::kill() sends SIGKILL on
/// Unix, so it would skip that handler entirely; libc::kill(pid, SIGTERM) is
/// used instead. Windows has no SIGTERM/SIGBREAK equivalent reachable without
/// FFI I can't verify here (see docs/DESKTOP.md) — taskkill /F is a
/// deliberately honest fallback: it guarantees no orphaned process (unlike
/// leaving it undone), but it does NOT run killAll(), same as any other
/// `taskkill /F` today per the comment in server/index.ts.
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
fn http_get(mut stream: TcpStream, host: &str, port: u16, path: &str) -> Option<(u16, String)> {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2500)));
    let req =
        format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf).to_string();
    let code = text.lines().next()?.split_whitespace().nth(1)?.parse::<u16>().ok()?;
    // Headers end at the first blank line; everything after is the body.
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default();
    Some((code, body))
}

fn http_status(stream: TcpStream, host: &str, port: u16, path: &str) -> Option<u16> {
    http_get(stream, host, port, path).map(|(code, _)| code)
}

/// Is this machine actually there?
///
/// http origins get a real GET of /__api/config. https origins get a TCP
/// connect only — there is no TLS client in this shell (see docs/DESKTOP.md
/// for why), so "the port accepts connections" is as far as the check goes;
/// a reachable host running something else would still get navigated to.
/// Is this origin actually an Arigami host? `add_machine()` used to take any
/// address at all, so a typo — or any website — became a "machine" that the
/// window would then navigate to. `/__api/config` is the cheapest positive
/// proof: it is public (no cookie needed, verified against a live host) and
/// its body names the two fields below, which no unrelated site returns.
///
/// http goes over the raw TcpStream this file already uses. https cannot —
/// there is no TLS client here, and decision #4's "no HTTP crate for one
/// request" stops being true the moment we need a real body — so it shells
/// out to `curl`, which ships with macOS and with Windows 10+. If curl is
/// missing the add is refused rather than silently allowed: an unverified
/// machine is the thing being fixed.
fn verify_arigami(origin: &str) -> Result<(), String> {
    let u = url::Url::parse(origin).map_err(|e| format!("כתובת לא תקינה: {e}"))?;
    let https = u.scheme() == "https";
    let host = u
        .host_str()
        .ok_or_else(|| "חסר שם מארח בכתובת".to_string())?
        .to_string();
    let port = u.port().unwrap_or(if https { 443 } else { 80 });

    let body = if https {
        let out = Command::new("curl")
            .args([
                "-fsS",
                "--max-time",
                "6",
                &format!("{origin}/__api/config"),
            ])
            .output()
            .map_err(|_| {
                "לא הצלחתי לבדוק כתובת https — curl לא זמין על המכונה הזאת".to_string()
            })?;
        if !out.status.success() {
            return Err(format!("אין מענה מ־{host} או שהוא ענה בשגיאה"));
        }
        String::from_utf8_lossy(&out.stdout).to_string()
    } else {
        let addr = resolve_addr(&host, port)
            .ok_or_else(|| format!("לא הצלחתי לתרגם את {host} לכתובת — Tailscale מחובר?"))?;
        let stream = TcpStream::connect_timeout(&addr, Duration::from_millis(3000))
            .map_err(|_| format!("אין מענה מ־{host}:{port}"))?;
        let (code, body) = http_get(stream, &host, port, "/__api/config")
            .ok_or_else(|| format!("{host}:{port} ענה, אבל לא כשרת HTTP"))?;
        if code != 200 {
            return Err(format!("השרת ענה {code} ולא 200"));
        }
        body
    };

    if body.contains("\"authMode\"") && body.contains("\"version\"") {
        Ok(())
    } else {
        Err(format!("{host} עונה, אבל זה לא שרת Arigami"))
    }
}

fn probe(origin: &str, require_ok: bool) -> Result<(), String> {
    let u = url::Url::parse(origin).map_err(|e| format!("כתובת לא תקינה: {e}"))?;
    let https = u.scheme() == "https";
    let host = u
        .host_str()
        .ok_or_else(|| "חסר שם מארח בכתובת".to_string())?
        .to_string();
    let port = u.port().unwrap_or(if https { 443 } else { 80 });
    let addr = resolve_addr(&host, port)
        .ok_or_else(|| format!("לא הצלחתי לתרגם את {host} לכתובת — Tailscale מחובר?"))?;
    let stream = TcpStream::connect_timeout(&addr, Duration::from_millis(3000))
        .map_err(|_| format!("אין מענה מ־{host}:{port} — המכונה כבויה או ש־Tailscale מנותק"))?;
    if https {
        return Ok(());
    }
    let code = http_status(stream, &host, port, "/__api/config")
        .ok_or_else(|| format!("{host}:{port} ענה, אבל לא כשרת HTTP"))?;
    if require_ok && code != 200 {
        return Err(format!("השרת ענה {code} ולא 200"));
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
/// still-running child.
///
/// Two guards, both merged in from the Windows branch, both reported by a
/// real user rather than imagined:
///
///  1. PRE-FLIGHT. Before every spawn — and we only ever spawn while holding
///     no child — ask whether the port already answers. If it does, it is not
///     ours: a second copy of this app, or a `bin/host` on the same
///     ARIGAMI_DIR. hostlock.ts would refuse our sidecar, the port would keep
///     answering anyway, and we would then hand THEIR host a handoff token
///     minted with OUR per-run secret → "Sign-in failed". Once a child of
///     ours is up, "the port answers" can no longer tell us whose it is,
///     which is exactly why the question is asked here and not later.
///  2. CRASH-LOOP. A sidecar that exits faster than HEALTHY_RUN, MAX_FAST_EXITS
///     times running, is never coming up; respawning it every 250ms just
///     burns CPU (on Windows it also popped a console window each time).
///
/// Both surface through `local_error` rather than the branch's
/// show_fatal_and_quit(): under the machine-switcher a window may be sitting
/// on a REMOTE machine that is working fine, so killing the whole app over a
/// broken local sidecar would be wrong. wait_local_ready() already watches
/// local_error, so the message lands on the shell page with a retry button.
/// Pointing the last window away from "this computer" clears the block.
fn run_supervisor(app: AppHandle, shell: Arc<Shell>) {
    let mut child: Option<Child> = None;
    let mut started: Option<Instant> = None;
    let mut fast_exits: u32 = 0;
    loop {
        // Someone cleared the block (go_to_machine, i.e. "try again" or a
        // switch back to this computer). Give the guard a full budget again.
        if fast_exits >= MAX_FAST_EXITS && !shell.local_blocked.load(Ordering::SeqCst) {
            fast_exits = 0;
        }
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
                started = None;
            }
            (true, true) => {
                let exited = matches!(child.as_mut().unwrap().try_wait(), Ok(Some(_)));
                if exited {
                    child = None;
                    *shell.local_pid.lock().unwrap() = None;
                    // Ran long enough to count as a real boot? Then this was
                    // an ordinary restart/upgrade and the counter resets.
                    if started.map(|t| t.elapsed() < HEALTHY_RUN).unwrap_or(false) {
                        fast_exits += 1;
                        if fast_exits >= MAX_FAST_EXITS {
                            shell.local_blocked.store(true, Ordering::SeqCst);
                            *shell.local_error.lock().unwrap() = Some(crash_loop_message(&app));
                        }
                    } else {
                        fast_exits = 0;
                    }
                    started = None;
                }
            }
            (false, true) if shell.local_blocked.load(Ordering::SeqCst) => {}
            (false, true) if config_endpoint_ready() => {
                shell.local_blocked.store(true, Ordering::SeqCst);
                *shell.local_error.lock().unwrap() = Some(port_taken_message());
            }
            (false, true) => match spawn_server(&app) {
                Ok(c) => {
                    *shell.local_pid.lock().unwrap() = Some(c.id());
                    *shell.local_error.lock().unwrap() = None;
                    started = Some(Instant::now());
                    child = Some(c);
                }
                Err(e) => {
                    *shell.local_error.lock().unwrap() = Some(format!(
                        "לא הצלחתי להפעיל את שרת Arigami המקומי: {e}\nלוג: {}",
                        log_path(&app).display()
                    ));
                    std::thread::sleep(Duration::from_secs(2));
                }
            },
            (false, false) => {
                // Nobody wants the local machine — drop the block so pointing
                // a window back at "this computer" tries again from scratch.
                shell.local_blocked.store(false, Ordering::SeqCst);
                fast_exits = 0;
            }
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
                "שרת Arigami המקומי לא ענה בזמן על {origin}. אולי משהו אחר תופס את הפורט?"
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
    var DATA = __DATA__, ID = '__arigami_machine_strip__';
    // The colour strip is the shell's only remaining pixels. The machine chip
    // itself is the COCKPIT's now (web/src/components/Rail.jsx): it belongs
    // beside the wordmark, in the product's own colours, and it must not
    // appear at all until there is a second machine to switch to. All the
    // shell does here is hand the page the facts and a way to call back.
    var old = document.getElementById('__arigami_machine_badge__');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (window.__arigamiBadgeTimer) { clearInterval(window.__arigamiBadgeTimer); }

    var mk = function(){
      var root = document.documentElement;
      if (!root) return;
      var strip = document.getElementById(ID);
      if (!strip) {
        strip = document.createElement('div');
        strip.id = ID;
        root.appendChild(strip);
      }
      strip.style.cssText = 'position:fixed;top:0;left:0;right:0;height:3px;z-index:2147483647;'
        + 'pointer-events:none;background:' + DATA.color;
    };
    mk();
    window.__arigamiBadgeTimer = setInterval(mk, 3000);

    // Decision #2 forbids IPC to this origin, so the callback is a navigation
    // the shell cancels — see MACHINES_SENTINEL_PATH in main.rs.
    DATA.openPicker = function(){ location.href = location.origin + DATA.sentinel; };
    window.__arigami = DATA;
    try { window.dispatchEvent(new CustomEvent('arigami:shell', { detail: DATA })); } catch (e) {}

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
        if (p && p.then) p.then(function(){
          window.__arigami.ipcLeak = true;
          try { window.dispatchEvent(new CustomEvent('arigami:shell', { detail: window.__arigami })); } catch (e) {}
        }, function(){});
      } catch (e) {}
    }
  }catch(e){}
})();
"#;

fn badge_js(shell: &Arc<Shell>, current: &Machine) -> String {
    // Everything the cockpit needs to draw (or hide) the switcher: the list,
    // which one this window is on, this machine's colour for the strip, and
    // the sentinel path for the callback. `machines.length < 2` is what the
    // cockpit checks — one machine means there is nothing to switch to and
    // the chip must not exist.
    let payload = serde_json::json!({
        "machines": shell.all_machines(),
        "current": current.id,
        "color": shell.color_of(&current.id),
        "sentinel": MACHINES_SENTINEL_PATH,
    });
    BADGE_JS.replace(
        "__DATA__",
        &serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into()),
    )
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
        cfg.last = Some(machine.id.clone());    }
    shell.save();
    recompute_local_wanted(shell);
    if machine.local {
        *shell.local_error.lock().unwrap() = None;
        // "try again" has to actually try again: without this the supervisor
        // stays parked and wait_local_ready() just times out after 60s.
        shell.local_blocked.store(false, Ordering::SeqCst);
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
                // The local machine signs itself in: first_boot_url() mints a
                // single-use handoff token (server/handoff.ts) against the
                // secret we handed this sidecar, so the window lands in the
                // cockpit instead of on a pairing screen whose code the user
                // has no terminal to read. A remote machine keeps its own
                // cookie in the app's jar and just navigates.
                let target = if machine.local {
                    first_boot_url()
                } else {
                    host_url(&machine.origin)
                };
                nav(&app2, &label2, target, false);
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
    let app_nav = app.clone();
    let shell_pl = shell.clone();
    let shell_sn = shell.clone();
    let label_sn = label.clone();
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
            // The machine chip asking for the machines window. Cancelled, so
            // the cockpit stays exactly where it is; all this navigation ever
            // does is carry the click across the origin boundary.
            if u.path() == MACHINES_SENTINEL_PATH {
                open_picker(&app_nav);
                return false;
            }
            if is_app_url(u) {
                guard.load(Ordering::SeqCst)
            } else {
                true
            }
        })
        .on_page_load(move |webview, payload| {
            // Belt and braces: if the sentinel ever gets past on_navigation,
            // the window is sitting on a 404 instead of the cockpit. Put it
            // back and honour the click anyway, rather than leaving a dead
            // page behind.
            if payload.url().path() == MACHINES_SENTINEL_PATH {
                if let Some(m) = shell_sn.machine_of(&label_sn) {
                    if let Ok(u) = url::Url::parse(&host_url(&m.origin)) {
                        let _ = webview.navigate(u);
                    }
                }
                open_picker(&webview.app_handle().clone());
                return;
            }
            if !matches!(payload.event(), PageLoadEvent::Finished) || is_app_url(payload.url()) {
                return;
            }
            if let Some(m) = shell_pl.machine_of(&label_pl) {
                let _ = webview.eval(&badge_js(&shell_pl, &m));
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
            .title("מכונות — Arigami")
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
        "מכונות…",
        true,
        Some("CmdOrCtrl+Shift+M"),
    )?));
    let refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = items.iter().map(|b| b.as_ref()).collect();
    let title = machines
        .iter()
        .find(|m| m.id == current)
        .map(|m| format!("מכונה: {}", m.name))
        .unwrap_or_else(|| "מכונה".into());
    Submenu::with_items(app, title, true, &refs)
}

/// The window/app menu. Deliberately not Menu::default(): every item here is
/// a cross-platform predefined item, so the exact menu that ships to macOS is
/// the one compiled and clicked on Linux. The first submenu becomes the
/// application menu on macOS, and the Edit submenu is what keeps ⌘C/⌘V alive
/// there once an app sets a custom menu at all.
fn build_app_menu(app: &AppHandle, shell: &Arc<Shell>, current: &str) -> tauri::Result<Menu<Wry>> {
    let quit = MenuItem::with_id(app, "quit", "יציאה מ־Arigami", true, Some("CmdOrCtrl+Q"))?;
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
        "עריכה",
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
    items.push(Box::new(MenuItem::with_id(app, "picker", "מכונות…", true, None::<&str>)?));
    items.push(Box::new(MenuItem::with_id(app, "show", "פתח את Arigami", true, None::<&str>)?));
    items.push(Box::new(MenuItem::with_id(app, "quit", "יציאה", true, None::<&str>)?));
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
        // The cockpit draws the switcher from window.__arigami, so the list it
        // holds has to move with the menus — adding the second machine is
        // exactly the moment the chip has to appear, without a reload.
        //
        // Snapshot first, THEN eval: machine_of() takes the same `windows`
        // lock, and std::sync::Mutex is not reentrant, so doing this inside
        // the iteration deadlocked the main thread — the app came up with no
        // window and no sidecar at all.
        let targets: Vec<(String, Machine)> = shell2
            .windows
            .lock()
            .unwrap()
            .iter()
            .map(|(label, w)| (label.clone(), w.machine.clone()))
            .collect();
        for (label, m) in targets {
            if let Some(w) = app2.get_webview_window(&label) {
                let _ = w.eval(&badge_js(&shell2, &m));
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
    std::thread::spawn(move || {
        let extra = if shell2.local_wanted.load(Ordering::SeqCst) {
            let n = busy_sessions(&local_machine().origin);
            if n > 0 {
                format!("\n\nיש {n} סשנים פעילים על המחשב הזה — הם ייסגרו.")
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        let confirmed = app2
            .dialog()
            .message(format!(
                "יציאה מכבה את שרת Arigami המקומי ומסיימת כל סשן פעיל עליו.{extra}\n\nלהמשיך?"
            ))
            .title("יציאה מ־Arigami")
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
    let machine = shell.find(&id).ok_or_else(|| "אין מכונה כזאת".to_string())?;
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
                        "מעבר ל־{} מכבה את השרת המקומי — {n} סשנים פעילים עליו ייסגרו.\n\nלהמשיך?",
                        machine.name
                    ))
                    .title("מעבר מכונה")
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
// `async` on purpose: a sync command runs on the main thread, and
// verify_arigami() blocks on the network for up to ~6s — that would freeze
// every window, cockpit included, while the dialog waits. The blocking part
// goes to spawn_blocking and this only awaits it.
async fn add_machine(
    app: AppHandle,
    state: State<'_, Arc<Shell>>,
    name: String,
    address: String,
) -> Result<String, String> {
    let shell = state.inner().clone();
    let origin = normalize_origin(&address)?;
    if shell.all_machines().iter().any(|m| m.origin == origin) {
        return Err("המכונה הזאת כבר ברשימה".into());
    }
    // A machine is an Arigami host, not any URL. Checked before it is stored,
    // so a bad address is a message in the dialog rather than an entry that
    // navigates the window somewhere else entirely.
    {
        let o = origin.clone();
        tauri::async_runtime::spawn_blocking(move || verify_arigami(&o))
            .await
            .map_err(|_| "בדיקת הכתובת נכשלה".to_string())??;
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
        return Err("אי אפשר להסיר את המחשב הזה".into());
    }
    if shell.windows.lock().unwrap().values().any(|w| w.machine.id == id) {
        return Err("המכונה פתוחה בחלון — עבור למכונה אחרת קודם".into());
    }
    shell.cfg.lock().unwrap().machines.retain(|m| m.id != id);
    shell.save();
    refresh_chrome(&app, &shell);
    Ok(())
}

#[tauri::command]
fn open_new_window(app: AppHandle, state: State<'_, Arc<Shell>>, id: String) -> Result<(), String> {
    let shell = state.inner().clone();
    let machine = shell.find(&id).ok_or_else(|| "אין מכונה כזאת".to_string())?;
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
                local_blocked: AtomicBool::new(false),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// One-shot HTTP server on a free port; returns its origin.
    fn serve_once(status: &'static str, body: &'static str) -> String {
        let l = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let res = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = s.write_all(res.as_bytes());
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    #[test]
    fn accepts_a_real_arigami_config() {
        let origin = serve_once("200 OK", r#"{"version":"0.1.0","authMode":"pairing","hasAdmin":true}"#);
        assert!(verify_arigami(&origin).is_ok());
    }

    #[test]
    fn rejects_a_site_that_is_not_arigami() {
        // 200, valid HTTP, just not us — the case the picker used to accept.
        let origin = serve_once("200 OK", "<!doctype html><title>hello</title>");
        assert!(verify_arigami(&origin).is_err());
    }

    #[test]
    fn rejects_a_host_with_no_config_route() {
        let origin = serve_once("404 Not Found", "nope");
        assert!(verify_arigami(&origin).is_err());
    }

    #[test]
    fn rejects_an_address_nothing_answers() {
        // Port 1 on loopback: bindable only by root, never listening here.
        assert!(verify_arigami("http://127.0.0.1:1").is_err());
    }
}
