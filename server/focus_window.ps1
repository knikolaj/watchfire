# Focus a Windows Terminal window — and, if -TabName is given, switch to the
# tab whose title contains that string (uses UI Automation to enumerate the
# WT tab strip).
#
# Usage:
#   powershell.exe -NoProfile -File focus_window.ps1 [-TabName <substr>]
#
# Returns "ok" on success, "no_window" if no Windows Terminal window exists.
# Tab matching is best-effort — if no tab matches, we still focus the window.

param(
    [string]$ProcessName = "WindowsTerminal",
    [string]$TabName = ""
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinFocus {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
}
"@ | Out-Null

$wtProcs = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
             Where-Object { $_.MainWindowHandle -ne 0 })

if ($wtProcs.Count -eq 0) {
    Write-Output "no_window"
    exit 1
}

# Default target: first WT window. Overwritten if a matching tab is found.
$targetHwnd = $wtProcs[0].MainWindowHandle

if ($TabName) {
    $tabCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::TabItem
    )
    foreach ($p in $wtProcs) {
        $win = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
        if (-not $win) { continue }
        $tabs = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCondition)
        $found = $null
        foreach ($t in $tabs) {
            $n = $t.Current.Name
            if ($n -and ($n -eq $TabName -or $n -like "*$TabName*")) { $found = $t; break }
        }
        if ($found) {
            try {
                $sip = $found.GetCurrentPattern(
                    [System.Windows.Automation.SelectionItemPattern]::Pattern
                )
                if ($sip) { $sip.Select() }
            } catch { }
            $targetHwnd = $p.MainWindowHandle
            break
        }
    }
}

# AttachThreadInput trick — Windows requires the requesting thread to be
# attached to the foreground thread to allow SetForegroundWindow without
# focus-stealing prevention rejecting it.
$fg = [WinFocus]::GetForegroundWindow()
$fgPid = 0
$fgThread = [WinFocus]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$myThread = [WinFocus]::GetCurrentThreadId()

[void][WinFocus]::AttachThreadInput($myThread, $fgThread, $true)
[void][WinFocus]::ShowWindowAsync($targetHwnd, 9)   # SW_RESTORE
[void][WinFocus]::SetForegroundWindow($targetHwnd)
[void][WinFocus]::AttachThreadInput($myThread, $fgThread, $false)

Write-Output "ok"
