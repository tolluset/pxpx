#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_DIR=${PIXEL_GAME_INSTALL_DIR:-}
BIN_NAME=${PIXEL_GAME_BIN_NAME:-pxboard}
DEFAULT_REPO="tolluset/pxpx"
REPO=${PIXEL_GAME_REPO:-$DEFAULT_REPO}
VERSION=${PIXEL_GAME_VERSION:-latest}
FORCE_DOWNLOAD=0

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --repo <owner/repo>        GitHub repository used for release downloads
  --version <tag>            Release tag to install (default: latest)
  --install-dir <path>       Target directory (default: first writable PATH entry)
  --bin-name <name>          Installed binary name (default: pxboard)
  --force-download           Skip local binary detection and download from releases
  -h, --help                 Show this help message

Environment variables:
  PIXEL_GAME_REPO (default: tolluset/pxpx)
  PIXEL_GAME_VERSION
  PIXEL_GAME_INSTALL_DIR
  PIXEL_GAME_BIN_NAME
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command not found: $1" >&2
    exit 1
  fi
}

resolve_os() {
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    *)
      echo "Error: unsupported operating system: $(uname -s)" >&2
      exit 1
      ;;
  esac
}

resolve_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    arm64|aarch64) echo "arm64" ;;
    *)
      echo "Error: unsupported architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

ensure_dir_is_writable() {
  target_dir=$1

  mkdir -p "$target_dir"

  if [ ! -w "$target_dir" ]; then
    return 1
  fi

  return 0
}

resolve_install_dir() {
  if [ -n "$INSTALL_DIR" ]; then
    echo "$INSTALL_DIR"
    return 0
  fi

  for candidate in "$HOME/.local/bin" "$HOME/bin" "$HOME/.bun/bin" "$HOME/go/bin" "$HOME/.cargo/bin"; do
    case ":$PATH:" in
      *":$candidate:"*)
        if ensure_dir_is_writable "$candidate"; then
          echo "$candidate"
          return 0
        fi
        ;;
    esac
  done

  previous_ifs=$IFS
  IFS=:

  for candidate in $PATH; do
    [ -n "$candidate" ] || continue

    case "$candidate" in
      "$HOME"/*)
        if ensure_dir_is_writable "$candidate"; then
          IFS=$previous_ifs
          echo "$candidate"
          return 0
        fi
        ;;
    esac
  done

  IFS=$previous_ifs

  if ensure_dir_is_writable "$HOME/.local/bin"; then
    echo "$HOME/.local/bin"
    return 0
  fi

  echo "Error: failed to find a writable install directory" >&2
  exit 1
}

install_binary() {
  source_path=$1

  INSTALL_DIR=$(resolve_install_dir)

  mkdir -p "$INSTALL_DIR"

  if command -v install >/dev/null 2>&1; then
    install -m 0755 "$source_path" "$INSTALL_DIR/$BIN_NAME"
  else
    cp "$source_path" "$INSTALL_DIR/$BIN_NAME"
    chmod 0755 "$INSTALL_DIR/$BIN_NAME"
  fi

  echo "Installed $BIN_NAME to $INSTALL_DIR/$BIN_NAME"

  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      echo "Add $INSTALL_DIR to your PATH to run $BIN_NAME directly."
      ;;
  esac
}

try_local_install() {
  local_binary=$SCRIPT_DIR/dist/pxboard

  if [ -x "$local_binary" ]; then
    install_binary "$local_binary"
    return 0
  fi

  if [ -f "$SCRIPT_DIR/package.json" ] && command -v pnpm >/dev/null 2>&1 && command -v bun >/dev/null 2>&1; then
    if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
      echo "Installing local dependencies..."
      (
        cd "$SCRIPT_DIR"
        pnpm install --frozen-lockfile
      )
    fi

    echo "Building local binary from source..."
    (
      cd "$SCRIPT_DIR"
      pnpm build:client
    )

    if [ -x "$local_binary" ]; then
      install_binary "$local_binary"
      return 0
    fi
  fi

  return 1
}

fetch_latest_tag() {
  require_command curl

  tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)

  if [ -z "$tag" ]; then
    echo "Error: failed to resolve the latest release tag for $REPO" >&2
    exit 1
  fi

  echo "$tag"
}

download_and_install() {
  require_command curl
  require_command tar

  os=$(resolve_os)
  arch=$(resolve_arch)
  tag=$VERSION

  if [ "$tag" = "latest" ]; then
    tag=$(fetch_latest_tag)
  fi

  asset_name="pxboard-${os}-${arch}.tar.gz"
  asset_url="https://github.com/$REPO/releases/download/$tag/$asset_name"
  tmp_dir=$(mktemp -d 2>/dev/null || mktemp -d -t pxboard-install)
  archive_path=$tmp_dir/$asset_name

  cleanup() {
    rm -rf "$tmp_dir"
  }

  trap cleanup EXIT HUP INT TERM

  echo "Downloading $asset_url"
  curl -fsSL "$asset_url" -o "$archive_path"
  tar -xzf "$archive_path" -C "$tmp_dir"

  if [ ! -f "$tmp_dir/pxboard" ]; then
    echo "Error: release archive did not contain pxboard" >&2
    exit 1
  fi

  install_binary "$tmp_dir/pxboard"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      REPO=${2:-}
      shift 2
      ;;
    --version)
      VERSION=${2:-}
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR=${2:-}
      shift 2
      ;;
    --bin-name)
      BIN_NAME=${2:-}
      shift 2
      ;;
    --force-download)
      FORCE_DOWNLOAD=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "$FORCE_DOWNLOAD" -eq 0 ] && try_local_install; then
  exit 0
fi

if [ -z "$REPO" ]; then
  cat >&2 <<'EOF'
Error: no GitHub release repository configured.

Set PIXEL_GAME_REPO or pass --repo:
  PIXEL_GAME_REPO=owner/repo sh install.sh
  curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | PIXEL_GAME_REPO=<owner>/<repo> sh
EOF
  exit 1
fi

download_and_install
