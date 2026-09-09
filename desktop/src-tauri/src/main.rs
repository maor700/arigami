// Arigami desktop shell. Built and run for real on both Linux and macOS
// (aarch64) — `cargo tauri build` produces a .app + .dmg and the window opens.
// The Tauri v2 API surface used here (navigate(), run_on_main_thread(), the
// dialog plugin's builder chain, the tray) is compiler-checked on both.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

// Decision #3 (docs/DESKTOP.md): the shell IS the supervisor. This value is
// what server/host-control.ts's detectManager() recognizes as "some launcher
// is committed to relaunching us after exit(0)" — without it, the cockpit's
// restart/upgrade button gets a 409 (NoSupervisorError) because host-control
// can't tell a bare `bun run` apart from a real supervisor.
const SUPERVISOR_ENV_VALUE: &str = "self";

// The port the sidecar is told to bind, and the window's final origin.
//
// This used to be a hard `const 3099`, on the reasoning that "a real desktop
// app owns its own machine". It does not: a dev checkout, an older install, or
// a second copy of this app is routinely already on 3099, and the failure was
// not the documented "sidecar can't bind, splash times out". It was far worse —
// readiness was a bare "does anything answer on 3099", so the shell adopted a
// STRANGER's server, navigated the window to it, and showed a completely
// different (much older) cockpit while its own sidecar crash-looped unnoticed.
// Found live on macOS against a 23-day-old host on 3099.
//
// Two independent fixes, because either alone still leaves a hole: pick a port
// nothing is already serving on (here), and prove the thing that answers is
// ours (§ instance_id below).
//
// The range deliberately starts above the ports the rest of the product uses
// (dev servers 3020–3030, the old 3099) and stops below the dispatcher's
// 4200–4299, so a desktop instance can never land on top of a dev server or a
// dispatched child. Lowest-free-first rather than random, so a given machine
// keeps getting the same port across launches — bookmarks and muscle memory
// survive, without the fixed-port collision that started all this.
//
// Overrides, both read once at startup:
//   ARIGAMI_DESKTOP_PORT        pin one exact port; skips the scan entirely
//   ARIGAMI_DESKTOP_PORT_RANGE  "LOW-HIGH" (e.g. "3300-4000"), or a single
//                               number to mean a one-port range
const DEFAULT_PORT_LOW: u16 = 3300;
const DEFAULT_PORT_HIGH: u16 = 4000;
const PORT_ENV: &str = "ARIGAMI_DESKTOP_PORT";
const PORT_RANGE_ENV: &str = "ARIGAMI_DESKTOP_PORT_RANGE";

static PORT: OnceLock<u16> = OnceLock::new();

/// Parses ARIGAMI_DESKTOP_PORT_RANGE. Anything unparseable falls back to the
/// default range with a warning rather than refusing to start — a typo in an
/// env var should not be the reason a desktop app won't open, and the log line
/// says exactly what was ignored.
fn configured_range() -> (u16, u16) {
    let raw = match std::env::var(PORT_RANGE_ENV) {
        Ok(v) if !v.trim().is_empty() => v,
        _ => return (DEFAULT_PORT_LOW, DEFAULT_PORT_HIGH),
    };
    let t = raw.trim();
    let parsed = match t.split_once('-') {
        Some((a, b)) => match (a.trim().parse::<u16>(), b.trim().parse::<u16>()) {
            (Ok(lo), Ok(hi)) if lo > 0 && lo <= hi => Some((lo, hi)),
            _ => None,
        },
        None => t.parse::<u16>().ok().filter(|p| *p > 0).map(|p| (p, p)),
    };
    match parsed {
        Some(r) => r,
        None => {
            eprintln!(
                "[arigami-desktop] ignoring {PORT_RANGE_ENV}={raw:?} (want \"LOW-HIGH\" or a single port); \
                 using {DEFAULT_PORT_LOW}-{DEFAULT_PORT_HIGH}"
            );
            (DEFAULT_PORT_LOW, DEFAULT_PORT_HIGH)
        }
    }
}

