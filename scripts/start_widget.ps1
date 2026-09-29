# Launch the Watchfire widget as a chrome-less Edge "app window"
# pinned always-on-top.
#
# Approach:
#   1. Start msedge.exe with --app=URL (no tabs, no address bar)
#      using a dedicated user-data-dir so it doesn't share state with
#      the user's normal Edge profile.
#   2. Wait for its main window handle to appear, then SetWindowPos
#      with HWND_TOPMOST so the window stays above all others.
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File start_widget.ps1 [-Url <url>] [-Width N -Height N]
#
# Closing the window exits the helper too — Edge's --app process tree
# tears down naturally.

param(
    [string]$Url      = "http://localhost:4173/widget.html",
    [int]   $Width    = 320,
    [int]   $Height   = 480,
    [int]   $X        = -1,   # -1 = default to an on-screen position (see below)
    [int]   $Y        = -1,
    [int]   $Sessions = 0     # session count from watchfire CLI; drives auto-height
)

# --- Launch diagnostics -----------------------------------------------------
# The recurring "widget didn't launch (no taskbar icon)" only surfaces on a
# cold boot and can't be reproduced once the machine is warm, so leave a
# breadcrumb every run. Read it from WSL at:
#   /mnt/c/Users/<you>/AppData/Local/OrchestratorWidget/widget-launch.log
$LogDir  = Join-Path $env:LOCALAPPDATA "OrchestratorWidget"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir "widget-launch.log"
function Write-Log([string]$msg) {
    try { Add-Content -Path $LogFile -Value ("{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg) -Encoding utf8 } catch {}
}
Add-Type -AssemblyName System.Windows.Forms
$vs0 = [System.Windows.Forms.SystemInformation]::VirtualScreen
Write-Log ("=== launch Url=$Url Sessions=$Sessions vscreen=({0},{1})-({2},{3}) ===" -f $vs0.Left,$vs0.Top,$vs0.Right,$vs0.Bottom)

# If caller didn't override $Height, scale it to fit the session count so the
# widget opens without scrolling. Empirical sizing at zoom 1.15:
#   - chrome (title bar) + scroll padding ≈ 80px
#   - per-row (rendered) ≈ 42px
#   - amortized group-header overhead ≈ 25px (typical 2–3 sessions per group)
# So per-session ≈ 65px including its share of group headers. Capped at 90%
# of working-area height so we never start off-screen.
if ($PSBoundParameters.ContainsKey('Height') -eq $false) {
    Add-Type -AssemblyName System.Windows.Forms
    $screenH = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Height
    $desired = 90 + ($Sessions * 65)
    $maxH    = [int]($screenH * 0.9)
    $Height  = [Math]::Min($maxH, [Math]::Max(480, $desired))
}

$EdgeCandidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe"
)
$Edge = $EdgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Edge) {
    Write-Error "Edge not found. Install Microsoft Edge or edit start_widget.ps1."
    exit 2
}

# WinAPI helpers: force a window topmost, and un-minimize + raise it.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinTop {
    [DllImport("user32.dll")] public static extern bool SetWindowPos(
        IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int w, int h, bool repaint);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public static IntPtr HWND_TOPMOST    = new IntPtr(-1);
    public static IntPtr HWND_NOTOPMOST  = new IntPtr(-2);
    public const uint SWP_NOMOVE         = 0x0002;
    public const uint SWP_NOSIZE         = 0x0001;
    public const uint SWP_NOACTIVATE     = 0x0010;
    public const uint SWP_SHOWWINDOW     = 0x0040;
    public const int  SW_RESTORE         = 9;
}
"@ | Out-Null

