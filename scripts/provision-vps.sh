#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-/opt/deriv-digit-bot}"
PORT="${PORT:-3000}"
NODE_MAJOR="${NODE_MAJOR:-24}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root on the VPS."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get upgrade -y
apt-get install -y ca-certificates curl git ufw tar build-essential

need_node_install=1
if command -v node >/dev/null 2>&1; then
  current_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  if [[ "${current_major}" =~ ^[0-9]+$ ]] && [[ "${current_major}" -ge "${NODE_MAJOR}" ]]; then
    need_node_install=0
  fi
fi

if [[ "${need_node_install}" -eq 1 ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

npm install -g pm2

ufw allow OpenSSH || true
ufw allow "${PORT}/tcp" || true
ufw --force enable || true

if [[ ! -d "${APP_DIR}" ]]; then
  echo "App directory not found: ${APP_DIR}"
  exit 1
fi

cd "${APP_DIR}"

if [[ -f .env.example && ! -f .env ]]; then
  cp .env.example .env
fi

npm install --omit=dev

if pm2 describe deriv-digit-bot >/dev/null 2>&1; then
  pm2 restart deriv-digit-bot --update-env
else
  pm2 start server.js --name deriv-digit-bot --update-env
fi

pm2 save
pm2 startup systemd -u root --hp /root || true

echo
echo "Provisioning finished."
echo "If pm2 printed a system startup command, run that command once to finish auto-start setup."
