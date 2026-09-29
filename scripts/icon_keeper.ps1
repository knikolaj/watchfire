# Keeps the Watchfire taskbar icon alive for as long as the widget window lives.
#
# Why a separate, long-lived process: an icon loaded with LoadImage is a USER
# object owned by the process that loaded it, and Windows destroys it when that
# process exits. start_widget.ps1 used to load the icon, WM_SETICON it onto the
# window, and exit — leaving the window holding a dangling handle. Whether the
# taskbar showed our icon then depended on a race (did it copy the image before
# the launcher exited?); on a faster machine it lost, and the taskbar fell back
# to Edge's icon. This process owns the icon handles, so they stay valid.
#
# It also re-applies the icon if Edge resets it (e.g. on a page reload), and
# exits by itself once the window is gone. One keeper per window: a named mutex
# makes a second launch for the same hwnd a no-op.
#
# Started hidden by start_widget.ps1:
#   icon_keeper.ps1 -Hwnd <hwnd> -Ico <local .ico path> -LogFile <path>
param(
    [Parameter(Mandatory)] [long]   $Hwnd,
    [Parameter(Mandatory)] [string] $Ico,
    [string] $LogFile = ""
)

function Write-Log([string]$msg) {
    if (-not $LogFile) { return }
    try { Add-Content -Path $LogFile -Value ("{0}  [icon-keeper] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg) -Encoding utf8 } catch {}
}

$created = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\Watchfire.IconKeeper.$Hwnd", [ref]$created)
if (-not $created) { exit 0 }   # a keeper already owns this window

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class WfIcon {
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr LoadImage(IntPtr hinst, string name, uint type, int cx, int cy, uint load);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);

    const uint WM_GETICON = 0x007F, WM_SETICON = 0x0080, IMAGE_ICON = 1, LR_LOADFROMFILE = 0x0010;
    static readonly IntPtr ICON_SMALL = new IntPtr(0), ICON_BIG = new IntPtr(1);

    // Owned by this process for its whole life — that is the point.
    public static IntPtr Big, Small;

    public static bool Load(string ico) {
        Big   = LoadImage(IntPtr.Zero, ico, IMAGE_ICON, 32, 32, LR_LOADFROMFILE);
        Small = LoadImage(IntPtr.Zero, ico, IMAGE_ICON, 16, 16, LR_LOADFROMFILE);
        return Big != IntPtr.Zero && Small != IntPtr.Zero;
    }

    public static void SetIcons(IntPtr h) {
        SendMessage(h, WM_SETICON, ICON_BIG,   Big);
        SendMessage(h, WM_SETICON, ICON_SMALL, Small);
    }

    public static bool IsOurs(IntPtr h) {
        return SendMessage(h, WM_GETICON, ICON_BIG, IntPtr.Zero) == Big;
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        int GetCount(out uint c);
        int GetAt(uint i, out PROPERTYKEY k);
        int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
        int SetValue(ref PROPERTYKEY k, ref PROPVARIANT v);
        int Commit();
    }
    [StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public uint pid; }
    // Large enough for the PROPVARIANT union on both x86 (16B) and x64 (24B).
    [StructLayout(LayoutKind.Sequential)] struct PROPVARIANT { public ushort vt, r1, r2, r3; public IntPtr p, p2; }

    [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid riid, out IPropertyStore pv);
    [DllImport("ole32.dll")]   static extern int PropVariantClear(ref PROPVARIANT pv);

    static Guid IID_IPropertyStore = new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");
    // PKEY_AppUserModel_* all share this fmtid; the pid selects the property.
    static Guid FMT = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

    static void SetStr(IPropertyStore store, uint pid, string val) {
        var key = new PROPERTYKEY { fmtid = FMT, pid = pid };
        // VT_LPWSTR built by hand — InitPropVariantFromString is a header inline
        // and isn't exported from propsys.dll on every Windows build.
        var pv = new PROPVARIANT { vt = 31, p = Marshal.StringToCoTaskMemUni(val) };
        store.SetValue(ref key, ref pv);   // store copies it
        PropVariantClear(ref pv);
    }

    // Our own AUMID ungroups the window from Edge's taskbar button; the relaunch
    // icon is what the taskbar shows for that identity (and when pinned).
    public static void SetIdentity(IntPtr h, string aumid, string ico, string name) {
        IPropertyStore store;
        if (SHGetPropertyStoreForWindow(h, ref IID_IPropertyStore, out store) != 0 || store == null) return;
        SetStr(store, 5, aumid);        // PKEY_AppUserModel_ID
        SetStr(store, 3, ico + ",0");   // PKEY_AppUserModel_RelaunchIconResource
        SetStr(store, 4, name);         // PKEY_AppUserModel_RelaunchDisplayNameResource
        store.Commit();
        Marshal.ReleaseComObject(store);
    }
}
"@ | Out-Null

$h = [IntPtr]$Hwnd
if (-not [WfIcon]::Load($Ico)) { Write-Log "could not load $Ico - exiting"; exit 1 }

[WfIcon]::SetIdentity($h, "Watchfire.Widget", $Ico, "Watchfire")
[WfIcon]::SetIcons($h)
Write-Log "holding icon for hwnd=$Hwnd"

while ([WfIcon]::IsWindow($h)) {
    Start-Sleep -Seconds 5
    if ([WfIcon]::IsWindow($h) -and -not [WfIcon]::IsOurs($h)) {
        [WfIcon]::SetIcons($h)
        Write-Log "icon was reset by Edge - re-applied"
    }
}
Write-Log "window hwnd=$Hwnd closed - exiting"
$mutex.ReleaseMutex()
