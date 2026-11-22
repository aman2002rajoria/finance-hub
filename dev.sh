#!/usr/bin/env bash
# Start Finance Hub locally:
#   :8000  backend on your own data   (backend/data/finance.db)
#   :8001  backend on test data        (backend/data/demo.db, seeded if missing)
#   :3000  Next.js frontend            (/api -> 8000, /demo-api -> 8001)
#
# Usage: ./dev.sh            all three
#        ./dev.sh --test-only  demo backend + frontend locked to test data (portfolio-safe)
# Ctrl+C stops everything.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PY="$ROOT/backend/.venv/bin/python"
TEST_ONLY=0
[[ "${1:-}" == "--test-only" ]] && TEST_ONLY=1

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

if [[ ! -f "$ROOT/backend/data/demo.db" ]]; then
  echo "Seeding test data (backend/data/demo.db)..."
  (cd "$ROOT/backend" && FINANCE_DB_PATH=data/demo.db "$PY" scripts/seed_demo_data.py)
fi

if [[ $TEST_ONLY -eq 0 ]]; then
  (cd "$ROOT/backend" && exec "$PY" -m uvicorn main:app --host 127.0.0.1 --port 8000) &
  pids+=($!)
fi

(cd "$ROOT/backend" && FINANCE_DB_PATH=data/demo.db FINANCE_DEMO=1 exec "$PY" -m uvicorn main:app --host 127.0.0.1 --port 8001) &
pids+=($!)

if [[ $TEST_ONLY -eq 1 ]]; then
  (cd "$ROOT/frontend" && NEXT_PUBLIC_TEST_ONLY=1 exec npm run dev) &
else
  (cd "$ROOT/frontend" && exec npm run dev) &
fi
pids+=($!)

echo "Finance Hub: http://localhost:3000"
wait
