#!/usr/bin/env python3
"""
WordPress MCP SSE / Streamable HTTP Server for ChatGPT and other MCP clients.

Architecture:
  ChatGPT → HTTPS → Cloudflare Tunnel → FastAPI (port 8000) → WordPress REST API

Credentials are loaded from environment / .env (never hardcoded).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Optional

import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from mcp.server import Server
from mcp.types import TextContent, Tool
from sse_starlette.sse import EventSourceResponse

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

for candidate in (
    Path(__file__).resolve().parent / ".env",
    Path(__file__).resolve().parent.parent / ".env",
):
    if candidate.is_file():
        load_dotenv(candidate, override=False)

logging.basicConfig(
    level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("wordpress-mcp")

SERVER_NAME = "wordpress-mcp-sse-server"
SERVER_VERSION = "1.0.0"
PROTOCOL_VERSION = "2024-11-05"
SUPPORTED_PROTOCOL_VERSIONS = {
    "2024-11-05",
    "2025-03-26",
    "2025-06-18",
}

HOST = os.getenv("MCP_HTTP_HOST", "0.0.0.0")
PORT = int(os.getenv("MCP_HTTP_PORT", "8000"))
AUTH_TOKEN = os.getenv("MCP_AUTH_TOKEN", "").strip() or None


def _normalize_wp_url(raw: str) -> str:
    url = raw.strip().rstrip("/")
    if url.lower().endswith("/wp-json"):
        url = url[: -len("/wp-json")]
    return url


WORDPRESS_URL = _normalize_wp_url(os.getenv("WORDPRESS_URL", "https://blog.sellerix.ru"))
WORDPRESS_USERNAME = os.getenv("WORDPRESS_USERNAME", "cursor").strip()
WORDPRESS_PASSWORD = (
    os.getenv("WORDPRESS_APP_PASSWORD") or os.getenv("WORDPRESS_PASSWORD") or ""
).strip()

if not WORDPRESS_PASSWORD:
    logger.error(
        "WORDPRESS_APP_PASSWORD is not set. Put it in .env and restart. "
        "Do not hardcode Application Passwords in source files."
    )
    sys.exit(1)

# ---------------------------------------------------------------------------
# WordPress client
# ---------------------------------------------------------------------------


def _rendered(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("rendered", "") or "")
    return str(value or "")


class WordPressMCP:
    """Async client for WordPress REST API (/wp-json/wp/v2)."""

    def __init__(self, base_url: str, username: str, password: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api = f"{self.base_url}/wp-json/wp/v2"
        self.client = httpx.AsyncClient(
            auth=httpx.BasicAuth(username, password),
            headers={
                "User-Agent": f"{SERVER_NAME}/{SERVER_VERSION}",
                "Accept": "application/json",
            },
            timeout=30.0,
            follow_redirects=True,
        )
        logger.info("WordPress client ready for %s (user=%s)", self.base_url, username)

    async def create_post(
        self,
        title: str,
        content: str,
        excerpt: str = "",
        status: str = "publish",
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "title": title,
            "content": content,
            "status": status or "publish",
        }
        if excerpt:
            payload["excerpt"] = excerpt
        logger.info("WP create_post title=%r status=%s", title, payload["status"])
        return await self._request("POST", "/posts", json_body=payload, on_ok=self._post_result("created"))

    async def update_post(
        self,
        post_id: int,
        title: Optional[str] = None,
        content: Optional[str] = None,
        excerpt: Optional[str] = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        if title is not None:
            payload["title"] = title
        if content is not None:
            payload["content"] = content
        if excerpt is not None:
            payload["excerpt"] = excerpt
        if not payload:
            return {"success": False, "post_id": post_id, "message": "Nothing to update"}
        logger.info("WP update_post id=%s fields=%s", post_id, list(payload.keys()))
        return await self._request(
            "POST",
            f"/posts/{int(post_id)}",
            json_body=payload,
            on_ok=self._post_result("updated"),
        )

    async def get_posts(self, per_page: int = 10, page: int = 1) -> dict[str, Any]:
        per_page = max(1, min(int(per_page), 100))
        page = max(1, int(page))
        logger.info("WP get_posts per_page=%s page=%s", per_page, page)
        try:
            response = await self.client.get(
                f"{self.api}/posts",
                params={"per_page": per_page, "page": page, "_fields": "id,date,status,link,title,excerpt"},
            )
            logger.info("WP GET /posts -> %s", response.status_code)
            if response.status_code >= 400:
                return {
                    "success": False,
                    "posts": [],
                    "count": 0,
                    "message": self._error_message(response),
                }
            raw_posts = response.json()
            posts = [
                {
                    "id": item.get("id"),
                    "title": _rendered(item.get("title")),
                    "excerpt": _rendered(item.get("excerpt")),
                    "url": item.get("link"),
                    "status": item.get("status"),
                    "date": item.get("date"),
                }
                for item in raw_posts
            ]
            return {
                "success": True,
                "posts": posts,
                "count": len(posts),
                "message": f"Fetched {len(posts)} post(s)",
            }
        except Exception as exc:
            logger.exception("WP get_posts failed")
            return {"success": False, "posts": [], "count": 0, "message": str(exc)}

    async def delete_post(self, post_id: int) -> dict[str, Any]:
        logger.info("WP delete_post id=%s", post_id)
        try:
            response = await self.client.delete(f"{self.api}/posts/{int(post_id)}")
            logger.info("WP DELETE /posts/%s -> %s", post_id, response.status_code)
            if response.status_code >= 400:
                return {
                    "success": False,
                    "post_id": post_id,
                    "message": self._error_message(response),
                }
            return {
                "success": True,
                "post_id": post_id,
                "message": f"Post {post_id} deleted",
            }
        except Exception as exc:
            logger.exception("WP delete_post failed")
            return {"success": False, "post_id": post_id, "message": str(exc)}

    async def verify(self) -> dict[str, Any]:
        try:
            response = await self.client.get(f"{self.api}/users/me")
            if response.status_code >= 400:
                return {"success": False, "message": self._error_message(response)}
            data = response.json()
            return {
                "success": True,
                "user": data.get("slug") or data.get("name"),
                "id": data.get("id"),
                "message": "WordPress connection OK",
            }
        except Exception as exc:
            return {"success": False, "message": str(exc)}

    async def close(self) -> None:
        await self.client.aclose()
        logger.info("WordPress HTTP client closed")

    def _post_result(self, action: str):
        def _ok(data: dict[str, Any]) -> dict[str, Any]:
            post_id = data.get("id")
            url = data.get("link")
            return {
                "success": True,
                "post_id": post_id,
                "url": url,
                "status": data.get("status"),
                "message": f"Post {action} successfully (id={post_id})",
            }

        return _ok

    async def _request(
        self,
        method: str,
        path: str,
        json_body: Optional[dict[str, Any]] = None,
        on_ok=None,
    ) -> dict[str, Any]:
        try:
            response = await self.client.request(method, f"{self.api}{path}", json=json_body)
            logger.info("WP %s %s -> %s", method, path, response.status_code)
            if response.status_code >= 400:
                return {"success": False, "message": self._error_message(response)}
            data = response.json()
            return on_ok(data) if on_ok else {"success": True, "data": data}
        except Exception as exc:
            logger.exception("WP %s %s failed", method, path)
            return {"success": False, "message": str(exc)}

    @staticmethod
    def _error_message(response: httpx.Response) -> str:
        try:
            payload = response.json()
            detail = payload.get("message") or payload
        except Exception:
            detail = response.text[:500]
        return f"WordPress API error {response.status_code}: {detail}"


wp: Optional[WordPressMCP] = None

# ---------------------------------------------------------------------------
# MCP tools
# ---------------------------------------------------------------------------

CREATE_POST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": "Post title"},
        "content": {"type": "string", "description": "Post content in HTML"},
        "excerpt": {"type": "string", "description": "Post excerpt", "default": ""},
        "status": {
            "type": "string",
            "enum": ["publish", "draft", "private"],
            "default": "publish",
            "description": "Publication status",
        },
    },
    "required": ["title", "content"],
}

UPDATE_POST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "post_id": {"type": "integer", "description": "ID of the post to update"},
        "title": {"type": "string", "description": "New title"},
        "content": {"type": "string", "description": "New HTML content"},
        "excerpt": {"type": "string", "description": "New excerpt"},
    },
    "required": ["post_id"],
}

GET_POSTS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "per_page": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100,
            "default": 10,
            "description": "Number of posts per page (1-100)",
        },
        "page": {"type": "integer", "minimum": 1, "default": 1, "description": "Page number"},
    },
}

DELETE_POST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "post_id": {"type": "integer", "description": "ID of the post to delete"},
    },
    "required": ["post_id"],
}

TOOLS: list[Tool] = [
    Tool(name="create_post", description="Create a new WordPress post on your site", inputSchema=CREATE_POST_SCHEMA),
    Tool(name="update_post", description="Update an existing WordPress post", inputSchema=UPDATE_POST_SCHEMA),
    Tool(name="get_posts", description="Get list of WordPress posts", inputSchema=GET_POSTS_SCHEMA),
    Tool(name="delete_post", description="Delete a WordPress post", inputSchema=DELETE_POST_SCHEMA),
]

TOOL_NAMES = [tool.name for tool in TOOLS]


def tools_as_dicts() -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for tool in TOOLS:
        dumped = tool.model_dump(by_alias=True, exclude_none=True)
        result.append(dumped)
    return result


async def dispatch_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    if wp is None:
        return {"success": False, "message": "WordPress client is not initialized"}
    args = arguments or {}
    logger.info("Tool call %s args_keys=%s", name, list(args.keys()))
    if name == "create_post":
        return await wp.create_post(
            title=str(args.get("title") or ""),
            content=str(args.get("content") or ""),
            excerpt=str(args.get("excerpt") or ""),
            status=str(args.get("status") or "publish"),
        )
    if name == "update_post":
        return await wp.update_post(
            post_id=int(args["post_id"]),
            title=args.get("title"),
            content=args.get("content"),
            excerpt=args.get("excerpt"),
        )
    if name == "get_posts":
        return await wp.get_posts(
            per_page=int(args.get("per_page") or 10),
            page=int(args.get("page") or 1),
        )
    if name == "delete_post":
        return await wp.delete_post(post_id=int(args["post_id"]))
    return {"success": False, "message": f"Unknown tool: {name}"}


mcp_server = Server(SERVER_NAME)


@mcp_server.list_tools()
async def list_tools() -> list[Tool]:
    return TOOLS


@mcp_server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    result = await dispatch_tool(name, arguments or {})
    return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False))]


# ---------------------------------------------------------------------------
# JSON-RPC (Streamable HTTP compatible)
# ---------------------------------------------------------------------------

sessions: dict[str, dict[str, Any]] = {}


def jsonrpc_result(req_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def jsonrpc_error(req_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


async def handle_jsonrpc(body: dict[str, Any]) -> Optional[dict[str, Any]]:
    req_id = body.get("id")
    method = body.get("method")
    params = body.get("params") or {}
    logger.info("JSON-RPC method=%s id=%s", method, req_id)

    if method in ("notifications/initialized", "initialized") or (
        isinstance(method, str) and method.startswith("notifications/")
    ):
        return None

    if method == "initialize":
        client_version = ""
        if isinstance(params, dict):
            client_version = str(params.get("protocolVersion") or "")
        version = client_version if client_version in SUPPORTED_PROTOCOL_VERSIONS else PROTOCOL_VERSION
        return jsonrpc_result(
            req_id,
            {
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            },
        )

    if method == "ping":
        return jsonrpc_result(req_id, {})

    if method == "tools/list":
        return jsonrpc_result(req_id, {"tools": tools_as_dicts()})

    if method == "tools/call":
        name = params.get("name") if isinstance(params, dict) else None
        arguments = (params.get("arguments") if isinstance(params, dict) else None) or {}
        if not name:
            return jsonrpc_error(req_id, -32602, "Missing tool name")
        try:
            result = await dispatch_tool(str(name), arguments)
            return jsonrpc_result(
                req_id,
                {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "isError": not result.get("success", True),
                },
            )
        except Exception as exc:
            logger.exception("tools/call failed")
            return jsonrpc_result(
                req_id,
                {
                    "content": [{"type": "text", "text": json.dumps({"success": False, "message": str(exc)})}],
                    "isError": True,
                },
            )

    return jsonrpc_error(req_id, -32601, f"Method not found: {method}")


def wants_sse(request: Request) -> bool:
    accept = (request.headers.get("accept") or "").lower()
    return "text/event-stream" in accept and "application/json" not in accept


def encode_sse_message(payload: dict[str, Any]) -> bytes:
    return f"event: message\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    global wp
    wp = WordPressMCP(WORDPRESS_URL, WORDPRESS_USERNAME, WORDPRESS_PASSWORD)
    check = await wp.verify()
    if check.get("success"):
        logger.info("WordPress verified: %s", check)
    else:
        logger.warning("WordPress verify failed: %s", check)
    logger.info("Server %s v%s listening on %s:%s", SERVER_NAME, SERVER_VERSION, HOST, PORT)
    try:
        yield
    finally:
        if wp is not None:
            await wp.close()


app = FastAPI(title=SERVER_NAME, version=SERVER_VERSION, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Mcp-Session-Id"],
)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    protected = request.url.path in {"/mcp", "/sse"} or request.url.path.startswith("/messages")
    if AUTH_TOKEN and protected:
        header = request.headers.get("authorization", "")
        api_key = request.headers.get("x-api-key", "")
        expected_bearer = f"Bearer {AUTH_TOKEN}"
        if header != expected_bearer and api_key != AUTH_TOKEN:
            logger.warning("Rejected unauthorized request path=%s ip=%s", request.url.path, request.client)
            return JSONResponse(
                status_code=401,
                content={"jsonrpc": "2.0", "error": {"code": -32001, "message": "Unauthorized"}, "id": None},
            )
    return await call_next(request)


@app.get("/")
async def root() -> dict[str, Any]:
    return {
        "name": "WordPress MCP SSE Server",
        "version": SERVER_VERSION,
        "protocol": "MCP over SSE + Streamable HTTP",
        "wordpress": WORDPRESS_URL,
        "endpoints": {
            "health": "/health",
            "sse": "/sse",
            "mcp": "/mcp",
        },
        "tools": TOOL_NAMES,
        "chatgpt_url": "/mcp",
        "legacy_sse_url": "/sse",
    }


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "healthy", "service": "wordpress-mcp-sse-server"}


def _public_base(request: Request) -> str:
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}"


@app.get("/sse")
async def sse_endpoint(request: Request) -> EventSourceResponse:
    """
    Legacy MCP HTTP+SSE transport.

    Sends `endpoint` with the JSON-RPC POST URL, then a heartbeat every 15s
    so Cloudflare / nginx do not idle-timeout the stream.
    """
    mcp_url = f"{_public_base(request)}/mcp"
    logger.info("SSE client connected, endpoint=%s", mcp_url)

    async def event_generator() -> AsyncIterator[dict[str, str]]:
        yield {"event": "endpoint", "data": mcp_url}
        while True:
            if await request.is_disconnected():
                logger.info("SSE client disconnected")
                break
            await asyncio.sleep(15)
            yield {"event": "heartbeat", "data": json.dumps({"status": "alive"})}

    return EventSourceResponse(
        event_generator(),
        ping=15,
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.post("/mcp")
async def mcp_post(request: Request) -> Response:
    logger.info("POST /mcp from %s", request.client)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(jsonrpc_error(None, -32700, "Parse error"), status_code=400)

    session_id = request.headers.get("mcp-session-id")
    is_initialize = isinstance(body, dict) and body.get("method") == "initialize"

    if is_initialize:
        session_id = session_id or str(uuid.uuid4())
        sessions[session_id] = {"id": session_id}

    if isinstance(body, list):
        replies = []
        for item in body:
            if isinstance(item, dict):
                reply = await handle_jsonrpc(item)
                if reply is not None:
                    replies.append(reply)
        payload: Any = replies
        if not replies:
            return Response(status_code=202)
    elif isinstance(body, dict):
        payload = await handle_jsonrpc(body)
        if payload is None:
            return Response(status_code=202)
    else:
        return JSONResponse(jsonrpc_error(None, -32600, "Invalid Request"), status_code=400)

    headers = {"Access-Control-Expose-Headers": "Mcp-Session-Id"}
    if session_id:
        headers["Mcp-Session-Id"] = session_id

    if wants_sse(request):
        return Response(
            content=encode_sse_message(payload),
            media_type="text/event-stream",
            headers={**headers, "Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
    return JSONResponse(payload, headers=headers)


@app.get("/mcp")
async def mcp_get(request: Request) -> EventSourceResponse:
    """Streamable HTTP GET: keep-alive SSE stream for server-initiated messages."""
    logger.info("GET /mcp SSE stream opened")

    async def event_generator() -> AsyncIterator[dict[str, str]]:
        yield {"event": "ping", "data": json.dumps({"status": "alive"})}
        while True:
            if await request.is_disconnected():
                break
            await asyncio.sleep(15)
            yield {"event": "ping", "data": json.dumps({"status": "alive"})}

    return EventSourceResponse(
        event_generator(),
        ping=15,
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete("/mcp")
async def mcp_delete(request: Request) -> Response:
    session_id = request.headers.get("mcp-session-id")
    if session_id:
        sessions.pop(session_id, None)
        logger.info("Session closed %s", session_id)
    return Response(status_code=204)


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level=os.getenv("LOG_LEVEL", "info").lower())
