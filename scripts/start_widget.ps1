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
    [int]   $Sessions = 0     # session count from watchfire CLI; drives auto-height
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

# WinAPI helpers: force a window topmost, and un-minimize + raise it.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinTop {
    [DllImport("user32.dll")] public static extern bool SetWindowPos(
        IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
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
    # Un-minimize first: a widget restored from a previous session can come back
    # parked at -32000,-32000 (minimized), and SWP_NOMOVE|NOSIZE never shows it.
    [void][WinTop]::ShowWindow($hwnd, [WinTop]::SW_RESTORE)
    [void][WinTop]::SetWindowPos(
        $hwnd, [WinTop]::HWND_TOPMOST, 0, 0, 0, 0,
        [WinTop]::SWP_NOMOVE -bor [WinTop]::SWP_NOSIZE -bor [WinTop]::SWP_NOACTIVATE -bor [WinTop]::SWP_SHOWWINDOW)
    [void][WinTop]::SetForegroundWindow($hwnd)
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
    Set-WidgetTopmost $existing.MainWindowHandle
    Write-Verbose ("reused existing widget hwnd=" + $existing.MainWindowHandle)
    exit 0
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

# Anchor the fallback so it can never grab the user's pre-existing Edge window:
# only msedge processes that started at/after this launch are ours.
$launchTime = (Get-Date).AddSeconds(-1)
$proc = Start-Process -FilePath $Edge -ArgumentList $EdgeArgs -PassThru
if (-not $proc) {
    Write-Error "Failed to start Edge."
    exit 3
}

# msedge spawns child processes; the window we want belongs to one of them
# (typically the first child that gains a non-zero MainWindowHandle). A cold
# Edge on Windows can take well over 6s to paint its first window, so poll
# generously — otherwise always-on-top silently doesn't get applied.
$deadline = (Get-Date).AddSeconds(15)
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
    # Fallback: newest msedge window started by *this* launch — the title can
    # lag behind the window handle, so a match-by-title miss shouldn't strand us.
    if ($hwnd -eq [IntPtr]::Zero) {
        $any = Get-Process -Name "msedge" -ErrorAction SilentlyContinue |
               Where-Object { $_.MainWindowHandle -ne 0 -and $_.StartTime -ge $launchTime } |
               Sort-Object StartTime -Descending |
               Select-Object -First 1
        if ($any) { $hwnd = $any.MainWindowHandle }
    }
}

if ($hwnd -eq [IntPtr]::Zero) {
    Write-Verbose "Could not find widget window for always-on-top; window opened normally."
    exit 0
}

Set-WidgetTopmost $hwnd

# Taskbar icon override.
#
# Edge --app windows inherit Edge's AppUserModelId (AUMID), so Windows groups
# the widget under Edge's taskbar button and paints Edge's icon. Edge used to
# derive a per-app icon from the page favicon, but a 2026 Edge update dropped
# that for plain --app windows, leaving the generic Edge icon. (The in-window
# title-bar icon still comes from the favicon and is unaffected.)
#
# Fix it at the Windows-shell level, independent of Edge's behavior:
#   1. WM_SETICON  → sets the Alt+Tab / title-bar icon from our .ico.
#   2. Give the window our OWN AUMID + RelaunchIconResource via its property
#      store, so the taskbar ungroups it from Edge and paints our icon.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class WfIcon {
    [DllImport("user32.dll")]
    static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr LoadImage(IntPtr hinst, string name, uint type, int cx, int cy, uint load);

    const uint WM_SETICON = 0x0080, IMAGE_ICON = 1, LR_LOADFROMFILE = 0x0010;
    static readonly IntPtr ICON_SMALL = new IntPtr(0), ICON_BIG = new IntPtr(1);

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        int GetCount(out uint c);
        int GetAt(uint i, out PROPERTYKEY k);
        int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
        int SetValue(ref PROPERTYKEY k, ref PROPVARIANT v);
        int Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY { public Guid fmtid; public uint pid; }

    // Large enough for the PROPVARIANT union on both x86 (16B) and x64 (24B).
    [StructLayout(LayoutKind.Sequential)]
    struct PROPVARIANT { public ushort vt, r1, r2, r3; public IntPtr p, p2; }

    [DllImport("shell32.dll")]
    static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid riid, out IPropertyStore pv);
    [DllImport("ole32.dll")]
    static extern int PropVariantClear(ref PROPVARIANT pv);

    const ushort VT_LPWSTR = 31;

    static Guid IID_IPropertyStore = new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");
    // PKEY_AppUserModel_* all share this fmtid; the pid selects the property.
    static Guid FMT = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

    static void SetStr(IPropertyStore store, uint pid, string val) {
        var key = new PROPERTYKEY { fmtid = FMT, pid = pid };
        // Build a VT_LPWSTR PROPVARIANT by hand — InitPropVariantFromString is
        // an inline header helper and isn't exported from propsys.dll on every
        // Windows build. The union's first pointer slot holds the LPWSTR.
        var pv = new PROPVARIANT { vt = VT_LPWSTR, p = Marshal.StringToCoTaskMemUni(val) };
        store.SetValue(ref key, ref pv);   // store makes its own copy
        PropVariantClear(ref pv);          // frees our LPWSTR allocation
    }

    public static void Apply(IntPtr hwnd, string ico, string aumid, string name) {
        IntPtr big   = LoadImage(IntPtr.Zero, ico, IMAGE_ICON, 32, 32, LR_LOADFROMFILE);
        IntPtr small = LoadImage(IntPtr.Zero, ico, IMAGE_ICON, 16, 16, LR_LOADFROMFILE);
        if (big   != IntPtr.Zero) SendMessage(hwnd, WM_SETICON, ICON_BIG,   big);
        if (small != IntPtr.Zero) SendMessage(hwnd, WM_SETICON, ICON_SMALL, small);

        IPropertyStore store;
        if (SHGetPropertyStoreForWindow(hwnd, ref IID_IPropertyStore, out store) == 0 && store != null) {
            SetStr(store, 5, aumid);           // PKEY_AppUserModel_ID
            SetStr(store, 3, ico + ",0");      // PKEY_AppUserModel_RelaunchIconResource
            if (!string.IsNullOrEmpty(name))
                SetStr(store, 4, name);        // PKEY_AppUserModel_RelaunchDisplayNameResource
            store.Commit();
            Marshal.ReleaseComObject(store);
        }
    }
}
"@ | Out-Null

$IcoPath = Join-Path $PSScriptRoot "watchfire.ico"
if (Test-Path $IcoPath) {
    try {
        [WfIcon]::Apply($hwnd, $IcoPath, "Watchfire.Widget", "Watchfire")
    } catch {
        Write-Warning "Could not apply custom taskbar icon: $_"
    }
} else {
    Write-Warning "watchfire.ico not found next to start_widget.ps1; taskbar icon not overridden."
}

# Diagnostic only — run with -Verbose to see it; keeps the console clean.
Write-Verbose "ok hwnd=$hwnd"
