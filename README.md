# MCP WordPress Publisher

MCP-сервер на **TypeScript** ([@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)) для публикации и управления статьями на сайте WordPress через **WordPress REST API** (`/wp-json/wp/v2`).

Сервер даёт любому MCP-клиенту (Cursor, Claude Desktop и др.) набор инструментов: создать/опубликовать статью, обновить, удалить, получить список, управлять категориями и метками.

---

## Целевой сайт

- **URL:** https://blog.sellerix.ru (REST API: https://blog.sellerix.ru/wp-json/)
- **Логин:** `cursor`
- **Пароль:** используется **Application Password** (пароль приложения), задаётся через переменную окружения `WORDPRESS_APP_PASSWORD`. В коде и репозитории пароль **не хранится**.

> Application Password создаётся в WordPress: **Пользователи → Профиль → Application Passwords**. Это отдельный пароль для API, не равный паролю от админки.

---

## Возможности (MCP-инструменты)

| Инструмент | Назначение |
|-----------|-----------|
| `wp_verify_connection` | Проверить URL/логин/пароль (`/users/me`) |
| `wp_create_post` | Создать/опубликовать статью (`draft` по умолчанию) |
| `wp_update_post` | Обновить статью по id (в т.ч. `draft → publish`) |
| `wp_get_post` | Получить статью по id |
| `wp_list_posts` | Список статей (фильтры: статус, поиск, пагинация) |
| `wp_delete_post` | Удалить статью (в корзину или навсегда) |
| `wp_list_categories` | Список категорий с id |
| `wp_create_category` | Создать категорию |
| `wp_list_tags` | Список меток с id |
| `wp_create_tag` | Создать метку |
| `wordstat_top` | Wordstat: частотность, топ запросов и ассоциации за 30 дней |
| `wordstat_dynamics` | Wordstat: динамика спроса по дням / неделям / месяцам |
| `wordstat_regions` | Wordstat: география спроса и индекс интереса |
| `wordstat_find_region` | Wordstat: найти ID региона по названию |

