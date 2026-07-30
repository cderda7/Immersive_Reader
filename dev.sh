#!/usr/bin/env bash
# One command to run both dev servers together: ./dev.sh from the repo
# root. Ctrl+C stops both. Output from each is prefixed ([backend] /
# [frontend]) so they're distinguishable in one terminal instead of
# needing two tabs.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Kill everything in this script's process group on exit (Ctrl+C, error,
# whatever) -- without this, stopping the script can leave one server
# running invisibly in the background, holding its port hostage for the
# next run.
cleanup() {
  echo ""
  echo "Stopping backend and frontend..."
  kill 0 2>/dev/null
}
trap cleanup EXIT INT TERM

if [ ! -x "$REPO_ROOT/backend/.venv/bin/uvicorn" ]; then
  echo "backend/.venv isn't set up yet. Run this once first:"
  echo "  cd backend && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"
  exit 1
fi

if [ ! -d "$REPO_ROOT/frontend/node_modules" ]; then
  echo "frontend/node_modules isn't set up yet. Run this once first:"
  echo "  cd frontend && npm install"
  exit 1
fi

if [ ! -f "$REPO_ROOT/backend/.env" ]; then
  echo "Heads up: backend/.env doesn't exist yet, so tap-to-define will fail"
  echo "(copy backend/.env.example -> backend/.env and add ANTHROPIC_API_KEY)."
  echo ""
fi

echo "Starting backend on :8000 and frontend on :3000 -- Ctrl+C stops both."
echo ""

(
  cd "$REPO_ROOT/backend"
  exec .venv/bin/uvicorn main:app --reload
) 2>&1 | sed -u 's/^/[backend]  /' &

(
  cd "$REPO_ROOT/frontend"
  exec npm run dev
) 2>&1 | sed -u 's/^/[frontend] /' &

wait
