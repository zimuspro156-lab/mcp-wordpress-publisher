# Деплой MCP WordPress Publisher на VPS (HostVDS / PuTTY)

Пошаговая инструкция для сервера **94.183.190.28**. Установка **изолирована** в `/opt/mcp-wordpress-publisher` — ваши остальные файлы и сервисы на сервере **не затрагиваются**.

---

## Что получится в итоге

| Где | Что |
|-----|-----|
| Cursor (локально) | stdio через `.cursor/mcp.json` — как сейчас |
| ChatGPT | HTTPS URL вида `https://mcp.ваш-домен.ru/mcp` + Bearer-токен |

> **ChatGPT не принимает npm-пакет и не принимает IP без HTTPS.** Нужен публичный домен с SSL.

---

## Шаг 0. Подготовка домена

1. Создайте **A-запись** поддомена, например `mcp.sellerix.ru` → `94.183.190.28`.
2. Подождите 5–30 минут, пока DNS обновится.

Проверка (с вашего ПК):

```bash
ping mcp.sellerix.ru
```

---

## Шаг 1. Загрузить проект на сервер

### Вариант A — WinSCP (проще всего)

1. Скачайте [WinSCP](https://winscp.net/).
2. Подключитесь: Host `94.183.190.28`, User `root`, пароль от VPS.
3. Создайте на сервере папку `/root/mcp-upload`.
4. Загрузите **всю папку проекта** `MCP WP` туда (можно без `node_modules`).

### Вариант B — PowerShell (scp)

```powershell
scp -r "C:\Users\USER\Desktop\MCP WP" root@94.183.190.28:/root/mcp-upload/
```

---

## Шаг 2. PuTTY — установка

Подключитесь через PuTTY к `94.183.190.28` как `root`.

```bash
cd /root/mcp-upload
chmod +x deploy/install-vps.sh
bash deploy/install-vps.sh
```

Скрипт:
- ставит Node.js 20 (если нет);
- копирует всё в `/opt/mcp-wordpress-publisher`;
- создаёт `.env` с случайным `MCP_AUTH_TOKEN`;
- регистрирует systemd-сервис `mcp-wordpress`.

---

## Шаг 3. Настроить .env

```bash
nano /opt/mcp-wordpress-publisher/.env
```

Минимум для HTTP + WordPress:

```env
WORDPRESS_URL=https://blog.sellerix.ru
WORDPRESS_USERNAME=cursor
WORDPRESS_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx

MCP_TRANSPORT=http
MCP_HTTP_PORT=3000
MCP_HTTP_HOST=127.0.0.1
MCP_AUTH_TOKEN=ваш-длинный-секретный-токен
LOG_LEVEL=info
LOG_FILE=/opt/mcp-wordpress-publisher/logs/mcp-wordpress.log
```

Сохранить: `Ctrl+O`, Enter, `Ctrl+X`.

Запуск:

```bash
systemctl start mcp-wordpress
systemctl status mcp-wordpress
```

Проверка (на сервере):

```bash
curl http://127.0.0.1:3000/
# {"name":"mcp-wordpress-publisher","transport":"http","endpoint":"/mcp"}
```

Логи:

```bash
journalctl -u mcp-wordpress -f
# или
tail -f /opt/mcp-wordpress-publisher/logs/mcp-wordpress.log
```

---

## Шаг 4. nginx + HTTPS (обязательно для ChatGPT)

```bash
apt update
apt install -y nginx certbot python3-certbot-nginx
```

Создайте конфиг (замените домен):

```bash
nano /etc/nginx/sites-available/mcp-wordpress
```

Вставьте (замените `mcp.sellerix.ru` на ваш поддомен):

```nginx
server {
    listen 80;
    server_name mcp.sellerix.ru;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
    }
}
```

Активируйте:

```bash
ln -sf /etc/nginx/sites-available/mcp-wordpress /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

SSL:

```bash
certbot --nginx -d mcp.sellerix.ru
```

Проверка с ПК:

```bash
curl https://mcp.sellerix.ru/
```

---

## Шаг 5. Подключить к ChatGPT

Требования:
- Платный план ChatGPT (Plus / Pro / Business / Enterprise).
- Developer Mode включён.

1. ChatGPT → **Settings** → **Connectors** → **Advanced** → включить **Developer Mode**.
2. **Add connector** (Custom MCP):
   - **Name:** `WordPress`
   - **Description:** `Публикация статей на blog.sellerix.ru`
   - **Connector URL:** `https://mcp.sellerix.ru/mcp`
   - **Authentication:** `Token`
   - **Token:** значение `MCP_AUTH_TOKEN` из `.env` на сервере
3. Сохранить. В чате появятся инструменты `wp_create_post`, `wp_list_posts` и др.

Пример запроса в ChatGPT:

> Опубликуй черновик статьи с заголовком «Тест из ChatGPT» и текстом «Проверка MCP».

---

## Обновление (без затрагивания других проектов)

```bash
# Загрузите новую версию в /root/mcp-upload
cd /root/mcp-upload
bash deploy/install-vps.sh
systemctl restart mcp-wordpress
```

---

## Управление сервисом

```bash
systemctl start mcp-wordpress    # запуск
systemctl stop mcp-wordpress     # остановка
systemctl restart mcp-wordpress  # перезапуск
systemctl status mcp-wordpress   # статус
journalctl -u mcp-wordpress -n 50  # последние логи
```

---

## Безопасность

- **MCP_AUTH_TOKEN** — длинная случайная строка; без неё любой с URL сможет публиковать в WordPress.
- Откройте в firewall только **22** (SSH), **80**, **443**. Порт **3000** держите только на `127.0.0.1` (nginx проксирует снаружи).
- Не коммитьте `.env` в git.

---

## Устранение неполадок

| Симптом | Решение |
|---------|---------|
| `systemctl status` → failed | `journalctl -u mcp-wordpress -n 30` — смотрите ошибку |
| ChatGPT: Connection closed | Проверьте HTTPS, URL заканчивается на `/mcp` |
| 401 Unauthorized | Неверный Token в ChatGPT — сверьте с `MCP_AUTH_TOKEN` в `.env` |
| nginx 502 | Сервис не запущен: `systemctl start mcp-wordpress` |
| certbot ошибка | DNS ещё не указывает на 94.183.190.28 — подождите |

---

## Cursor vs ChatGPT — итог

| Клиент | Как подключать | Что вставлять |
|--------|----------------|---------------|
| **Cursor** | `.cursor/mcp.json` | `command` + `node dist/index.js` (stdio) |
| **ChatGPT** | Custom MCP Connector | `https://mcp.ваш-домен.ru/mcp` + Token |
| **npm** | `npx mcp-wordpress-publisher` | Только для локальных клиентов (stdio) |
