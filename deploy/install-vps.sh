#!/bin/bash
# Безопасная установка MCP WordPress Publisher на VPS.
# Трогает ТОЛЬКО /opt/mcp-wordpress-publisher и systemd-сервис mcp-wordpress.
# Запуск: bash install-vps.sh (из папки проекта на сервере)

set -euo pipefail

APP_DIR="/opt/mcp-wordpress-publisher"
SERVICE_NAME="mcp-wordpress"

echo "==> Установка в ${APP_DIR} (остальные файлы на сервере не затрагиваются)"

# Node.js 20 LTS (если ещё нет)
if ! command -v node &>/dev/null; then
  echo "==> Установка Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "Node: $(node -v), npm: $(npm -v)"

# Копируем проект в изолированную папку
mkdir -p "${APP_DIR}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "==> Копирование файлов из ${SCRIPT_DIR} -> ${APP_DIR}"
rsync -a --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .cursor \
  --exclude .env \
  "${SCRIPT_DIR}/" "${APP_DIR}/"

cd "${APP_DIR}"

echo "==> npm install (production)"
npm install --omit=dev

# Сборка, если dist отсутствует
if [ ! -f dist/index.js ]; then
  echo "==> Сборка TypeScript..."
  npm install typescript @types/node @types/express --no-save
  npm run build
fi

# .env — только если ещё нет
if [ ! -f .env ]; then
  cp .env.example .env
  # Генерируем случайный токен
  TOKEN=$(openssl rand -hex 32)
  cat >> .env <<EOF

MCP_TRANSPORT=http
MCP_HTTP_PORT=3000
MCP_HTTP_HOST=127.0.0.1
MCP_AUTH_TOKEN=${TOKEN}
LOG_LEVEL=info
LOG_FILE=${APP_DIR}/logs/mcp-wordpress.log
EOF
  echo ""
  echo "!!! Создан .env — ОБЯЗАТЕЛЬНО отредактируйте WORDPRESS_* и сохраните MCP_AUTH_TOKEN:"
  echo "    nano ${APP_DIR}/.env"
  echo ""
  echo "    Сгенерированный MCP_AUTH_TOKEN=${TOKEN}"
  echo ""
else
  echo "==> .env уже существует — не перезаписываем"
fi

mkdir -p logs

# systemd
echo "==> Установка systemd-сервиса ${SERVICE_NAME}"
cp deploy/mcp-wordpress.service /etc/systemd/system/${SERVICE_NAME}.service
systemctl daemon-reload
systemctl enable ${SERVICE_NAME}

echo ""
echo "============================================"
echo " Установка завершена."
echo " 1) nano ${APP_DIR}/.env   — впишите WordPress credentials"
echo " 2) systemctl start ${SERVICE_NAME}"
echo " 3) systemctl status ${SERVICE_NAME}"
echo " 4) curl http://127.0.0.1:3000/  — health-check"
echo " 5) Настройте nginx + SSL (см. DEPLOY.md)"
echo "============================================"
