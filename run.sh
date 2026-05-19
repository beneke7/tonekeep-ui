#!/usr/bin/env bash
# ================================================================
# PINAM — RUN.SH
# Copies model assets from the source directory and starts a
# local HTTP server to bypass browser CORS restrictions on
# file:// — required for Three.js OBJLoader and importmaps.
#
# Usage:
#   chmod +x run.sh
#   ./run.sh           # serves on http://localhost:8080
#   ./run.sh 3000      # optional port override
# ================================================================

set -euo pipefail

PORT="${1:-8080}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="/Users/bene/Downloads/guitar+amplifier+3d+model"

echo "[PINAM] Working dir: $SCRIPT_DIR"

# ── Copy model assets if not already present ────────────────────
# The MTL and texture are not strictly required (main.js overrides
# all materials with glass), but copy them anyway so OBJLoader
# doesn't emit 404 warnings in the console.
while IFS= read -r FILE; do
  [ -f "$FILE" ] || continue
  DEST="$SCRIPT_DIR/$(basename "$FILE")"
  if [ ! -f "$DEST" ]; then
    cp "$FILE" "$DEST"
    echo "[PINAM] Copied asset: $(basename "$FILE")"
  else
    echo "[PINAM] Asset already present: $(basename "$FILE")"
  fi
done < <(find "$SRC_DIR" -maxdepth 1 -type f \( \
  -iname "*.obj" -o -iname "*.mtl" \
  -o -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \
\) 2>/dev/null)

echo ""
echo "[PINAM] ──────────────────────────────────────────"
echo "[PINAM]  PiNAM Configurator"
echo "[PINAM]  http://localhost:$PORT"
echo "[PINAM]  Press Ctrl-C to stop."
echo "[PINAM] ──────────────────────────────────────────"
echo ""

# ── Start server ─────────────────────────────────────────────────
# Prefer python3, fall back to Node's http-server if available.
if command -v python3 &>/dev/null; then
  cd "$SCRIPT_DIR"
  python3 -m http.server "$PORT"
elif command -v npx &>/dev/null; then
  npx --yes http-server "$SCRIPT_DIR" -p "$PORT" -c-1 --cors
else
  echo "[PINAM] ERROR: neither python3 nor npx found. Install one and retry."
  exit 1
fi
