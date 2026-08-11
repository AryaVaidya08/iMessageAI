#!/usr/bin/env bash
# Starts the iMessage Analytics backend (FastAPI) and frontend (Vite) together.
# Ctrl+C stops both.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$DIR/backend"
FRONTEND_DIR="$DIR/frontend"

if [ ! -d "$BACKEND_DIR/.venv" ]; then
  echo "Setting up backend virtualenv..."
  python3 -m venv "$BACKEND_DIR/.venv"
  "$BACKEND_DIR/.venv/bin/pip" install -q -r "$BACKEND_DIR/requirements.txt"
fi

if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  echo "Installing frontend dependencies..."
  (cd "$FRONTEND_DIR" && npm install)
fi

pids=()
cleanup() {
  echo ""
  echo "Stopping..."
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

(cd "$BACKEND_DIR" && exec "$BACKEND_DIR/.venv/bin/uvicorn" main:app --port 8000) &
pids+=($!)

(cd "$FRONTEND_DIR" && exec npm run dev) &
pids+=($!)

echo ""
echo "Backend:  http://localhost:8000  (docs at /docs)"
echo "Frontend: http://localhost:5173"
echo "Press Ctrl+C to stop both."
echo ""

wait
