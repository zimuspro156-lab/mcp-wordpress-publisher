#!/bin/bash
set -euo pipefail

echo "==================================="
echo "WordPress MCP Server - Installation"
echo "==================================="

APP_DIR="/opt/wordpress-mcp-server"
SERVICE_USER="wordpress-mcp"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script with sudo: sudo ./install.sh"
  exit 1
fi

echo "Step 1: Installing system packages..."
apt-get update
apt-get install -y python3 python3-pip python3-venv curl wget ca-certificates

echo "Step 2: Creating service user and directory..."
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
mkdir -p "$APP_DIR"
cp -f "$SCRIPT_DIR/mcp_sse_server.py" "$APP_DIR/mcp_sse_server.py"
cp -f "$SCRIPT_DIR/requirements.txt" "$APP_DIR/requirements.txt"

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "Step 3: Creating $APP_DIR/.env (edit this file with your credentials)..."
  cat > "$APP_DIR/.env" <<'EOF'
WORDPRESS_URL=https://blog.sellerix.ru
WORDPRESS_USERNAME=cursor
WORDPRESS_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx
LOG_LEVEL=info
MCP_HTTP_HOST=0.0.0.0
MCP_HTTP_PORT=8000
# Optional: require Authorization: Bearer <token> on /mcp and /sse
# MCP_AUTH_TOKEN=replace-with-a-long-random-token
EOF
  echo "Edit $APP_DIR/.env now and put the WordPress Application Password there."
  read -r -p "Press Enter when .env is configured..."
else
  echo "Step 3: Existing $APP_DIR/.env kept as-is."
fi
chmod 600 "$APP_DIR/.env"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

echo "Step 4: Creating Python virtual environment..."
if [[ ! -d "$APP_DIR/venv" ]]; then
  sudo -u "$SERVICE_USER" python3 -m venv "$APP_DIR/venv"
fi
sudo -u "$SERVICE_USER" "$APP_DIR/venv/bin/pip" install --upgrade pip
sudo -u "$SERVICE_USER" "$APP_DIR/venv/bin/pip" install -r "$APP_DIR/requirements.txt"

echo "Step 5: Creating systemd service..."
cat > /etc/systemd/system/wordpress-mcp-server.service <<EOF
[Unit]
Description=WordPress MCP SSE Server for ChatGPT
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=PATH=$APP_DIR/venv/bin
ExecStart=$APP_DIR/venv/bin/python $APP_DIR/mcp_sse_server.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

echo "Step 6: Starting MCP server..."
systemctl daemon-reload
systemctl enable wordpress-mcp-server
systemctl restart wordpress-mcp-server

if command -v ufw >/dev/null 2>&1; then
  echo "Step 7: Allowing port 8000 on ufw..."
  ufw allow 8000/tcp || true
else
  echo "Step 7: ufw not installed, skipping firewall rule."
fi

sleep 3
echo "Step 8: Service status:"
systemctl status wordpress-mcp-server --no-pager || true

echo "Step 9: Testing local endpoints..."
curl -sS http://127.0.0.1:8000/health | python3 -m json.tool || true
echo ""
curl -sS http://127.0.0.1:8000/ | python3 -m json.tool || true

echo ""
echo "Step 10: Installing Cloudflare Tunnel (optional HTTPS)..."
if ! command -v cloudflared >/dev/null 2>&1; then
  wget -q -O /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x /tmp/cloudflared
  mv /tmp/cloudflared /usr/local/bin/cloudflared
fi

pkill -f "cloudflared tunnel --url" >/dev/null 2>&1 || true
nohup cloudflared tunnel --url http://127.0.0.1:8000 > /root/cloudflared.log 2>&1 &
sleep 6
echo "Cloudflare log (look for https://....trycloudflare.com):"
grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' /root/cloudflared.log | head -5 || tail -n 30 /root/cloudflared.log

echo ""
echo "==================================="
echo "INSTALLATION COMPLETE"
echo "==================================="
echo "MCP server: http://127.0.0.1:8000"
echo "ChatGPT connector URL: https://YOUR-TUNNEL.trycloudflare.com/mcp"
echo "Legacy SSE URL:         https://YOUR-TUNNEL.trycloudflare.com/sse"
echo ""
echo "Commands:"
echo "  Status:  systemctl status wordpress-mcp-server"
echo "  Logs:    journalctl -u wordpress-mcp-server -f"
echo "  Restart: systemctl restart wordpress-mcp-server"
echo "==================================="
