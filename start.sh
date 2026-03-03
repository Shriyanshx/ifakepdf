#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# ifakepdf – start script
# Launches the Python backend and the Next.js frontend
# ─────────────────────────────────────────────────────────────
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"

# ── Colours ───────────────────────────────────────────────────
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}▶ Starting ifakepdf${NC}"

# ── Backend ───────────────────────────────────────────────────
echo -e "${GREEN}[backend]${NC} Starting FastAPI on :8000 …"
(
  cd "$BACKEND_DIR"
  if [[ -f ".env" ]]; then
    export $(grep -v '^#' .env | xargs)
  fi
  .venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
)

BACKEND_PID=$!

# ── Frontend ──────────────────────────────────────────────────
echo -e "${GREEN}[frontend]${NC} Starting Next.js on :3000 …"
(
  cd "$FRONTEND_DIR"
  npm run dev
)

# Clean up backend on exit
trap "kill $BACKEND_PID 2>/dev/null" EXIT
