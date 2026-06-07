#!/usr/bin/env bash
set -e

RESET="\033[0m"
BOLD="\033[1m"
GREEN="\033[32m"
RED="\033[31m"
YELLOW="\033[33m"

echo -e "${BOLD}obscurity engine — local start${RESET}"
echo "-------------------------------"

# Check Rust
if ! command -v cargo &> /dev/null; then
  echo -e "${RED}Rust not found.${RESET} Install it from: https://rustup.rs"
  echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  exit 1
fi

# Check Node.js
if ! command -v node &> /dev/null; then
  echo -e "${RED}Node.js not found.${RESET} Install it from: https://nodejs.org (LTS version)"
  exit 1
fi

# Set up backend env
if [ ! -f backend/.env ]; then
  if [ -z "$LASTFM_API_KEY" ]; then
    echo -e "${YELLOW}No backend/.env found and LASTFM_API_KEY not set.${RESET}"
    echo "Get a free Last.fm API key at: https://www.last.fm/api/account/create"
    read -p "Paste your Last.fm API key: " LASTFM_API_KEY
  fi
  echo "LASTFM_API_KEY=$LASTFM_API_KEY" > backend/.env
  echo "FRONTEND_URL=http://localhost:3000" >> backend/.env
  echo -e "${GREEN}Created backend/.env${RESET}"
fi

# Set up frontend env
if [ ! -f frontend/.env.local ]; then
  echo "NEXT_PUBLIC_BACKEND_URL=http://localhost:8080" > frontend/.env.local
fi

# Install frontend dependencies if needed
if [ ! -d frontend/node_modules ]; then
  echo -e "${BOLD}Installing frontend dependencies...${RESET}"
  cd frontend && npm install && cd ..
fi

# Build and start backend
echo -e "${BOLD}Building backend (first run takes ~2 min)...${RESET}"
(cd backend && cargo build --release 2>&1 | tail -5)
echo -e "${GREEN}Backend built.${RESET}"

# Start backend in background
echo -e "${BOLD}Starting backend on :8080...${RESET}"
(cd backend && ./target/release/backend) &
BACKEND_PID=$!

# Wait for backend to be ready
sleep 2

# Start frontend
echo -e "${BOLD}Starting frontend on :3000...${RESET}"
echo ""
echo -e "${GREEN}Open http://localhost:3000 in your browser${RESET}"
echo "(Press Ctrl+C to stop both servers)"
echo ""

cleanup() {
  echo -e "\n${BOLD}Stopping...${RESET}"
  kill $BACKEND_PID 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

(cd frontend && npm run dev)
