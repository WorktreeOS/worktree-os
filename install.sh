#!/bin/sh
# WorktreeOS (`wos`) installer for macOS and Linux.
#
# Downloads the prebuilt `wos` binary from GitHub Releases and installs it into
# a per-user bin directory (no sudo required).
#
# Quick install:
#   curl -fsSL https://raw.githubusercontent.com/WorktreeOS/worktree-os/main/install.sh | sh
#
# Environment overrides:
#   WOS_VERSION       Tag to install (e.g. v0.1.0). Default: latest release.
#   WOS_INSTALL_DIR   Install directory.            Default: $HOME/.local/bin

set -eu

REPO="WorktreeOS/worktree-os"
BIN="wos"
INSTALL_DIR="${WOS_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${WOS_VERSION:-latest}"
API="https://api.github.com/repos/$REPO"

# --- helpers ----------------------------------------------------------------

info() { printf '\033[0;36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[0;33mwarning:\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[0;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# download URL OUTFILE — OUTFILE "-" writes the body to stdout. curl or wget.
download() {
  _url="$1"; _out="$2"
  if command -v curl >/dev/null 2>&1; then
    if [ "$_out" = "-" ]; then
      curl -fsSL --proto '=https' --tlsv1.2 "$_url"
    else
      curl -fSL --proto '=https' --tlsv1.2 -o "$_out" "$_url"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if [ "$_out" = "-" ]; then wget -qO- "$_url"; else wget -qO "$_out" "$_url"; fi
  else
    die "neither curl nor wget found; install one and retry"
  fi
}

# --- detect platform --------------------------------------------------------

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin)
    case "$arch" in
      arm64|aarch64) suffix="macos-arm64" ;;
      *) die "unsupported macOS arch '$arch'. Prebuilt binaries are Apple Silicon (arm64) only; build from source with 'bun run build:binary'." ;;
    esac
    ;;
  Linux)
    case "$arch" in
      x86_64|amd64) suffix="linux-amd64" ;;
      *) die "unsupported Linux arch '$arch'. Prebuilt binaries are amd64 only; build from source with 'bun run build:binary'." ;;
    esac
    ;;
  *)
    die "unsupported OS '$os'. On Windows use install.ps1 instead."
    ;;
esac

# --- resolve version --------------------------------------------------------

if [ "$VERSION" = "latest" ]; then
  info "Resolving latest release..."
  VERSION="$(
    download "$API/releases/latest" - \
      | grep '"tag_name"' | head -1 \
      | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
  )" || true
  [ -n "$VERSION" ] || die "could not resolve the latest release tag. Set WOS_VERSION=vX.Y.Z and retry."
fi

asset="wos-${VERSION}-${suffix}"
url="https://github.com/$REPO/releases/download/${VERSION}/${asset}"

# Always (re)download and overwrite — when a build already exists this updates
# it, so re-running the installer doubles as an updater. There is no
# "already installed, skip" shortcut on purpose.
if [ -x "$INSTALL_DIR/$BIN" ] || command -v "$BIN" >/dev/null 2>&1; then
  action="Updating"
else
  action="Installing"
fi

# --- download & install -----------------------------------------------------

info "$action $BIN to $VERSION ($suffix)"
info "Downloading $url"

tmp="$(mktemp "${TMPDIR:-/tmp}/wos.XXXXXX")"
trap 'rm -f "$tmp"' EXIT INT TERM

download "$url" "$tmp" || die "download failed. Check that release '$VERSION' has asset '$asset'."
[ -s "$tmp" ] || die "downloaded file is empty"

mkdir -p "$INSTALL_DIR"
chmod +x "$tmp"
mv -f "$tmp" "$INSTALL_DIR/$BIN"
trap - EXIT INT TERM

info "Installed to $INSTALL_DIR/$BIN"

# --- PATH guidance ----------------------------------------------------------

case ":$PATH:" in
  *":$INSTALL_DIR:"*) : ;;
  *)
    warn "$INSTALL_DIR is not on your PATH."
    printf '  Add it by appending this line to your shell profile (~/.zshrc, ~/.bashrc, ...):\n\n'
    printf '    export PATH="%s:$PATH"\n\n' "$INSTALL_DIR"
    ;;
esac

# --- run setup --------------------------------------------------------------
# Finish installation by configuring ~/.wos/config.json. Under `curl ... | sh`
# the binary's stdin is usually not a TTY, so its own wizard would silently
# apply defaults. Instead we run the survey HERE — reading from /dev/tty, which
# is reliable — and delegate the answers to a non-interactive `wos init --yes`
# with flags. This writes the config without starting the daemon. Call the
# binary by full path since $INSTALL_DIR may not be on PATH in this shell yet.

# ask PROMPT DEFAULT — prompt on /dev/tty, return the answer (default if empty).
ask() {
  printf '%s [%s]: ' "$1" "$2" >/dev/tty
  read -r _ans </dev/tty || _ans=""
  if [ -z "$_ans" ]; then printf '%s\n' "$2"; else printf '%s\n' "$_ans"; fi
}

# confirm PROMPT DEFAULT(y/n) — return 0 for yes, 1 for no (default if empty).
confirm() {
  if [ "$2" = "y" ]; then _hint="Y/n"; else _hint="y/N"; fi
  printf '%s (%s) ' "$1" "$_hint" >/dev/tty
  read -r _ans </dev/tty || _ans=""
  if [ -z "$_ans" ]; then _ans="$2"; fi
  case "$_ans" in
    [Yy] | [Yy][Ee][Ss]) return 0 ;;
    *) return 1 ;;
  esac
}

info "Starting wos setup ('$BIN init')..."
set -- init --yes
if { : </dev/tty; } 2>/dev/null; then
  bind_addr="$(ask 'Daemon bind address' '127.0.0.1')"
  set -- "$@" --host "$bind_addr"

  web_port="$(ask 'Web UI port' '4949')"
  set -- "$@" --port "$web_port"

  # Let the binary pick the backend after detect/install; we only opt into the
  # tmux install when it is missing and the user agrees.
  if command -v tmux >/dev/null 2>&1; then
    info "tmux detected — the tmux terminal backend will be used."
  elif confirm 'Install tmux for stable terminal sessions?' 'y'; then
    set -- "$@" --install-tmux
  fi

  if command -v claude >/dev/null 2>&1 || command -v opencode >/dev/null 2>&1; then
    if confirm 'Install wos agent plugins for detected agents (claude/opencode)?' 'y'; then
      set -- "$@" --install-plugins
    fi
  fi
else
  warn "No interactive terminal; applying defaults. Re-run '$BIN init' to customize."
fi

if ! "$INSTALL_DIR/$BIN" "$@"; then
  warn "setup did not finish (Docker may be missing); run '$BIN init' to complete it."
fi

# --- next steps -------------------------------------------------------------

printf '\n'
info "Setup complete. Next steps:"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) : ;;
  *) printf '    export PATH="%s:$PATH"\n' "$INSTALL_DIR" ;;
esac
printf '    %s start\n' "$BIN"
