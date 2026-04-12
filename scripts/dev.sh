#!/usr/bin/env bash
# Run backend (uvicorn) and frontend (vite) concurrently for development.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if [[ ! -d .venv ]]; then
  echo "error: .venv not found. run: python3.12 -m venv .venv && .venv/bin/pip install -e '.[dev]'" >&2
  exit 1
fi

cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Kill any stale process on port 8765 before starting
lsof -ti :8765 | xargs kill -9 2>/dev/null || true

"$root/.venv/bin/uvicorn" backend.app.main:app \
  --host 127.0.0.1 --port 8765 --reload --reload-dir backend &

(cd "$root/frontend" && pnpm dev) &

wait