Инструменты Wordstat появляются только если заданы `YANDEX_API_KEY` и `YANDEX_FOLDER_ID`. API: [Yandex Cloud Search API → Wordstat](https://aistudio.yandex.ru/ru/docs/search-api/concepts/wordstat).

---

## Требования

- **Node.js >= 18** (используется встроенный `fetch`)
- npm

---

## Структура проекта

```
MCP WP/
├── src/
│   ├── index.ts        # Точка входа: stdio или HTTP (по MCP_TRANSPORT)
│   ├── mcpServer.ts    # Сборка экземпляра MCP-сервера
│   ├── httpServer.ts   # HTTP-транспорт (Streamable HTTP) для ChatGPT
│   ├── config.ts       # Загрузка и валидация переменных окружения (.env)
│   ├── logger.ts       # Логгер (stderr + опциональный файл, уровни)
│   ├── wordpress.ts    # Клиент WordPress REST API + логирование запросов
│   ├── tools.ts        # Регистрация MCP-инструментов WordPress
│   ├── wordstat.ts     # Клиент Yandex Wordstat (Search API v2)
│   ├── wordstatTools.ts
│   └── wordstatServer.ts  # Отдельный MCP только с Wordstat
├── chatgpt-sse/        # Python FastAPI MCP (SSE + Streamable HTTP) для ChatGPT
│   ├── mcp_sse_server.py
│   ├── requirements.txt
│   └── install.sh
├── deploy/             # Скрипты деплоя на VPS (systemd, nginx)
│   ├── install-vps.sh
│   ├── mcp-wordpress.service
│   └── nginx-mcp.conf.example
├── DEPLOY.md           # Пошаговый деплой на VPS + подключение ChatGPT
├── package.json        # Метаданные, скрипты, bin для npx, publishConfig
├── tsconfig.json       # Настройки компиляции TypeScript
├── .env.example        # Шаблон переменных окружения
├── mcp.config.example.json  # Примеры конфигурации MCP-клиента
├── .npmignore          # Что не публиковать в npm
├── .gitignore
├── LICENSE             # MIT
└── README.md           # Этот файл
```

---

## Установка и настройка

```bash
# 1. Установить зависимости
npm install

# 2. Создать .env из шаблона и заполнить пароль
cp .env.example .env
# затем впишите WORDPRESS_APP_PASSWORD
```

Переменные окружения (`.env`):

| Переменная | Обязательна | Описание |
|-----------|:-----------:|----------|
| `WORDPRESS_URL` | да | Базовый URL сайта, напр. `https://blog.sellerix.ru` |
| `WORDPRESS_USERNAME` | да | Имя пользователя, напр. `cursor` |
| `WORDPRESS_APP_PASSWORD` | да | Application Password |
| `LOG_LEVEL` | нет | `error` \| `warn` \| `info` \| `debug` (по умолчанию `info`) |
| `LOG_FILE` | нет | Путь к файлу логов; без него логи только в stderr |
| `YANDEX_API_KEY` | для Wordstat | API-ключ AI Studio / Yandex Cloud (`Authorization: Api-Key`) |
| `YANDEX_FOLDER_ID` | для Wordstat | ID каталога Yandex Cloud (`folderId` в теле запроса) |

Wordstat работает через [Yandex Cloud Search API v2](https://aistudio.yandex.ru/ru/docs/search-api/concepts/wordstat), не через старый OAuth Директа. Нужны:

1. API-ключ сервисного аккаунта (лучше со scope `yc.search-api.execute`).
2. Роль `search-api.webSearch.user` или `search-api.executor` на каталоге.
3. `folderId` каталога — в [консоли Yandex Cloud](https://console.yandex.cloud/) на странице каталога и в URL (`.../folders/b1g...`).
4. Активный биллинг в облаке (иначе часто приходит `403 Permission denied`).

После заполнения `.env` пересоберите (`npm run build`) и перезапустите MCP wordpress в Cursor.

Отдельный сервер только с Wordstat:

```bash
npm run dev:wordstat
```

---

## Запуск

### Вариант A — локальное тестирование БЕЗ компиляции (tsx)

Запускает `src/index.ts` напрямую, без сборки в `dist/`:

```bash
npm run dev
```

Для отладки протокола удобно через инспектор:

```bash
npm run inspect      # поднимает @modelcontextprotocol/inspector над tsx src/index.ts
```

### Вариант B — сборка и запуск скомпилированной версии

```bash
npm run build        # tsc -> dist/
npm start            # node dist/index.js
```

### Вариант C — через npx (после публикации в npm)

```bash
npx -y mcp-wordpress-publisher
```

---

## Подключение к MCP-клиенту

Готовые примеры — в [`mcp.config.example.json`](./mcp.config.example.json). Скопируйте нужный блок в конфигурацию клиента.

**Локальный запуск без компиляции (tsx):**

```json
{
  "mcpServers": {
    "wordpress": {
      "command": "npx",
      "args": ["-y", "tsx", "C:\\Users\\USER\\Desktop\\MCP WP\\src\\index.ts"],
      "env": {
        "WORDPRESS_URL": "https://blog.sellerix.ru",
        "WORDPRESS_USERNAME": "cursor",
        "WORDPRESS_APP_PASSWORD": "пароль-приложения",
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

**Через npx (после публикации):**

```json
{
  "mcpServers": {
    "wordpress": {
      "command": "npx",
      "args": ["-y", "mcp-wordpress-publisher"],
      "env": {
        "WORDPRESS_URL": "https://blog.sellerix.ru",
        "WORDPRESS_USERNAME": "cursor",
        "WORDPRESS_APP_PASSWORD": "пароль-приложения"
      }
    }
  }
}
```

---

## Режим HTTP (для ChatGPT и удалённого доступа)

Кроме stdio сервер умеет работать по **Streamable HTTP** — это нужно для ChatGPT, который подключается только к удалённым MCP-серверам по HTTPS-URL (локальный stdio/npx он не запускает).

Включается переменными окружения:

| Переменная | Назначение |
|-----------|-----------|
| `MCP_TRANSPORT=http` | Включить HTTP-режим (иначе stdio) |
| `MCP_HTTP_PORT` | Порт (по умолчанию `3000`) |
| `MCP_HTTP_HOST` | Хост (по умолчанию `0.0.0.0`) |
| `MCP_AUTH_TOKEN` | **Bearer-токен** авторизации (обязателен для публичного доступа) |

Локальный запуск HTTP-режима:

```bash
MCP_TRANSPORT=http MCP_AUTH_TOKEN=секрет npm start
# эндпоинт: http://localhost:3000/mcp  (Authorization: Bearer секрет)
```

Эндпоинт MCP — `POST/GET/DELETE /mcp`. Именно URL `https://<домен>/mcp` указывается в ChatGPT.

---

## Деплой на VPS (Ubuntu/Debian) + подключение к ChatGPT

**Полная пошаговая инструкция для PuTTY / HostVDS:** см. **[DEPLOY.md](./DEPLOY.md)** — установка в `/opt/mcp-wordpress-publisher` без затрагивания других файлов на сервере.

Кратко:

```bash
# 1. Node.js 20 LTS (аддитивно, не ломает существующее)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Отдельный пользователь и папка
sudo useradd -r -m -d /opt/mcp-wordpress -s /usr/sbin/nologin mcpwp
sudo npm install -g mcp-wordpress-publisher

# 3. Переменные окружения (только root-доступ к файлу)
sudo tee /opt/mcp-wordpress/.env >/dev/null <<'EOF'
WORDPRESS_URL=https://blog.sellerix.ru
WORDPRESS_USERNAME=cursor
WORDPRESS_APP_PASSWORD=пароль-приложения
MCP_TRANSPORT=http
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=3000
MCP_AUTH_TOKEN=длинный-случайный-токен
LOG_LEVEL=info
EOF
sudo chown mcpwp:mcpwp /opt/mcp-wordpress/.env
sudo chmod 600 /opt/mcp-wordpress/.env
```

Systemd-сервис `/etc/systemd/system/mcp-wordpress.service`:

```ini
[Unit]
Description=MCP WordPress Publisher (HTTP)
After=network.target

[Service]
Type=simple
User=mcpwp
WorkingDirectory=/opt/mcp-wordpress
EnvironmentFile=/opt/mcp-wordpress/.env
ExecStart=/usr/bin/mcp-wordpress-publisher
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mcp-wordpress
sudo systemctl status mcp-wordpress          # должно быть active (running)
curl -s localhost:3000/ | head              # health-check
```

Nginx-виртуалхост `/etc/nginx/sites-available/mcp` (только для нового поддомена):

```nginx
server {
    listen 80;
    server_name mcp.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Connection '';
        proxy_buffering off;          # важно для SSE
        proxy_read_timeout 3600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/mcp /etc/nginx/sites-enabled/mcp
sudo nginx -t && sudo systemctl reload nginx
# HTTPS (Let's Encrypt):
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d mcp.example.com
```

Проверка снаружи:

```bash
curl https://mcp.example.com/            # health-check без токена
# initialize с токеном (должен вернуть JSON, а не 401):
curl -s -X POST https://mcp.example.com/mcp \
  -H "Authorization: Bearer длинный-случайный-токен" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

### Подключение в ChatGPT

1. Нужен платный план (Plus/Pro/Business/Enterprise/Edu).
2. Settings → **Connectors** → Advanced → включить **Developer Mode**.
3. **Add custom connector**:
   - **URL:** `https://mcp.example.com/mcp`
   - **Authentication:** `Token` → вставить `MCP_AUTH_TOKEN`.
4. Инструменты (`wp_create_post` и др.) появятся в чате (read/write, с подтверждением).

Обновление версии на сервере:

```bash
sudo npm install -g mcp-wordpress-publisher@latest
sudo systemctl restart mcp-wordpress
```

---

## Логирование

- Все логи пишутся в **stderr** (stdout зарезервирован под JSON-RPC протокол MCP).
- Уровни: `error`, `warn`, `info`, `debug` — через `LOG_LEVEL`.
- Опционально — дублирование в файл через `LOG_FILE`.
- Логируются: старт сервера, загрузка конфигурации, каждый HTTP-запрос к WordPress (метод, путь, статус, время), тела запросов/ответов (на `debug`), все ошибки с HTTP-статусом и телом ответа WordPress.

---

## Публикация в npm

```bash
# 1. Проверка сборки
npm run build

# 2. Логин в npm (однократно)
npm login

# 3. Публикация (prepublishOnly соберёт проект автоматически)
npm publish
```

Готовность к публикации обеспечена:
- `bin` → запуск через `npx mcp-wordpress-publisher`;
- `files` + `.npmignore` → в пакет попадает только `dist/`, README, LICENSE, `.env.example`;
- `prepublishOnly`/`prepare` → автоматическая сборка перед публикацией;
- `publishConfig.access = public` → публичный пакет.

> Перед публикацией задайте уникальное `name` в `package.json` (если `mcp-wordpress-publisher` занято, используйте scope, напр. `@ваш-ник/mcp-wordpress-publisher`) и заполните поля `author`/`repository`.

---

## Чек-лист готовности проекта

Файл-ориентир для проверки, что всё реализовано:

- [x] MCP-сервер на TypeScript SDK (`@modelcontextprotocol/sdk`, stdio-транспорт)
- [x] Публикация статей на WordPress через REST API (`wp_create_post`, `wp_update_post`)
- [x] Данные сайта вынесены в env (`WORDPRESS_URL`, `WORDPRESS_USERNAME`, `WORDPRESS_APP_PASSWORD`)
- [x] Полный набор инструментов: создание/обновление/чтение/список/удаление статей, категории, метки
- [x] Логирование везде (конфиг, HTTP-запросы, инструменты, ошибки) с уровнями и опциональным файлом
- [x] README с описанием проекта и инструкциями
- [x] Конфигурация для запуска через `npx` (`bin` в package.json + пример в `mcp.config.example.json`)
- [x] Подготовка к публикации в npm (`files`, `.npmignore`, `prepublishOnly`, `publishConfig`)
- [x] Конфиг для локального тестирования без компиляции (`npm run dev` через `tsx`, блок `wordpress-local-dev`)
- [x] Валидация обязательных переменных окружения с понятными ошибками
- [x] Указан реальный `WORDPRESS_APP_PASSWORD` (пароль приложения, не пароль от админки!)
- [x] HTTP-транспорт (Streamable HTTP) для ChatGPT + Bearer-авторизация (`MCP_TRANSPORT=http`)
- [x] Скрипты деплоя на VPS (`deploy/`, `DEPLOY.md`)

---

## Устранение неполадок

| Симптом | Причина / решение |
|---------|-------------------|
| `Отсутствуют обязательные переменные окружения` | Не заполнен `.env` или `env` в конфиге клиента |
| HTTP 401 | Неверный логин или Application Password; проверьте `wp_verify_connection` |
| HTTP 403 | У пользователя нет прав на публикацию; проверьте роль в WordPress |
| Сетевая ошибка | Недоступен `WORDPRESS_URL` или блокирует firewall/Cloudflare |
| HTTP 403 от Wordstat | Нет роли `search-api.webSearch.user` на каталоге, неверный scope ключа или неактивный биллинг |

---

## Лицензия

MIT — см. [LICENSE](./LICENSE).
