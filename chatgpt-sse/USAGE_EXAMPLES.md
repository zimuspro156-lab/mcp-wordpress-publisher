# Примеры использования WordPress MCP Server

Сервер слушает порт `8000`. Для ChatGPT после туннеля используйте `https://your-url.trycloudflare.com/mcp`.

## В ChatGPT

### Создание статьи

```
Пользователь: Напиши статью про Model Context Protocol на 500 слов и опубликуй на моём сайте

ChatGPT: [create_post]

Статья опубликована.
URL: https://blog.sellerix.ru/...
```

### Последние посты

```
Пользователь: Покажи последние 5 постов с сайта

ChatGPT: [get_posts, per_page=5]
```

### Обновление

```
Пользователь: Обнови пост с ID 123, добавь в конец «P.S. Обновлено»

ChatGPT: [update_post]
```

### Черновик

```
Пользователь: Создай черновик статьи про Python, не публикуй

ChatGPT: [create_post, status=draft]
```

## Через curl (JSON-RPC на /mcp)

Замените хост на свой HTTPS URL при работе через Cloudflare.

### initialize

```bash
curl -sS -X POST http://127.0.0.1:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {"name": "curl", "version": "1.0"}
    }
  }'
```

### Список инструментов

```bash
curl -sS -X POST http://127.0.0.1:8000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

### Создать черновик

```bash
curl -sS -X POST http://127.0.0.1:8000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "create_post",
      "arguments": {
        "title": "Test Post",
        "content": "<p>This is a test</p>",
        "status": "draft"
      }
    }
  }'
```

### Получить посты

```bash
curl -sS -X POST http://127.0.0.1:8000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "get_posts",
      "arguments": {"per_page": 5}
    }
  }'
```

### Обновить пост

```bash
curl -sS -X POST http://127.0.0.1:8000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "update_post",
      "arguments": {
        "post_id": 123,
        "excerpt": "Updated excerpt"
      }
    }
  }'
```

### Удалить пост

```bash
curl -sS -X POST http://127.0.0.1:8000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 6,
    "method": "tools/call",
    "params": {
      "name": "delete_post",
      "arguments": {"post_id": 123}
    }
  }'
```

### Health

```bash
curl -sS http://127.0.0.1:8000/health
```

Если задан `MCP_AUTH_TOKEN`, добавьте:

```bash
-H "Authorization: Bearer YOUR_TOKEN"
```
