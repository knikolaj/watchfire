#!/usr/bin/env bash
# Install Watchfire's machine wiring from this checkout.
#
#   deploy/install.sh            install / update
#   deploy/install.sh --dry-run  print what would be written, change nothing
#
# Renders the templates in deploy/ with this machine's values (checkout path,
# node binary, Windows user dirs, WSL distro name) and puts them in place:
#   bin/watchfire              -> ~/.local/bin/watchfire            (symlink)
#   watchfire.service.in       -> ~/.config/systemd/user/watchfire.service
#   boot-widget.sh.in          -> ~/.watchfire/boot-widget.sh
#   watchfire-boot.vbs.in      -> Windows Startup folder (widget at logon)
# and installs server deps if they are missing.
#
# Idempotent. Re-run after: upgrading node via nvm, moving the checkout,
# a new Windows username or WSL distro name — all of those are baked into
# the rendered files.
#
# Not handled here: the Claude/Codex hook configs (see README, Setup).
set -euo pipefail

DRY=0
case "${1:-}" in
    --dry-run) DRY=1 ;;
    "") ;;
    *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

WF_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
TPL="$WF_DIR/deploy"

die() { echo "install: $*" >&2; exit 1; }

# --- machine values --------------------------------------------------------
NODE_BIN="$(command -v node)" || die "node is not on PATH — run from a shell where nvm is loaded"
DISTRO="${WSL_DISTRO_NAME:-}"
[[ -n $DISTRO ]] || die "WSL_DISTRO_NAME is empty — this must run inside WSL"
command -v cmd.exe >/dev/null || die "cmd.exe is not reachable — Windows interop is off"

# cmd.exe warns about UNC paths when started from a \\wsl$ cwd, so run it from /mnt/c.
win_env() { (cd /mnt/c && cmd.exe /c "echo %$1%" 2>/dev/null) | tr -d '\r'; }
WIN_HOME="$(wslpath -u "$(win_env USERPROFILE)")"
WIN_APPDATA="$(wslpath -u "$(win_env APPDATA)")"
[[ -d $WIN_HOME ]] || die "Windows profile not found: $WIN_HOME"
STARTUP_DIR="$WIN_APPDATA/Microsoft/Windows/Start Menu/Programs/Startup"
[[ -d $STARTUP_DIR ]] || die "Windows Startup folder not found: $STARTUP_DIR"

WIN_INTEROP_PATH="/mnt/c/WINDOWS/system32:/mnt/c/WINDOWS:/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0:$WIN_HOME/AppData/Local/Microsoft/WindowsApps"

# --- helpers ---------------------------------------------------------------
render() {
    local s
    s="$(<"$1")"
    s=${s//@WF_DIR@/$WF_DIR}
    s=${s//@NODE_BIN@/$NODE_BIN}
    s=${s//@HOME@/$HOME}
    s=${s//@WIN_INTEROP_PATH@/$WIN_INTEROP_PATH}
    s=${s//@DISTRO@/$DISTRO}
    if grep -qE '@[A-Z_]+@' <<<"$s"; then
        die "unrendered placeholder in $(basename "$1"): $(grep -oE '@[A-Z_]+@' <<<"$s" | sort -u | tr '\n' ' ')"
    fi
    printf '%s\n' "$s"
}

# Write generated content to $2. A symlink in the way (e.g. an older setup that
# linked the unit from dotfiles) is replaced by the generated file.
place() {
    local content="$1" dst="$2" mode="${3:-644}"
    if (( DRY )); then
        printf '\n----- would write %s (mode %s) -----\n%s\n' "$dst" "$mode" "$content"
        return
    fi
    mkdir -p "$(dirname "$dst")"
    [[ -L $dst ]] && rm "$dst"
    printf '%s\n' "$content" > "$dst"
    chmod "$mode" "$dst"
    echo "  wrote   $dst"
}

run() { if (( DRY )); then echo "  would run: $*"; else "$@"; fi; }

echo "Watchfire checkout : $WF_DIR"
echo "node               : $NODE_BIN"
echo "Windows profile    : $WIN_HOME"
echo "WSL distro         : $DISTRO"
(( DRY )) && echo "(dry run — nothing will be changed)"
echo

# --- 1. server deps --------------------------------------------------------
echo "Server deps:"
if [[ -d $WF_DIR/server/node_modules ]]; then
    echo "  ok      server/node_modules present"
else
    run npm ci --prefix "$WF_DIR/server"
fi

# --- 2. CLI on PATH --------------------------------------------------------
echo "CLI:"
cli_dst="$HOME/.local/bin/watchfire"
if [[ -e $cli_dst && ! -L $cli_dst ]]; then
    die "$cli_dst exists and is not a symlink — remove it by hand"
elif [[ -L $cli_dst && "$(readlink -f "$cli_dst")" == "$WF_DIR/bin/watchfire" ]]; then
    echo "  ok      $cli_dst"
else
    run mkdir -p "$HOME/.local/bin"
    run ln -sfn "$WF_DIR/bin/watchfire" "$cli_dst"
    (( DRY )) || echo "  linked  $cli_dst -> $WF_DIR/bin/watchfire"
fi

# --- 3. systemd unit -------------------------------------------------------
echo "systemd unit:"
# Render into a variable first: under `set -e`, a failing $(render ...) passed
# straight as an argument would not stop the script, and an empty file would
# be written. An assignment does propagate the failure.
unit="$(render "$TPL/watchfire.service.in")"
place "$unit" "$HOME/.config/systemd/user/watchfire.service"
if (( DRY )); then
    echo "  would run: systemctl --user daemon-reload; enable + restart watchfire.service"
elif systemctl --user daemon-reload 2>/dev/null; then
    systemctl --user enable watchfire.service >/dev/null 2>&1
    systemctl --user restart watchfire.service
    echo "  enabled + restarted watchfire.service"
else
    echo "  ⚠ systemd --user is not available: set systemd=true in /etc/wsl.conf," >&2
    echo "    restart WSL, then re-run this installer" >&2
fi

# --- 4. autostart at Windows logon -----------------------------------------
echo "Widget autostart:"
boot_sh="$(render "$TPL/boot-widget.sh.in")"
boot_vbs="$(render "$TPL/watchfire-boot.vbs.in")"
place "$boot_sh" "$HOME/.watchfire/boot-widget.sh" 755
place "$boot_vbs" "$STARTUP_DIR/watchfire-boot.vbs"

# --- 5. linger -------------------------------------------------------------
# Without linger, user services start only when a login shell opens — not when
# WSL boots — so the server would be down whenever the VBS wakes WSL at logon.
echo "Linger:"
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" == yes ]]; then
    echo "  ok      enabled for $USER"
else
    echo "  ⚠ not enabled — run once:  sudo loginctl enable-linger $USER" >&2
fi

echo
echo "Done. Hook configs for Claude/Codex are separate — see README, Setup."
