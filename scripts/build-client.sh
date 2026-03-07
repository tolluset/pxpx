#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
PRIMARY_BINARY="$DIST_DIR/pxboard"

mkdir -p "$DIST_DIR"

bun build "$ROOT_DIR/src/client.tsx" --compile --outfile "$PRIMARY_BINARY"
chmod 0755 "$PRIMARY_BINARY"

for legacy_binary in pixel-game pxgame; do
  cp "$PRIMARY_BINARY" "$DIST_DIR/$legacy_binary"
  chmod 0755 "$DIST_DIR/$legacy_binary"
done
