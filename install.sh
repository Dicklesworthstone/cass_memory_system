#!/usr/bin/env bash
set -euo pipefail
umask 022

VERSION="${VERSION:-}"
OWNER="${OWNER:-Dicklesworthstone}"
REPO="${REPO:-cass_memory_system}"
DEST_DEFAULT="$HOME/.local/bin"
DEST="${DEST:-$DEST_DEFAULT}"
EASY=0
QUIET=0
VERIFY=0
FROM_SOURCE=0
CHECKSUM="${CHECKSUM:-}"
CHECKSUM_URL="${CHECKSUM_URL:-}"
ARTIFACT_URL="${ARTIFACT_URL:-}"
LOCK_FILE="/tmp/cass-memory-install.$$.lock"
SYSTEM=0

log() {
  [ "$QUIET" -eq 1 ] && return 0
  echo -e "$@"
}
info() { log "\033[0;34m→\033[0m $*"; }
ok() { log "\033[0;32m✓\033[0m $*"; }
warn() { log "\033[1;33m⚠\033[0m $*"; }
err() { log "\033[0;31m✗\033[0m $*"; }

resolve_version() {
  if [ -n "$VERSION" ]; then return 0; fi

  info "Resolving latest version..."
  # Use redirect-based resolution instead of GitHub API to avoid rate limits
  # and eliminate JSON parsing dependencies (grep/sed/jq)
  local latest_url="https://github.com/${OWNER}/${REPO}/releases/latest"
  local final_url
  final_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$latest_url" 2>/dev/null || true)"
  local tag="${final_url##*/}"

  if [ -n "$tag" ] && [ "$tag" != "latest" ]; then
    VERSION="$tag"
    info "Resolved latest version: $VERSION"
  else
    VERSION="v0.1.0"
    warn "Could not resolve latest version; defaulting to $VERSION"
  fi
}

maybe_add_path() {
  case ":$PATH:" in
  *:"$DEST":*)
    return 0
    ;;
  *)
    if [ "$EASY" -eq 1 ]; then
      UPDATED=0
      for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
        if [ -e "$rc" ] && [ -w "$rc" ]; then
          if ! grep -F "$DEST" "$rc" >/dev/null 2>&1; then
            echo "export PATH=\"$DEST:\$PATH\"" >>"$rc"
          fi
          UPDATED=1
        fi
      done
      if [ "$UPDATED" -eq 1 ]; then
        warn "PATH updated in ~/.zshrc/.bashrc; restart shell to use cm"
      else
        warn "Add $DEST to PATH to use cm"
      fi
    else
      warn "Add $DEST to PATH to use cm"
    fi
    ;;
  esac
}

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then return 0; fi
  if [ "$EASY" -ne 1 ]; then
    if [ -t 0 ]; then
      echo -n "Install Bun? (y/N): "
      read -r ans
      case "$ans" in y | Y) : ;; *)
        warn "Skipping bun install"
        return 1
        ;;
      esac
    else
      # Non-interactive mode without --easy-mode: auto-install with warning
      warn "Non-interactive mode: auto-installing Bun (use --easy-mode to suppress this warning)"
    fi
  fi
  info "Installing Bun"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
}

usage() {
  cat <<EOFU
Usage: install.sh [--version vX.Y.Z] [--dest DIR] [--system] [--easy-mode] [--verify]
                  [--artifact-url URL] [--checksum HEX] [--checksum-url URL] [--quiet]

Options:
  --version vX.Y.Z    Install specific version (default: latest)
  --dest DIR          Install to DIR (default: ~/.local/bin)
  --system            Install to /usr/local/bin (requires sudo)
  --easy-mode         Non-interactive, auto-configure PATH
  --verify            Run self-test after install
  --from-source       Build from source (requires bun)
  --artifact-url URL  Use custom artifact URL
  --checksum HEX      Expected SHA256 checksum
  --checksum-url URL  URL to fetch checksum from
  --quiet             Suppress output

Examples:
  # Fast path: auto-install + verify
  curl -fsSL https://raw.githubusercontent.com/${OWNER}/${REPO}/main/install.sh | bash -s -- --easy-mode --verify

  # Specific version
  install.sh --version v0.1.0 --verify
EOFU
}

while [ $# -gt 0 ]; do
  case "$1" in
  --version)
    VERSION="$2"
    shift 2
    ;;
  --dest)
    DEST="$2"
    shift 2
    ;;
  --system)
    SYSTEM=1
    DEST="/usr/local/bin"
    shift
    ;;
  --easy-mode)
    EASY=1
    shift
    ;;
  --verify)
    VERIFY=1
    shift
    ;;
  --artifact-url)
    ARTIFACT_URL="$2"
    shift 2
    ;;
  --checksum)
    CHECKSUM="$2"
    shift 2
    ;;
  --checksum-url)
    CHECKSUM_URL="$2"
    shift 2
    ;;
  --from-source)
    FROM_SOURCE=1
    shift
    ;;
  --quiet | -q)
    QUIET=1
    shift
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *) shift ;;
  esac
done

resolve_version

# Create destination directory (use sudo for system installs)
if [ "$SYSTEM" -eq 1 ]; then
  sudo mkdir -p "$DEST" || {
    err "Failed to create $DEST"
    exit 1
  }