/// Is anything already serving on this port?
///
/// Tested by CONNECTING, not by binding. Binding is the obvious choice and the
/// wrong one on a dual-stack machine: a server holding the IPv6 wildcard
/// (`*:3099`, which is what an ordinary `bun server/index.ts` ends up with)
/// still leaves `127.0.0.1:3099` bindable, so a bind probe reports "free" for
/// a port that is very much occupied — measured live, and it sent this app
/// straight back into the collision the port choice exists to avoid. A
/// successful connect is unambiguous: someone is there.
fn port_occupied(p: u16) -> bool {
    let v4 = format!("127.0.0.1:{p}").parse::<std::net::SocketAddr>().ok();
    let v6 = format!("[::1]:{p}").parse::<std::net::SocketAddr>().ok();
    [v4, v6].into_iter().flatten().any(|addr| {
        TcpStream::connect_timeout(&addr, Duration::from_millis(120)).is_ok()
    })
}

/// Where the last chosen port is remembered.
///
/// The window's origin is `http://127.0.0.1:<port>`, and the cockpit keeps
/// every UI preference — theme, language, font size, accent, terminal and voice
/// settings — in `localStorage` (web/src/lib/prefs.js), which browsers key by
/// ORIGIN. So a port that changes between launches silently wipes the user's
/// preferences: not deleted, just stored under an origin nobody visits again.
/// Reported as "preferences aren't saved when I restart", and it is a direct
/// consequence of moving off a fixed port — worth remembering rather than
/// undoing, because a fixed port is what caused the wrong-server attach.
///
/// Deliberately the sidecar's own run dir: the shell does not set ARIGAMI_DIR,
/// so the sidecar uses ~/.arigami, and keeping the memo next to its host.pid
/// means a user who wipes that directory also resets this — one place to clear,
/// no orphaned state in a second location.
fn port_memo_path() -> Option<PathBuf> {
    // HOME then USERPROFILE: Windows sets the latter and normally not the
    // former, which would have left Windows with no memo at all — and
    // therefore a port, an origin, and a set of localStorage preferences that
    // changed on every launch. Mirrors what server/lib/platform.ts already
    // does on the TypeScript side.
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|h| PathBuf::from(h).join(".arigami").join("run").join("desktop-port"))
}

fn remembered_port() -> Option<u16> {
    let p = port_memo_path()?;
    std::fs::read_to_string(p)
        .ok()?
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|p| *p > 0)
}

fn remember_port(p: u16) {
    if let Some(path) = port_memo_path() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Best-effort: an unwritable HOME costs a stable origin, not a boot.
        let _ = std::fs::write(path, p.to_string());
    }
}

fn pick_port() -> u16 {
    // An explicit pin wins even if occupied: the operator asked for that port,
    // and the instance check below still refuses to adopt a stranger there, so
    // the failure is a clean "didn't start" rather than a wrong-server attach.
    if let Ok(v) = std::env::var(PORT_ENV) {
        if let Ok(p) = v.trim().parse::<u16>() {
            if p > 0 {
                return p;
            }
        }
        eprintln!("[arigami-desktop] ignoring {PORT_ENV}={v:?} (not a port number)");
    }

    let (lo, hi) = configured_range();

    // Reuse last launch's port when it is still free and still inside the
    // configured range — that keeps the origin, and therefore the user's
    // preferences, stable across restarts. A range change in the env
    // deliberately overrides the memo rather than being ignored.
    if let Some(p) = remembered_port() {
        if p >= lo && p <= hi && !port_occupied(p) {
            return p;
        }
    }

    for p in lo..=hi {
        if !port_occupied(p) {
            remember_port(p);
            return p;
        }
    }

    // Every port in the range is serving something. Rather than refuse to
    // start, let the OS hand out an ephemeral one — the window follows whatever
    // we choose (decision #1 constrains the origin, not the number).
    eprintln!(
        "[arigami-desktop] every port in {lo}-{hi} is in use; falling back to an OS-assigned port"
    );
    TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(DEFAULT_PORT_LOW)
}

fn port() -> u16 {
    *PORT.get_or_init(pick_port)
}

