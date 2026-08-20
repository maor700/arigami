<#
.SYNOPSIS
  host.ps1 — lifecycle CLI for arigami on Windows.
  The Windows counterpart of bin/host: start|stop|restart|status|logs [-f]|doctor|launch|install|uninstall

.DESCRIPTION
  Same contract as the bash version — pidfile + logs under $HOME\.arigami\,
  health check = GET /__api/config — with the macOS-only pieces swapped:
  launchd → a per-user Scheduled Task, lsof → Get-NetTCPConnection, and
  `open -na "Google Chrome"` → chrome.exe --app on a dedicated profile.

.EXAMPLE
  bin\host.ps1 start
  bin\host.ps1 launch
  bin\host.ps1 install     # autostart at logon
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Command = 'status',
  [Parameter(Position = 1)][string]$Arg = ''
)

$ErrorActionPreference = 'Stop'

$ROOT    = Split-Path -Parent $PSScriptRoot
$HOMEDIR = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$DIR     = Join-Path $HOMEDIR '.arigami'
$LOGDIR  = Join-Path $DIR 'logs'
$PIDFILE = Join-Path $DIR 'host.pid'
$LOG     = Join-Path $LOGDIR 'host.log'
$ERRLOG  = Join-Path $LOGDIR 'host.err.log'
$CONFIG  = Join-Path $DIR 'config.json'
$TASK    = 'Arigami'

# Port from config.json when present, else 3099.
$PORT = 3099
if (Test-Path $CONFIG) {
  try {
    $p = (Get-Content $CONFIG -Raw | ConvertFrom-Json).port
    if ($p) { $PORT = [int]$p }
  } catch { }
}
$URL = "http://localhost:$PORT"

function Write-Ok   ([string]$m) { Write-Host $m -ForegroundColor Green }
function Write-Bad  ([string]$m) { Write-Host $m -ForegroundColor Red }
function Write-Warn ([string]$m) { Write-Host $m -ForegroundColor Yellow }
function Write-Dim  ([string]$m) { Write-Host $m -ForegroundColor DarkGray }

function Get-BunPath {
  $bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
  if ($bun) { return $bun }
  $fallback = Join-Path $HOMEDIR '.bun\bin\bun.exe'
  if (Test-Path $fallback) { return $fallback }
  return $null
}

function Test-Health {
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$URL/__api/config" | Out-Null
    return $true
  } catch { return $false }
}

function Get-HostPid {
  if (Test-Path $PIDFILE) {
    $id = (Get-Content $PIDFILE -Raw).Trim()
    if ($id -and (Get-Process -Id $id -ErrorAction SilentlyContinue)) { return [int]$id }
  }
  # No pidfile (Scheduled-Task-managed, or a stale file): resolve by port — but
  # only to a pid that still EXISTS. A listener can outlive its owner here: the
  # host's socket handle is inheritable, so a child that escaped (a session's MCP
  # server) keeps :$PORT bound to a dead pid. Returning that pid made `status`
  # report "alive but not responding" and `stop` say "not running" while the port
  # stayed blocked. Get-StaleListenerPid reports that case honestly instead.
  $listener = Get-ListenerPid
  if ($listener -and (Get-Process -Id $listener -ErrorAction SilentlyContinue)) { return $listener }
  return $null
}

function Get-ListenerPid {
  try {
    $conn = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
  } catch { }
  return $null
}

# The pid holding :$PORT when that process no longer exists — i.e. an orphan is
# pinning the port. $null when the port is free or genuinely owned.
function Get-StaleListenerPid {
  $listener = Get-ListenerPid
  if ($listener -and -not (Get-Process -Id $listener -ErrorAction SilentlyContinue)) { return $listener }
  return $null
}

