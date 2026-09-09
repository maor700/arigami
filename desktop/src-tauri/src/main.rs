// Arigami desktop shell. NOT compiled or run in this task (no Rust toolchain
// on this box, and Tauri doesn't cross-compile Linux→macOS at all — see
// docs/DESKTOP.md). Every line below is written against my best recollection
// of the Tauri v2 API surface, with nothing checked by a compiler. Treat the
// exact method names (navigate(), run_on_main_thread(), the dialog plugin's
// builder chain) as the first suspects if `cargo tauri build` fails — see
// docs/DESKTOP.md's "what's unverified" section before debugging blind.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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

// Decision #5: this must match the port server/lib/config.ts actually binds
// (default 3099, see ARIGAMI_PORT in server/lib/config.ts:440). Fixed rather
// than dynamically chosen because this window's final URL (decision #1) has
// to be known before we can navigate to it — a real desktop app owns its own
// machine, so a fixed port is a reasonable simplification. If the user is
// also running an arigami VPS/dev checkout locally on this same port, the
// sidecar will fail to bind (hostlock.ts) and the splash will time out; that
// collision case has no special handling here.
const ARIGAMI_PORT: u16 = 3099;

fn host_url() -> String {
    format!("http://127.0.0.1:{ARIGAMI_PORT}/__host/")
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
        .env("ARIGAMI_PORT", ARIGAMI_PORT.to_string())
        .stdin(Stdio::null())
        .stdout(open_log_file(app))
        .stderr(open_log_file(app))
        .spawn()
}

/// Decision #4: hand-rolled HTTP/1.1 GET over a raw TcpStream instead of
/// pulling in an HTTP client crate — this app makes exactly one request ever,
/// so a dependency for it isn't worth the extra unverified surface. A 2xx-ish
/// "HTTP/1.1 200" status line is treated as ready; anything else (connection
/// refused, timeout, non-200) is not.
fn config_endpoint_ready() -> bool {
    let addr = match format!("127.0.0.1:{ARIGAMI_PORT}")
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
        "GET /__api/config HTTP/1.1\r\nHost: 127.0.0.1:{ARIGAMI_PORT}\r\nConnection: close\r\n\r\n"
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
/// this loop. There is deliberately no crash-loop backoff/circuit breaker:
/// if the sidecar keeps failing, this will keep respawning it forever, half
/// a second apart. That is a known, undecided gap — see docs/DESKTOP.md.
fn run_supervisor(app: AppHandle, quitting: Arc<AtomicBool>, current_pid: Arc<Mutex<Option<u32>>>) {
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
            std::thread::spawn(move || {
                if wait_for_ready(Duration::from_secs(45)) {
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

        let _status = child.wait(); // blocks until the sidecar exits, restart or crash alike
        *current_pid.lock().unwrap() = None;

        if quitting.load(Ordering::SeqCst) {
            return;
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
                let _ = ctrlc::set_handler(move || {
                    quit_now(&handle, &quitting, &current_pid);
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running arigami-desktop");
}