// A per-launch marker the sidecar echoes back on /__api/config, so readiness
// means "OUR server answered" and not "something answered".
//
// Deliberately NOT a secret and not used for authentication anywhere: it is
// echoed on an endpoint that is public by design (auth.ts's allowlist), so
// anyone who can already reach the port can read it. It grants nothing —
// knowing it only lets you claim to be the sidecar to a launcher that started
// you. That is why it needs no CSPRNG and pulls in no `rand`/`uuid`
// dependency; clock nanos + pid are plenty to distinguish our child from an
// unrelated process.
static INSTANCE_ID: OnceLock<String> = OnceLock::new();

fn instance_id() -> &'static str {
    INSTANCE_ID.get_or_init(|| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{:x}-{:x}", nanos, std::process::id())
    })
}

fn host_url() -> String {
    format!("http://127.0.0.1:{}/__host/", port())
}

/// Where the arigami-server binary and its resources/ sibling live once
/// bundled. desktop/build.sh stages both under
/// desktop/src-tauri/resources-staged/ and tauri.conf.json's
/// `bundle.resources` map ships that whole directory unchanged, so this is
/// just `<resource_dir>/resources-staged/`.
fn resolve_server_binary(app: &AppHandle) -> Option<PathBuf> {
    let base = app.path().resource_dir().ok()?.join("resources-staged");
    let name = if cfg!(windows) { "arigami-server.exe" } else { "arigami-server" };
    Some(base.join(name))
}

/// Log file for the sidecar's stdout/stderr — the only way to debug a boot
/// failure, since nothing about the server's own logging changes just
/// because it's running under Tauri instead of a terminal.
fn open_log_file(app: &AppHandle) -> Stdio {
    let dir = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("arigami-server.log");
    match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(f) => Stdio::from(f),
        Err(_) => Stdio::null(),
    }
}

fn spawn_server(app: &AppHandle) -> std::io::Result<Child> {
    let bin = resolve_server_binary(app).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "could not resolve resource_dir()")
    })?;
    Command::new(&bin)
        // Decision #3: commit to relaunching after exit(0) (restart/upgrade).
        .env("ARIGAMI_SUPERVISOR", SUPERVISOR_ENV_VALUE)
        .env("ARIGAMI_PORT", port().to_string())
        .env("ARIGAMI_INSTANCE_ID", instance_id())
        // Belt to the signal handler's braces: if this shell dies without its
        // handler running (SIGKILL, or macOS delivering SIGTERM somewhere the
        // ctrlc thread never sees), the sidecar notices the reparent and exits
        // on its own instead of sitting on the port forever.
        .env("ARIGAMI_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(open_log_file(app))
        .stderr(open_log_file(app))
        .spawn()
}

/// Decision #4: hand-rolled HTTP/1.1 GET over a raw TcpStream instead of
/// pulling in an HTTP client crate — this app makes exactly one request ever,
/// so a dependency for it isn't worth the extra unverified surface.
///
/// Ready means BOTH a 200 status line AND our own `instanceId` echoed in the
/// body. The status line alone is not enough and never was: any unrelated
/// arigami on this port answers 200 just as happily, which is exactly how the
/// window ended up displaying a stranger's cockpit while this app's sidecar
/// was dead. If the echo is missing the responder is either someone else's
/// server or one too old to know about the field — either way, not ours.
fn config_endpoint_ready() -> bool {
    let p = port();
    let addr = match format!("127.0.0.1:{p}").parse::<std::net::SocketAddr>() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let req = format!(
        "GET /__api/config HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    if stream.read_to_end(&mut buf).is_err() {
        return false;
    }
    let text = String::from_utf8_lossy(&buf);
    let ok = text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200");
    // Matched as a raw substring rather than by parsing JSON: the id is hex +
    // '-' only, so there is nothing to escape and no reason to add a parser.
    let mine = text.contains(&format!("\"instanceId\":\"{}\"", instance_id()));
    ok && mine
}