function Set-WidgetTopmost([IntPtr]$hwnd) {
    # Un-minimize the widget, then pin it topmost. Edge re-applies the profile's
    # last (minimized) show-state a beat AFTER the window handle first appears,
    # so a single SW_RESTORE loses the race and the window stays parked at
    # -32000,-32000. Keep forcing SW_RESTORE until it stays un-minimized for a
    # few checks in a row. Position comes from --window-position, so a restore
    # brings it back on-screen without us moving it (which would fight a window
    # the user deliberately repositioned on the reuse path).
    $deadline = (Get-Date).AddSeconds(10)
    $stable = 0
    while ((Get-Date) -lt $deadline -and $stable -lt 4) {
        if ([WinTop]::IsIconic($hwnd)) {
            [void][WinTop]::ShowWindow($hwnd, [WinTop]::SW_RESTORE)
            $stable = 0
        } else {
            $stable++
        }
        Start-Sleep -Milliseconds 150
    }
    # If the window restored to an off-screen position — stale placement from a
    # monitor layout that's since changed, or the -32000 minimized sentinel —
    # pull it back on-screen. Only when *fully* off-screen, so a window the user
    # deliberately repositioned on-screen is left where they put it.
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $r = New-Object WinTop+RECT
    if ([WinTop]::GetWindowRect($hwnd, [ref]$r)) {
        $off = ($r.Right -le $vs.Left) -or ($r.Left -ge $vs.Right) -or `
               ($r.Bottom -le $vs.Top) -or ($r.Top -ge $vs.Bottom) -or ($r.Left -lt -30000)
        if ($off) {
            Write-Log ("rescue off-screen rect=({0},{1})-({2},{3}) -> 60,60" -f $r.Left,$r.Top,$r.Right,$r.Bottom)
            [void][WinTop]::MoveWindow($hwnd, 60, 60, $Width, $Height, $true)
        }
    }
    [void][WinTop]::SetWindowPos(
        $hwnd, [WinTop]::HWND_TOPMOST, 0, 0, 0, 0,
        [WinTop]::SWP_NOMOVE -bor [WinTop]::SWP_NOSIZE -bor [WinTop]::SWP_NOACTIVATE -bor [WinTop]::SWP_SHOWWINDOW)
    [void][WinTop]::SetForegroundWindow($hwnd)
}

# Taskbar icon: handed to a hidden, long-lived icon_keeper.ps1 rather than set
# here. An icon loaded with LoadImage belongs to the loading process and is
# destroyed when it exits, so setting it from this short-lived launcher left the
# window holding a dead handle — the taskbar then showed Edge's icon whenever it
# didn't happen to copy ours before we exited. The keeper owns the handles for
# the window's lifetime, re-applies them if Edge resets the icon, and exits when
# the window closes; a mutex keeps it to one keeper per window.
function Start-IconKeeper([IntPtr]$hwnd) {
    $src = Join-Path $PSScriptRoot "watchfire.ico"
    if (-not (Test-Path $src)) { Write-Log "watchfire.ico missing next to launcher; icon not overridden"; return }
    # Local copy: the taskbar reads the relaunch icon on its own schedule, and a
    # \\wsl.localhost path is unreadable whenever WSL isn't running.
    $ico = Join-Path $LogDir "watchfire.ico"
    try { Copy-Item -LiteralPath $src -Destination $ico -Force } catch { $ico = $src }
    $keeper = Join-Path $PSScriptRoot "icon_keeper.ps1"
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$keeper`"",
        '-Hwnd', [int64]$hwnd, '-Ico', "`"$ico`"", '-LogFile', "`"$LogFile`"") | Out-Null
    Write-Log "icon keeper requested for hwnd=$hwnd"
}

# Reuse an existing widget window if one is still around. Edge keeps the
# profile's process alive after the window is closed; a fresh launch then just
# hands off to that singleton and exits, sometimes without ever showing a
# window (or showing it minimized) — the "nothing happens" symptom. Restoring
# and raising the existing window is both correct and avoids a duplicate.
$existing = Get-Process -Name "msedge" -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match "Watchfire|Orchestrator|widget" } |
    Select-Object -First 1
if ($existing) {
    Write-Log ("reuse existing hwnd=" + $existing.MainWindowHandle + " title=[" + $existing.MainWindowTitle + "]")
    Set-WidgetTopmost $existing.MainWindowHandle
    Start-IconKeeper $existing.MainWindowHandle
    Write-Log "reuse done -> exit 0"
    exit 0
}
Write-Log "no existing widget window; fresh launch path"

# Dedicated profile dir so app windows don't fight with the user's regular Edge.
$ProfileDir = Join-Path $env:LOCALAPPDATA "OrchestratorWidget\EdgeProfile"
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

