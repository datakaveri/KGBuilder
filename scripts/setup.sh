#!/usr/bin/env bash
# One-time local setup (without Docker): Python venv + backend + web UI dependencies.
# Safe to re-run; it only installs what is missing or outdated.
set -euo pipefail
cd "$(dirname "$0")/.."

PYTHON="${PYTHON:-python3}"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v "$PYTHON" >/dev/null || die "python3 not found (need 3.10+)"
"$PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 10))' || die "Python 3.10+ required, found $("$PYTHON" -V)"
command -v npm >/dev/null || die "Node.js 18+ / npm not found — install from https://nodejs.org"

if [ ! -d .venv ]; then
  say "Creating virtualenv in .venv"
  "$PYTHON" -m venv .venv
fi
PIP=".venv/bin/pip"
"$PIP" install -q --upgrade pip

# On Linux without an NVIDIA GPU, the CPU build of PyTorch is ~10x smaller.
if [ "$(uname -s)" = "Linux" ] && ! command -v nvidia-smi >/dev/null; then
  say "Installing CPU-only PyTorch"
  "$PIP" install -q --index-url https://download.pytorch.org/whl/cpu torch
fi

say "Installing KG Studio backend (+ AutoSchemaKG / atlas-rag from PyPI) — this can take a few minutes"
"$PIP" install -q -e "studio/backend[dev]"

say "Installing web UI dependencies"
(cd studio/web && npm ci --no-audit --no-fund)

if [ ! -f .env ]; then
  cp .env.example .env
  say "Created .env from .env.example — edit LLM_BASE_URL / LLM_MODEL before running"
fi

say "Done. Start the app with:  make dev   (or ./scripts/dev.sh)"
