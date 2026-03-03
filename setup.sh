#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# ifakepdf – one-time setup script
# ─────────────────────────────────────────────────────────────
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}▶ Setting up ifakepdf${NC}"

# ── Python virtualenv ─────────────────────────────────────────
echo -e "${GREEN}[backend]${NC} Creating Python virtual environment …"
cd "$BACKEND_DIR"
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip -q
pip install -r requirements.txt

# ── Copy env ──────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo -e "${GREEN}[backend]${NC} Created .env from .env.example – fill in your API keys!"
fi

# ── Frontend ──────────────────────────────────────────────────
echo -e "${GREEN}[frontend]${NC} Installing npm packages …"
cd "$FRONTEND_DIR"
npm install

echo ""
echo -e "${GREEN}✓ Setup complete!${NC}"
echo ""
echo "  Next steps:"
echo "  1. Edit backend/.env and set OPENAI_API_KEY (or leave GENERATION_BACKEND=stub)"
echo "  2. Run: ./start.sh"
echo ""
