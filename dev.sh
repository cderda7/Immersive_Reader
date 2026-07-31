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

# A stale process left over from an earlier run that didn't shut down
# cleanly (a Ctrl+C that didn't reach every child, a terminal closed
# mid-run, a crash) can end up still bound to :8000 or :3000. When that
# happens, the fresh servers below either fail outright ("Address already
# in use", easy to miss buried inside interleaved [backend]/[frontend]
# output) or -- the genuinely dangerous case -- silently just... don't
# start, while every request keeps hitting the OLD process from before,
# running whatever code was loaded when IT started. That's exactly what
# happened working on this project on 2026-07-31: multiple rounds of "the
# fix isn't working" that were actually "you're not even running the
# fix" (see TROUBLESHOOTING.md). Loudly clear the ports THIS script is
# about to use before doing anything else, so that specific failure mode
# can't happen silently again -- if you legitimately have something else
# important running on 8000/3000, stop it before running this script.
kill_stale_port() {
  local port="$1"
  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi
  local pids
  pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "*** Something was already listening on :$port (pid(s): $pids) ***"
    echo "*** before this run even started -- almost certainly a leftover"
    echo "*** process from an earlier ./dev.sh that didn't exit cleanly."
    echo "*** Killing it now so you don't end up silently testing against it."
    kill -9 $pids 2>/dev/null || true
    sleep 0.5
  fi
}
kill_stale_port 8000
kill_stale_port 3000

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
