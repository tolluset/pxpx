#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$ROOT_DIR/artifacts"
SKIP_BUILD=0

usage() {
  cat <<'EOF'
Usage: package-release.sh [options]

Options:
  --skip-build            Reuse the existing dist/pxboard binary
  --output-dir <path>     Output directory for packaged artifacts
  -h, --help              Show this help message
EOF
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

write_checksum() {
  local target_path=$1
  local checksum_path=$2

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$target_path" >"$checksum_path"
    return
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$target_path" >"$checksum_path"
    return
  fi

  echo "Warning: no SHA-256 tool found, skipping checksum generation." >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --output-dir)
      OUTPUT_DIR=${2:-}
      shift 2
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

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  (cd "$ROOT_DIR" && pnpm build:client)
fi

DIST_BINARY="$ROOT_DIR/dist/pxboard"

if [[ ! -x "$DIST_BINARY" ]]; then
  echo "Error: missing compiled binary at $DIST_BINARY" >&2
  exit 1
fi

PLATFORM="$(resolve_os)"
ARCH="$(resolve_arch)"
ASSET_NAME="pxboard-${PLATFORM}-${ARCH}.tar.gz"
CHECKSUM_NAME="${ASSET_NAME}.sha256"
ASSET_PATH="$OUTPUT_DIR/$ASSET_NAME"
CHECKSUM_PATH="$OUTPUT_DIR/$CHECKSUM_NAME"
STAGING_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t pxboard-release)"

cleanup() {
  rm -rf "$STAGING_DIR"
}

trap cleanup EXIT

mkdir -p "$OUTPUT_DIR"
cp "$DIST_BINARY" "$STAGING_DIR/pxboard"
chmod 0755 "$STAGING_DIR/pxboard"
tar -C "$STAGING_DIR" -czf "$ASSET_PATH" pxboard
write_checksum "$ASSET_PATH" "$CHECKSUM_PATH"

echo "Created release artifact:"
echo "  $ASSET_PATH"

if [[ -f "$CHECKSUM_PATH" ]]; then
  echo "Created checksum:"
  echo "  $CHECKSUM_PATH"
fi