# Kill whatever the server recorded as its children (server/lib/children.ts keeps
# ~/.arigami/children.json up to date). This is the sweep that frees a port held
# by an orphan; the server runs the same sweep on its next start.
function Clear-OrphanChildren {
  $file = Join-Path $DIR 'children.json'
  if (-not (Test-Path $file)) { return 0 }
  $killed = 0
  try {
    $records = Get-Content $file -Raw | ConvertFrom-Json
    foreach ($r in @($records)) {
      if (-not $r.pid) { continue }
      $proc = Get-Process -Id $r.pid -ErrorAction SilentlyContinue
      if (-not $proc) { continue }
      # pid-reuse guard: a survivor started when we recorded it, a recycled pid
      # belongs to something that started later.
      if ($r.at -and $proc.StartTime) {
        $recorded = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$r.at).LocalDateTime
        if ($proc.StartTime -gt $recorded.AddMinutes(1)) { continue }
      }
      & taskkill.exe /PID $r.pid /T /F 2>&1 | Out-Null
      $killed++
    }
  } catch { }
  Remove-Item $file -ErrorAction SilentlyContinue
  return $killed
}

function Get-HostTask {
  Get-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue
}

function Wait-Health([int]$Tries = 40) {
  for ($i = 0; $i -lt $Tries; $i++) {
    if (Test-Health) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Start-Host {
  if (Test-Health) {
    Write-Warn "already running (pid $(Get-HostPid)) on :$PORT"
    return 0
  }
  New-Item -ItemType Directory -Force -Path $LOGDIR | Out-Null

  # A stale listener (orphan holding the inherited socket) makes the bind below
  # fail forever. Sweep it here so a restart heals itself instead of needing a
  # reboot. The server runs the same sweep itself — this covers the task path too.
  if (Get-StaleListenerPid) {
    $swept = Clear-OrphanChildren
    if ($swept) { Write-Dim "  swept $swept orphaned child process tree(s) holding :$PORT" }
  }

  # Scheduled-Task install: start the task instead of forking our own process,
  # otherwise the task's restart policy and the pidfile copy fight over the port.
  if (Get-HostTask) {
    # Stop-Host disables the task (so its restart policy can't respawn what we
    # kill), so re-enable before starting or every start/restart after a stop
    # dies with "The task is disabled".
    Enable-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue | Out-Null
    Start-ScheduledTask -TaskName $TASK
    if (Wait-Health) { Write-Ok "* host started (scheduled task) -> $URL"; return 0 }
    Write-Bad 'scheduled task started but health check failed - see: host.ps1 logs'
    return 1
  }

  $bun = Get-BunPath
  if (-not $bun) { Write-Bad 'bun not found on PATH - install from https://bun.sh'; return 1 }

  $proc = Start-Process -FilePath $bun `
    -ArgumentList (Join-Path $ROOT 'server\index.ts') `
    -WorkingDirectory $ROOT `
    -RedirectStandardOutput $LOG -RedirectStandardError $ERRLOG `
    -WindowStyle Hidden -PassThru
  Set-Content -Path $PIDFILE -Value $proc.Id -Encoding ascii

  for ($i = 0; $i -lt 40; $i++) {
    if (Test-Health) { Write-Ok "* host started (pid $($proc.Id)) -> $URL"; return 0 }
    if ($proc.HasExited) {
      Write-Bad "x process died on startup (exit $($proc.ExitCode)) - see: host.ps1 logs"
      return 1
    }
    Start-Sleep -Milliseconds 250
  }
  Write-Bad "started (pid $($proc.Id)) but health check failed - see: host.ps1 logs"
  return 1
}

function Stop-Tree([int]$ProcId) {
  if (-not $ProcId) { return $false }
  if (-not (Get-Process -Id $ProcId -ErrorAction SilentlyContinue)) { return $false }
  # /T so the claude child processes go with it, mirroring the POSIX SIGTERM
  # to the process group.
  & taskkill.exe /PID $ProcId /T /F 2>&1 | Out-Null
  return $true
}

function Stop-Host {
  # Disable the task first or its restart policy respawns what we kill.
  if (Get-HostTask) {
    Stop-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue
    Disable-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue | Out-Null
    Write-Ok '* scheduled task disabled (host.ps1 install re-enables autostart)'
  }
  $procId = Get-HostPid
  $stopped = Stop-Tree $procId
  # Always sweep: /T only reaches children whose parent chain is still alive, so
  # anything already orphaned (and still holding :$PORT) survives the kill above.
  $swept = Clear-OrphanChildren
  Remove-Item $PIDFILE -ErrorAction SilentlyContinue
  if ($swept) { Write-Dim "  swept $swept orphaned child process tree(s)" }
  if ($stopped) {
    Write-Ok "* stopped (pid $procId)"
    return 0
  }
  $stale = Get-StaleListenerPid
  if ($stale) {
    Write-Warn "o :$PORT was held by an orphan (owner pid $stale is gone)"
    $still = Get-StaleListenerPid
    if ($still) {
      Write-Bad "  :$PORT is STILL bound - a process outside our records holds the inherited socket."
      Write-Dim "  Inspect with: Get-NetTCPConnection -LocalPort $PORT"
      Write-Dim '  If its owner pid no longer exists, only killing that holder (or a reboot) frees it.'
      return 1
    }
    Write-Ok "* :$PORT released"
    return 0
  }
  Write-Warn 'not running'
  return 0
}

function Get-HostStatus {
  $procId = Get-HostPid
  $stale = Get-StaleListenerPid
  if ($stale -and -not $procId) {
    Write-Bad "o not running - but :$PORT is held by a STALE listener (owner pid $stale no longer exists)"
    Write-Dim '  An orphaned child still holds the socket it inherited. Free it with: host.ps1 stop'
    return
  }
  if (Test-Health) {
    $sessions = '?'
    try {
      $s = Invoke-RestMethod -TimeoutSec 2 "$URL/__api/sessions"
      $sessions = @($s).Count
    } catch { }
    $mgr = if (Get-HostTask) { ' (scheduled task)' } else { '' }
    Write-Ok "* running  pid $procId$mgr  :$PORT  sessions: $sessions"
  } elseif ($procId) {
    Write-Warn "o process alive but not responding (pid $procId) - check: host.ps1 logs"
  } else {
    Write-Bad 'o not running'
  }
}

function Show-Logs {
  if (-not (Test-Path $LOG)) { Write-Dim '(no log yet)'; return }
  if ($Arg -eq '-f' -or $Arg -eq '--follow') {
    Get-Content $LOG -Tail 100 -Wait
    return
  }
  Get-Content $LOG -Tail 200
}

function Invoke-Doctor {
  Write-Host 'host doctor' -ForegroundColor White
  Write-Host ''
  if (Test-Path $CONFIG) { Write-Host "config: $CONFIG (ok)" } else { Write-Warn "config: $CONFIG (defaults)" }
  Write-Host "port: $PORT"
  Write-Host ''
  Write-Dim 'tooling:'
  foreach ($bin in 'bun', 'claude', 'git', 'gh') {
    $cmd = Get-Command $bin -ErrorAction SilentlyContinue
    if ($cmd) {
      $v = try { (& $bin --version 2>$null | Select-Object -First 1) } catch { 'found' }
      Write-Host "  ${bin}: " -NoNewline; Write-Ok "$v"
    } else {
      Write-Host "  ${bin}: " -NoNewline; Write-Bad 'not found'
    }
  }
  # Git Bash backs every shell job the host runs (cleanup, onboarding, skills).
  $bash = @(
    $env:ARIGAMI_BASH,
    'C:\Program Files\Git\bin\bash.exe',
    'C:\Program Files\Git\usr\bin\bash.exe'
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  Write-Host '  bash (Git for Windows): ' -NoNewline
  if ($bash) { Write-Ok $bash } else { Write-Bad 'not found - shell jobs will fail; install Git for Windows' }
  Write-Host ''
  Write-Dim 'files:'
  if (Test-Path (Join-Path $ROOT 'node_modules')) { Write-Host '  node_modules: ok' } else { Write-Bad '  node_modules: missing - run: bun install' }
  if (Test-Path (Join-Path $ROOT 'web\dist\index.html')) { Write-Host '  web/dist: ok' } else { Write-Warn '  web/dist: missing - run: bun run build:web' }
  Write-Host ''
  Write-Dim 'runtime:'
  Write-Host '  ' -NoNewline
  Get-HostStatus
}

function Install-Autostart {
  $bun = Get-BunPath
  if (-not $bun) { Write-Bad 'bun not found on PATH'; return 1 }
  New-Item -ItemType Directory -Force -Path $LOGDIR | Out-Null

  # Hand over from a pidfile-managed process to the task cleanly.
  $procId = Get-HostPid
  if ($procId) { Stop-Tree $procId | Out-Null; Remove-Item $PIDFILE -ErrorAction SilentlyContinue }

  $action  = New-ScheduledTaskAction -Execute $bun `
    -Argument (Join-Path $ROOT 'server\index.ts') -WorkingDirectory $ROOT
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  # RestartCount/Interval is the closest thing to launchd's KeepAlive.
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

  Register-ScheduledTask -TaskName $TASK -Action $action -Trigger $trigger `
    -Settings $settings -Description 'Arigami cockpit server' -Force | Out-Null
  Enable-ScheduledTask -TaskName $TASK | Out-Null
  Start-ScheduledTask -TaskName $TASK
  Write-Ok "* installed scheduled task '$TASK' (host :$PORT), starts at logon"
  Write-Dim '  The cockpit window is opened separately: bin\host.ps1 launch'
  return 0
}

function Uninstall-Autostart {
  if (Get-HostTask) {
    Stop-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TASK -Confirm:$false
    Write-Ok "* removed scheduled task '$TASK'"
  } else {
    Write-Warn 'no scheduled task installed'
  }
  return 0
}

function Get-ChromePath {
  $candidates = @(
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

# One-click: bring up the host, then open the cockpit in a Chrome app window.
function Start-Cockpit {
  if ((Start-Host) -ne 0) { return 1 }
  $chrome = Get-ChromePath
  if (-not $chrome) { Write-Bad 'Chrome (or Edge) not found - open ' -NoNewline; Write-Host "$URL/__host/"; return 1 }

  $profileDir = Join-Path $DIR 'chrome-profile'
  New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
  # A force-killed browser leaves Singleton* locks that block the next launch
  # with this profile. Clear them when nothing is using the profile.
  $inUse = Get-CimInstance Win32_Process -Filter "Name='$(Split-Path $chrome -Leaf)'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*user-data-dir=$profileDir*" }
  if (-not $inUse) {
    Get-ChildItem $profileDir -Filter 'Singleton*' -ErrorAction SilentlyContinue |
      Remove-Item -Force -ErrorAction SilentlyContinue
  }

  Write-Dim 'opening cockpit...'
  # Dedicated profile + --app = a standalone window (no tabs/omnibox) with its
  # own persistent Acme login, isolated from your everyday browser.
  Start-Process -FilePath $chrome -ArgumentList @(
    "--user-data-dir=$profileDir",
    "--app=$URL/__host/",
    '--no-first-run',
    '--no-default-browser-check'
  ) | Out-Null
  Write-Ok "* Arigami open -> $URL/__host/"
  return 0
}

switch ($Command.ToLower()) {
  'start'     { exit (Start-Host) }
  'stop'      { exit (Stop-Host) }
  'restart'   { Stop-Host | Out-Null; Start-Sleep -Milliseconds 600; exit (Start-Host) }
  'status'    { Get-HostStatus; exit 0 }
  'logs'      { Show-Logs; exit 0 }
  'doctor'    { Invoke-Doctor; exit 0 }
  'install'   { exit (Install-Autostart) }
  'uninstall' { exit (Uninstall-Autostart) }
  { $_ -in 'launch', 'app' } { exit (Start-Cockpit) }
  default {
    Write-Host 'usage: host.ps1 <launch|start|stop|restart|status|logs [-f]|doctor|install|uninstall>'
    exit 1
  }
}