else
  mkdir -p "$DEST" || {
    err "Failed to create $DEST"
    exit 1
  }
fi

OS=$(uname -s | tr 'A-Z' 'a-z')
ARCH=$(uname -m)
case "$ARCH" in
x86_64 | amd64) ARCH="x64" ;;
arm64 | aarch64) ARCH="arm64" ;;
*) warn "Unknown arch $ARCH, using as-is" ;;
esac

# Map to Bun target naming (only platforms we actually build)
ARTIFACT=""
case "${OS}-${ARCH}" in
linux-x64) ARTIFACT="cass-memory-linux-x64" ;;
darwin-x64) ARTIFACT="cass-memory-macos-x64" ;;
darwin-arm64) ARTIFACT="cass-memory-macos-arm64" ;;
*) : ;;
esac

URL=""
if [ "$FROM_SOURCE" -eq 0 ]; then
  if [ -n "$ARTIFACT_URL" ]; then
    ARTIFACT=$(basename "$ARTIFACT_URL")
    URL="$ARTIFACT_URL"
  elif [ -n "$ARTIFACT" ]; then
    URL="https://github.com/${OWNER}/${REPO}/releases/download/${VERSION}/${ARTIFACT}"
  else
    warn "No prebuilt artifact for ${OS}/${ARCH}; falling back to build-from-source"
    FROM_SOURCE=1
  fi
fi

# Try to acquire lock (flock not available on macOS, so gracefully degrade)
LOCKED=0
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE" || true
  if flock -n 9 2>/dev/null; then
    LOCKED=1
  else
    err "Another installer is running (lock $LOCK_FILE)"
    exit 1
  fi
fi

cleanup() {
  rm -rf "$TMP"
  if [ "$LOCKED" -eq 1 ]; then rm -f "$LOCK_FILE"; fi
}

TMP=$(mktemp -d)
trap cleanup EXIT

if [ "$FROM_SOURCE" -eq 0 ]; then
  info "Downloading $URL"
  if ! curl -fsSL "$URL" -o "$TMP/$ARTIFACT"; then
    warn "Artifact download failed; falling back to build-from-source"
    FROM_SOURCE=1
  fi
fi

if [ "$FROM_SOURCE" -eq 1 ]; then
  info "Building from source (requires git, bun)"
  ensure_bun || {
    err "Bun required for source build"
    exit 1
  }
  git clone --depth 1 "https://github.com/${OWNER}/${REPO}.git" "$TMP/src"
  (cd "$TMP/src" && bun install && bun run build)
  BIN="$TMP/src/dist/cass-memory"
  [ -x "$BIN" ] || {
    err "Build failed"
    exit 1
  }
  if [ "$SYSTEM" -eq 1 ]; then
    sudo install -m 0755 "$BIN" "$DEST/cm"
  else
    install -m 0755 "$BIN" "$DEST/cm"
  fi
  ok "Installed to $DEST/cm (source build)"
  maybe_add_path
  if [ "$VERIFY" -eq 1 ]; then
    if "$DEST/cm" --version; then
      ok "Self-test passed"
    else
      warn "Self-test failed (cm --version returned non-zero)"
    fi
  fi
  ok "Done. Run: cm --help"
  exit 0
fi

# Checksum verification
if [ -z "$CHECKSUM" ]; then
  [ -z "$CHECKSUM_URL" ] && CHECKSUM_URL="${URL}.sha256"
  info "Fetching checksum from ${CHECKSUM_URL}"
  CHECKSUM_FILE="$TMP/checksum.sha256"
  if curl -fsSL "$CHECKSUM_URL" -o "$CHECKSUM_FILE" 2>/dev/null; then
    CHECKSUM=$(awk '{print $1}' "$CHECKSUM_FILE")
  fi
fi

if [ -n "$CHECKSUM" ]; then
  # Use shasum on macOS, sha256sum on Linux
  if command -v sha256sum >/dev/null 2>&1; then
    echo "$CHECKSUM  $TMP/$ARTIFACT" | sha256sum -c - || {
      err "Checksum mismatch"
      exit 1
    }
    ok "Checksum verified"
  elif command -v shasum >/dev/null 2>&1; then
    echo "$CHECKSUM  $TMP/$ARTIFACT" | shasum -a 256 -c - || {
      err "Checksum mismatch"
      exit 1
    }
    ok "Checksum verified"
  else
    warn "No sha256 tool found; skipping checksum verification"
  fi
else
  warn "No checksum available; skipping verification"
fi

BIN="$TMP/$ARTIFACT"
[ -f "$BIN" ] || {
  err "Binary not found"
  exit 1
}
chmod +x "$BIN"

if [ "$SYSTEM" -eq 1 ]; then
  sudo install -m 0755 "$BIN" "$DEST/cm"
else
  install -m 0755 "$BIN" "$DEST/cm"
fi
ok "Installed to $DEST/cm"
maybe_add_path

if [ "$VERIFY" -eq 1 ]; then
  if "$DEST/cm" --version; then
    ok "Self-test passed"
  else
    warn "Self-test failed (cm --version returned non-zero)"
  fi
fi

ok "Done. Run: cm --help"
