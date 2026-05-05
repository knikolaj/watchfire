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
    [int]   $X        = -1,   # -1 = "let Windows decide"
    [int]   $Y        = -1,
    [int]   $Sessions = 0     # session count from orch CLI; drives auto-height
)

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

# Dedicated profile dir so app windows don't fight with the user's regular Edge.
$ProfileDir = Join-Path $env:LOCALAPPDATA "OrchestratorWidget\EdgeProfile"
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

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
if ($X -ge 0 -and $Y -ge 0) { $EdgeArgs += "--window-position=$X,$Y" }

$proc = Start-Process -FilePath $Edge -ArgumentList $EdgeArgs -PassThru
if (-not $proc) {
    Write-Error "Failed to start Edge."
    exit 3
}

# WinAPI: SetWindowPos with HWND_TOPMOST.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinTop {
    [DllImport("user32.dll")] public static extern bool SetWindowPos(
        IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    public static IntPtr HWND_TOPMOST    = new IntPtr(-1);
    public static IntPtr HWND_NOTOPMOST  = new IntPtr(-2);
    public const uint SWP_NOMOVE         = 0x0002;
    public const uint SWP_NOSIZE         = 0x0001;
    public const uint SWP_NOACTIVATE     = 0x0010;
    public const uint SWP_SHOWWINDOW     = 0x0040;
}
"@ | Out-Null

# msedge spawns child processes; the window we want belongs to one of them
# (typically the first child that gains a non-zero MainWindowHandle).
# Poll up to ~6 seconds.
$deadline = (Get-Date).AddSeconds(6)
$hwnd = [IntPtr]::Zero

while ((Get-Date) -lt $deadline -and $hwnd -eq [IntPtr]::Zero) {
    Start-Sleep -Milliseconds 200
    # Refresh handles on the original process AND on any msedge children.
    $candidates = @($proc) + (Get-Process -Name "msedge" -ErrorAction SilentlyContinue)
    foreach ($p in $candidates) {
        try { $p.Refresh() } catch {}
        if ($p.MainWindowHandle -ne 0 -and $p.MainWindowTitle -match "Watchfire|Orchestrator|widget") {
            $hwnd = $p.MainWindowHandle
            break
        }
    }
    # Fallback: any msedge with a window — only one --app window is starting now.
    if ($hwnd -eq [IntPtr]::Zero) {
        $any = Get-Process -Name "msedge" -ErrorAction SilentlyContinue |
               Where-Object { $_.MainWindowHandle -ne 0 } |
               Sort-Object StartTime -Descending |
               Select-Object -First 1
        if ($any) { $hwnd = $any.MainWindowHandle }
    }
}

if ($hwnd -eq [IntPtr]::Zero) {
    Write-Warning "Could not find widget window for always-on-top; window opened normally."
    exit 0
}

[void][WinTop]::SetWindowPos(
    $hwnd, [WinTop]::HWND_TOPMOST,
    0, 0, 0, 0,
    [WinTop]::SWP_NOMOVE -bor [WinTop]::SWP_NOSIZE -bor [WinTop]::SWP_NOACTIVATE -bor [WinTop]::SWP_SHOWWINDOW)

Write-Output "ok hwnd=$hwnd"
