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
# Hand off to the wos setup wizard (`wos init`) to finish installation. Call it
# by full path since $INSTALL_DIR may not be on PATH in this shell yet. Probe
# whether a controlling terminal can actually be opened (not just stat'd) — if
# so, re-attach it so the wizard can prompt even under `curl ... | sh`;
# otherwise run non-interactively (the wizard applies defaults without a TTY).
info "Starting wos setup ('$BIN init')..."
if { : </dev/tty; } 2>/dev/null; then
  "$INSTALL_DIR/$BIN" init </dev/tty || warn "setup did not finish; run '$BIN init' to complete it."
else
  "$INSTALL_DIR/$BIN" init || warn "setup did not finish; run '$BIN init' to complete it."
fi
