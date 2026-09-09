// Arigami desktop shell. Built and run for real on Linux and on Windows 11
// (see docs/DESKTOP.md) — the Tauri v2 API calls below are compiler-checked
// and were exercised live, so they are no longer the first suspects when
// something misbehaves. macOS has still never been built: Tauri cannot
// cross-compile to it, so treat anything macOS-specific (.app layout, .icns,
// NSStatusItem tray) as unverified.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;

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

fn host_url() -> String {
    format!("http://127.0.0.1:{}/__host/", arigami_port())
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
        .unwrap_or_else(host_url)
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
/// this loop. A crash-loop guard stops it after MAX_FAST_EXITS consecutive
/// sub-HEALTHY_RUN exits and explains why, instead of respawning forever half
/// a second apart — which is what it used to do, and what turned a plain
/// port collision into an endless stream of console windows on Windows.
fn run_supervisor(app: AppHandle, quitting: Arc<AtomicBool>, current_pid: Arc<Mutex<Option<u32>>>) {
    // Pre-flight: is the port ALREADY served, before we have spawned anything?
    // Then it is not ours, and nothing good follows from continuing.
    //
    // This is not theoretical — it shipped and a user hit it. wait_for_ready()
    // only asks "does the port answer", so with a second copy of the app (or a
    // bin/host on the same ARIGAMI_DIR) already holding it, the sequence was:
    // our sidecar is refused by hostlock.ts → the port answers anyway, because
    // THEIR host is on it → we mint a handoff token with OUR per-run secret and
    // navigate to THEIR host, which has a different one → "Sign-in failed".
    // Under the older auth-off build the same collision silently landed the
    // window in the other instance's cockpit instead, which hid the problem
    // rather than avoiding it.
    //
    // Checking once here, before the first spawn, is what makes this
    // unambiguous: after we have started a sidecar, "the port answers" can no
    // longer tell us whose it is.
    if config_endpoint_ready() {
        quitting.store(true, Ordering::SeqCst);
        show_fatal_and_quit(&app, port_taken_message());
        return;
    }

    let mut first_boot = true;
    let mut fast_exits: u32 = 0;
    loop {
        if quitting.load(Ordering::SeqCst) {
            return;
        }
        let started = Instant::now();

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
                            if let Ok(url) = url::Url::parse(&first_boot_url()) {
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

        // Died on startup, or ran long enough to count as a real boot?
        if started.elapsed() < HEALTHY_RUN {
            fast_exits += 1;
            if fast_exits >= MAX_FAST_EXITS {
                // Set this BEFORE the dialog: show_fatal_and_quit hands the
                // dialog to the main thread and returns immediately, so
                // without it nothing would stop another lap of this loop.
                quitting.store(true, Ordering::SeqCst);
                show_fatal_and_quit(&app, crash_loop_message(&app));
                return;
            }
        } else {
            fast_exits = 0;
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