fn wait_for_ready(timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if config_endpoint_ready() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
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

fn show_fatal_and_quit(app: &AppHandle, message: String) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        app2.dialog()
            .message(message)
            .title("Arigami")
            .blocking_show();
        app2.exit(1);
    });
}

/// The supervisor loop (decision #3): spawn, and on the FIRST successful boot
/// only, poll until ready and navigate the window off the splash page. Every
/// later exit (restart/upgrade OR a crash) just gets silently respawned —
/// the window is already sitting on http://127.0.0.1:PORT/__host/ by then,
/// and that page's own reconnect logic (built for the ordinary browser
/// product, same host-control restart flow) is what recovers the UI, not
/// this loop.
///
/// A sidecar that dies BEFORE it ever became ready is a circuit breaker, not
/// something to retry forever. This used to respawn blindly: a sidecar that
/// crashed at import time (a `node:sqlite` import Bun has no module for) was
/// restarted 477 times in a couple of minutes with nothing on screen to say
/// so — and because readiness was satisfied by an unrelated server on the same
/// port, the window looked fine the whole time. Once ready has been reached
/// once, unlimited respawns are correct again: that is the restart/upgrade
/// path, and the page recovers itself.
fn run_supervisor(app: AppHandle, quitting: Arc<AtomicBool>, current_pid: Arc<Mutex<Option<u32>>>) {
    /// Consecutive pre-ready exits tolerated before giving up. Small on
    /// purpose: nothing that is going to boot needs a fourth attempt, and each
    /// one writes the same failure to the log.
    const MAX_PRE_READY_FAILURES: u32 = 3;

    let ready = Arc::new(AtomicBool::new(false));
    let mut pre_ready_failures: u32 = 0;
    let mut first_boot = true;
    loop {
        if quitting.load(Ordering::SeqCst) {
            return;
        }

        let mut child = match spawn_server(&app) {
            Ok(c) => c,
            Err(e) => {
                if first_boot {
                    show_fatal_and_quit(
                        &app,
                        format!("Could not start the Arigami server:\n{e}"),
                    );
                    return;
                }
                eprintln!("[arigami-desktop] failed to respawn arigami-server: {e}");
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
        };
        *current_pid.lock().unwrap() = Some(child.id());

        if first_boot {
            first_boot = false;
            let app2 = app.clone();
            let ready2 = ready.clone();
            std::thread::spawn(move || {
                if wait_for_ready(Duration::from_secs(45)) {
                    ready2.store(true, Ordering::SeqCst);
                    let app3 = app2.clone();
                    let _ = app2.run_on_main_thread(move || {
                        if let Some(w) = app3.get_webview_window("main") {
                            if let Ok(url) = url::Url::parse(&host_url()) {
                                let _ = w.navigate(url);
                            }
                        }
                    });
                } else {
                    // Resolved at runtime, not hardcoded: verified live on Linux
                    // this lands at ~/.local/share/io.arigami.desktop/logs/ (the
                    // bundle identifier, not the product name) — macOS's actual
                    // path is unverified, so asserting one here would just be
                    // another guess dressed up as a fact.
                    let log_hint = app2
                        .path()
                        .app_log_dir()
                        .map(|d| d.join("arigami-server.log").display().to_string())
                        .unwrap_or_else(|_| "arigami-server.log (log dir unknown)".into());
                    show_fatal_and_quit(
                        &app2,
                        format!("Arigami didn't answer in time. Check the log:\n{log_hint}"),
                    );
                }
            });
        }

        let status = child.wait(); // blocks until the sidecar exits, restart or crash alike
        *current_pid.lock().unwrap() = None;

        if quitting.load(Ordering::SeqCst) {
            return;
        }

        if ready.load(Ordering::SeqCst) {
            // Past the first successful boot: this is restart/upgrade/crash
            // territory and respawning without limit is the contract.
            pre_ready_failures = 0;
        } else {
            pre_ready_failures += 1;
            if pre_ready_failures >= MAX_PRE_READY_FAILURES {
                let code = status
                    .as_ref()
                    .ok()
                    .and_then(|s| s.code())
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "signal".into());
                let log_hint = app
                    .path()
                    .app_log_dir()
                    .map(|d| d.join("arigami-server.log").display().to_string())
                    .unwrap_or_else(|_| "arigami-server.log (log dir unknown)".into());
                show_fatal_and_quit(
                    &app,
                    format!(
                        "The Arigami server exited {pre_ready_failures} times without starting \
                         (last exit: {code}).\n\nThe reason is in the log:\n{log_hint}"
                    ),
                );
                return;
            }
        }

        std::thread::sleep(Duration::from_millis(500));
    }
}

