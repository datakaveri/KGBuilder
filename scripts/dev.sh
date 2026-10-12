#!/usr/bin/env bash
# Development mode: FastAPI backend on :8000 + Vite dev server (hot reload) on :5173.
# LLM settings come from .env (see .env.example).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -x .venv/bin/python ] || { echo "No .venv found — run ./scripts/setup.sh (or make setup) first."; exit 1; }
[ -d studio/web/node_modules ] || (cd studio/web && npm ci --no-audit --no-fund)

.venv/bin/python -m kgstudio --port "${PORT:-8000}" &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

# The backend takes a few seconds to import atlas_rag; wait so the UI doesn't load before the API is up.
echo "Waiting for the backend on :${PORT:-8000}..."
for _ in $(seq 1 120); do
  curl -s -o /dev/null "http://localhost:${PORT:-8000}/api/healthz" && break
  kill -0 $SERVER_PID 2>/dev/null || { echo "Backend exited — see the error above."; exit 1; }
  sleep 0.5
done

cd studio/web && npm run dev -- --open