# Root cause of the recurring "widget opens minimized at -32000,-32000":
# Edge saves the app window's bounds together with the *work area* of the
# monitor it was last on. After a reboot / dock / monitor-layout change that
# monitor is gone, and Edge restores the window against it — landing it
# minimized. --window-position alone doesn't reliably override this, and the
# post-open SW_RESTORE loses the race because Edge minimizes it late.
#
# We reach this fresh-launch path only when no widget window exists (the reuse
# check above exited otherwise), so any lingering widget-profile Edge here is a
# windowless background singleton. Kill it (so its cached placement can't be
# handed off and Preferences isn't locked), then drop the saved placement so
# the next launch opens fresh at --window-position. Best-effort throughout.
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*OrchestratorWidget*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$prefFile = Join-Path $ProfileDir "Default\Preferences"
if (Test-Path $prefFile) {
    try {
        $prefs = Get-Content $prefFile -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($prefs.browser -and ($prefs.browser.PSObject.Properties.Name -contains "app_window_placement")) {
            $prefs.browser.PSObject.Properties.Remove("app_window_placement")
            ($prefs | ConvertTo-Json -Depth 100 -Compress) | Set-Content $prefFile -Encoding utf8
        }
    } catch { }
    Start-Sleep -Milliseconds 300
}

$EdgeArgs = @(
    "--app=$Url",
    "--user-data-dir=$ProfileDir",
    "--window-size=$Width,$Height",
    # No first-run prompts, no default-browser nag, no telemetry probes.
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-features=msEdgeSidebar,msImplicitSignin"
)
# Always open at an explicit on-screen position. If we let Edge restore the
# profile's saved placement instead, a reboot or monitor-layout change makes it
# restore onto a monitor that's gone — the window opens minimized at
# -32000,-32000 and it looks like "watchfire didn't launch". A fixed position
# defeats that. Callers can still override with -X/-Y.
if ($X -lt 0) { $X = 60 }
if ($Y -lt 0) { $Y = 60 }
$EdgeArgs += "--window-position=$X,$Y"

# Find the widget window that appeared at/after $since — by title, with a
# start-time fallback (the title can lag the handle). Zero after $timeoutSec.
function Find-WidgetWindow([datetime]$since, [int]$timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 200
        $m = Get-Process -Name "msedge" -ErrorAction SilentlyContinue |
             Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match "Watchfire|Orchestrator|widget" } |
             Select-Object -First 1
        if ($m) { return $m.MainWindowHandle }
        # Title can lag the handle — fall back to the newest window this launch spawned.
        $any = Get-Process -Name "msedge" -ErrorAction SilentlyContinue |
               Where-Object { $_.MainWindowHandle -ne 0 -and $_.StartTime -ge $since } |
               Sort-Object StartTime -Descending | Select-Object -First 1
        if ($any) { return $any.MainWindowHandle }
    }
    return [IntPtr]::Zero
}

# Launch, then wait for the window. A cold Edge right after a reboot sometimes
# never paints a window on the first try (it competes with Defender, Dropbox
# sync and Edge's own updater) — the "no window, no taskbar icon" symptom that
# a minute-later retry-by-hand always fixed. So retry the whole launch a few
# times: each extra attempt clears any windowless singleton the previous one
# left, relaunches, and polls again. We stop the instant a window shows, so the
# warm fast path pays for just one attempt.
$hwnd = [IntPtr]::Zero
$maxAttempts = 3
for ($attempt = 1; $attempt -le $maxAttempts -and $hwnd -eq [IntPtr]::Zero; $attempt++) {
    if ($attempt -gt 1) {
        Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like "*OrchestratorWidget*" } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 500
    }
    # Anchor so the fallback can't grab a pre-existing Edge window.
    $launchTime = (Get-Date).AddSeconds(-1)
    $proc = Start-Process -FilePath $Edge -ArgumentList $EdgeArgs -PassThru
    if (-not $proc) { Write-Log "attempt $attempt Start-Process returned null"; continue }
    Write-Log ("attempt $attempt/$maxAttempts launched pid=" + $proc.Id + ", polling 20s")
    $hwnd = Find-WidgetWindow $launchTime 20
    $found = if ($hwnd -eq [IntPtr]::Zero) { "NOT found" } else { "found hwnd=$hwnd" }
    Write-Log "attempt $attempt window $found"
}

if ($hwnd -eq [IntPtr]::Zero) {
    Write-Log "gave up after $maxAttempts attempts; no window to manage -> exit 0"
    Write-Verbose "Could not find widget window; it may open late and unmanaged."
    exit 0
}

Set-WidgetTopmost $hwnd
Write-Log "topmost + on-screen applied to hwnd=$hwnd"

Start-IconKeeper $hwnd

# Diagnostic only — run with -Verbose to see it; keeps the console clean.
Write-Verbose "ok hwnd=$hwnd"
