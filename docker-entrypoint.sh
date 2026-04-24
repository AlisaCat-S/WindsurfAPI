#!/usr/bin/env bash
set -e

# ── Ensure LS binary exists and matches builtin ──────────────
# When /opt/windsurf is mounted as a volume, the baked-in binary
# may be missing or outdated. Compare SHA256 with the builtin
# copy and overwrite if they differ.

LS_TARGET="${LS_BINARY_PATH:-/opt/windsurf/language_server_linux_x64}"
LS_BUILTIN="/opt/windsurf-builtin/language_server_linux_x64"

get_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1
  elif command -v md5sum >/dev/null 2>&1; then
    # fallback to md5 if sha256 unavailable
    md5sum "$1" 2>/dev/null | cut -d' ' -f1
  else
    echo "NO_HASH_TOOL"
  fi
}

if [ -x "$LS_BUILTIN" ]; then
  BUILTIN_HASH=$(get_sha256 "$LS_BUILTIN")

  if [ ! -f "$LS_TARGET" ]; then
    # Case 1: target missing entirely (empty volume mount)
    echo "[entrypoint] LS binary missing at $LS_TARGET, copying builtin..."
    mkdir -p "$(dirname "$LS_TARGET")"
    cp "$LS_BUILTIN" "$LS_TARGET"
    chmod +x "$LS_TARGET"
    echo "[entrypoint] LS binary installed (sha256:${BUILTIN_HASH:0:16}...)"
  else
    # Case 2: target exists — compare hash
    TARGET_HASH=$(get_sha256 "$LS_TARGET")
    if [ "$TARGET_HASH" != "$BUILTIN_HASH" ]; then
      echo "[entrypoint] LS binary hash mismatch, updating..."
      echo "  volume:  ${TARGET_HASH:0:16}..."
      echo "  builtin: ${BUILTIN_HASH:0:16}..."
      cp "$LS_BUILTIN" "$LS_TARGET"
      chmod +x "$LS_TARGET"
      echo "[entrypoint] LS binary updated to builtin version."
    else
      echo "[entrypoint] LS binary up-to-date (sha256:${TARGET_HASH:0:16}...)"
    fi
  fi
else
  echo "[entrypoint] WARN: builtin LS not found at $LS_BUILTIN, skipping hash check."
  if [ ! -x "$LS_TARGET" ]; then
    echo "[entrypoint] ERROR: No LS binary available at $LS_TARGET!"
  fi
fi

# Ensure data dirs exist (volume may be fresh)
mkdir -p /opt/windsurf/data/db /tmp/windsurf-workspace "${DATA_DIR:-/data}"

exec "$@"
