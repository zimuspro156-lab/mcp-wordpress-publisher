# WordPress MCP Server (ChatGPT SSE / Streamable HTTP)

MCP-сервер на Python (FastAPI), который даёт ChatGPT и другим клиентам инструменты для создания, обновления, чтения и удаления постов на WordPress.

Целевой сайт: [https://blog.sellerix.ru](https://blog.sellerix.ru).

## Что это

Позволяет ChatGPT публиковать статьи на WordPress через REST API (`/wp-json/wp/v2`).

**Важно для ChatGPT:** в коннекторе указывайте URL, который заканчивается на `/mcp` (Streamable HTTP). Путь `/sse` — устаревший HTTP+SSE транспорт.

## Архитектура

```
ChatGPT
  ↓ HTTPS (Streamable HTTP, /mcp)
Cloudflare Tunnel
  ↓ HTTP :8000
FastAPI MCP Server
  ↓ HTTPS + Application Password
WordPress REST API
  ↓
https://blog.sellerix.ru
```

## Быстрый старт (локально)

Нужны Python 3.10+ и файл `.env` в этой папке **или** в корне репозитория.

```bash
cd chatgpt-sse
python -m venv venv
# Windows:
venv\Scripts\pip install -r requirements.txt
venv\Scripts\python mcp_sse_server.py
# Linux/macOS:
# source venv/bin/activate && pip install -r requirements.txt && python mcp_sse_server.py
```

Переменные окружения (пароль **не** хранится в коде):

| Переменная | Обязательна | Описание |
|-----------|:-----------:|----------|
| `WORDPRESS_URL` | да | Базовый URL сайта, например `https://blog.sellerix.ru` |
| `WORDPRESS_USERNAME` | да | Пользователь WordPress |
| `WORDPRESS_APP_PASSWORD` | да | Application Password (Пользователи → Профиль) |
| `MCP_HTTP_PORT` | нет | Порт, по умолчанию `8000` |
| `MCP_AUTH_TOKEN` | нет | Если задан — нужен заголовок `Authorization: Bearer ...` |

Проверка:

```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/
```

## Установка на Ubuntu VPS

```bash
chmod +x install.sh
sudo ./install.sh
```

Скрипт:

- ставит Python и зависимости в `/opt/wordpress-mcp-server`
- создаёт пользователя `wordpress-mcp` (не root)
- пишет systemd-сервис `wordpress-mcp-server`
- поднимает Cloudflare Quick Tunnel и печатает HTTPS URL

Пароль приложения задаётся в `/opt/wordpress-mcp-server/.env`.

## Подключение к ChatGPT

1. Платный план (Plus / Pro / Business / Enterprise / Edu).
2. Settings → Connectors → Developer mode.
3. New connector:
   - **Name:** WordPress MCP
   - **URL:** `https://your-url.trycloudflare.com/mcp`
   - **Authentication:** None (или Token, если задан `MCP_AUTH_TOKEN`)
4. Сохраните и попросите: «Напиши статью про AI на 300 слов и опубликуй черновик на сайте».

## Инструменты

| Tool | Назначение |
|------|------------|
| `create_post` | Создать пост (`title`, `content`, опционально `excerpt`, `status`) |
| `update_post` | Обновить пост по `post_id` |
| `get_posts` | Список постов (`per_page`, `page`) |
| `delete_post` | Удалить пост по `post_id` |

## Управление

```bash
sudo systemctl status wordpress-mcp-server
sudo journalctl -u wordpress-mcp-server -f
sudo systemctl restart wordpress-mcp-server
grep -oE 'https://[^ ]+\.trycloudflare\.com' /root/cloudflared.log | head -1
```

Перезапуск туннеля (URL при каждом запуске **новый**):

```bash
pkill cloudflared
nohup cloudflared tunnel --url http://127.0.0.1:8000 > /root/cloudflared.log 2>&1 &
sleep 5
grep trycloudflare /root/cloudflared.log
```

## Troubleshooting

Сервер не стартует:

```bash
sudo journalctl -u wordpress-mcp-server -n 50
ss -tlnp | grep 8000
```

ChatGPT не подключается — в URL должен быть `/mcp`, не корень сайта. Проверьте:

```bash
curl -sS -X POST https://your-url.trycloudflare.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

Ошибка 401 от WordPress: неверный Application Password в `.env`.

## Безопасность

- Учётные данные только в `.env` (права `600`).
- Для публичного туннеля задайте `MCP_AUTH_TOKEN`.
- Бесплатный Cloudflare Quick Tunnel нестабилен и меняет URL после рестарта. Для продакшена лучше именованный туннель или nginx + Let's Encrypt.

## Требования

- Ubuntu 20.04+ (для `install.sh`) или Windows/macOS для локального запуска
- Python 3.10+
- WordPress с REST API и Application Password
- sudo на VPS

## Лицензия

MIT