/// The actual quit action, shared by the tray's "Quit" (after confirmation)
/// and the raw-signal handler below (which cannot wait on a dialog — a
/// signal handler needs to act immediately, not block on user input).
fn quit_now(app: &AppHandle, quitting: &Arc<AtomicBool>, current_pid: &Arc<Mutex<Option<u32>>>) {
    quitting.store(true, Ordering::SeqCst);
    if let Some(pid) = *current_pid.lock().unwrap() {
        terminate(pid);
    }
    app.exit(0);
}

fn confirm_and_quit(app: &AppHandle, quitting: Arc<AtomicBool>, current_pid: Arc<Mutex<Option<u32>>>) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        // Decision from the task brief: "תן אישור לפני יציאה, ואל תסתיר את
        // זה" — say plainly that quitting kills every active session, don't
        // soften it into generic "quit?" copy.
        let confirmed = app2
            .dialog()
            .message("Quitting stops the Arigami server and ends every active session.\n\nContinue?")
            .title("Quit Arigami")
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show();
        if confirmed {
            quit_now(&app2, &quitting, &current_pid);
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Arigami")
                .inner_size(1280.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .build()?;

            let quitting = Arc::new(AtomicBool::new(false));
            let current_pid: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));

            let show_item = MenuItem::with_id(app, "show", "Open Arigami", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Arigami", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            {
                let quitting = quitting.clone();
                let current_pid = current_pid.clone();
                TrayIconBuilder::new()
                    .menu(&menu)
                    .icon(app.default_window_icon().cloned().ok_or("no default window icon")?)
                    .on_menu_event(move |app, event| match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => confirm_and_quit(app, quitting.clone(), current_pid.clone()),
                        _ => {}
                    })
                    .build(app)?;
            }

            // The tray (not the window's native close button) is the only
            // real quit — see the module doc on run_supervisor(). Clicking
            // the window's [x] just hides it; the sidecar and tray live on.
            if let Some(w) = app.get_webview_window("main") {
                let quitting_flag = quitting.clone();
                let window_for_hide = w.clone();
                w.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if !quitting_flag.load(Ordering::SeqCst) {
                            api.prevent_close();
                            let _ = window_for_hide.hide();
                        }
                    }
                });
            }

            {
                let handle = handle.clone();
                let quitting = quitting.clone();
                let current_pid = current_pid.clone();
                std::thread::spawn(move || run_supervisor(handle, quitting, current_pid));
            }

            // SIGTERM/SIGINT delivered straight to this process (shutdown,
            // `kill <pid>`, not the tray) has no handler otherwise — found
            // live: it orphaned the sidecar instead of running any of our
            // cleanup. No confirmation dialog here on purpose: a signal
            // handler has to act immediately, it can't block on user input.
            {
                let handle = handle.clone();
                let quitting = quitting.clone();
                let current_pid = current_pid.clone();
                // Do NOT discard this Result. A registration that loses to
                // something else in-process fails silently, and the only
                // symptom is an orphaned sidecar much later — which is exactly
                // what was seen on macOS. The sidecar's own parent-death
                // watchdog is the actual safety net; this log is how you find
                // out the signal path is not the thing saving you.
                if let Err(e) = ctrlc::set_handler(move || {
                    quit_now(&handle, &quitting, &current_pid);
                }) {
                    eprintln!(
                        "[arigami-desktop] could not install the termination handler ({e}); \
                         relying on the sidecar's ARIGAMI_PARENT_PID watchdog to avoid an orphan"
                    );
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running arigami-desktop");
}
