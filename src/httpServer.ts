import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "./logger.js";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "./mcpServer.js";
import type { AppConfig } from "./config.js";
import type { WordPressClient } from "./wordpress.js";
import type { WordstatClient } from "./wordstat.js";

/**
 * Запускает MCP-сервер по транспорту Streamable HTTP.
 *
 * Эндпоинт: POST/GET/DELETE /mcp (это и есть URL для ChatGPT-коннектора).
 * Авторизация: заголовок `Authorization: Bearer <MCP_AUTH_TOKEN>`.
 */
export async function startHttpServer(
  config: AppConfig,
  wp: WordPressClient,
  wordstat?: WordstatClient | null,
): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "25mb" }));

  // Простой health-check без авторизации.
  app.get("/", (_req, res) => {
    res.json({ name: SERVER_NAME, version: SERVER_VERSION, transport: "http", endpoint: "/mcp" });
  });

  // Авторизация всех /mcp-запросов по Bearer-токену.
  app.use("/mcp", (req: Request, res: Response, next) => {
    if (!config.authToken) {
      // Токен не задан — пропускаем (при этом в логах уже было предупреждение).
      return next();
    }
    const header = req.headers.authorization ?? "";
    const expected = `Bearer ${config.authToken}`;
    if (header === expected) {
      return next();
    }
    logger.warn("HTTP: отклонён запрос без валидного Bearer-токена", {
      ip: req.ip,
      hasHeader: Boolean(req.headers.authorization),
    });
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: неверный или отсутствующий Bearer-токен" },
      id: null,
    });
  });

  // Хранилище активных транспортов по идентификатору сессии.
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // Основной эндпоинт: клиент -> сервер.
  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // Новая сессия: создаём транспорт и отдельный экземпляр MCP-сервера.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
            logger.info(`HTTP: инициализирована сессия ${sid}`);
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
            logger.info(`HTTP: сессия ${transport.sessionId} закрыта`);
          }
        };

        const server = createMcpServer(wp, wordstat);
        await server.connect(transport);
      } else {
        logger.warn("HTTP: запрос без валидной сессии и не initialize");
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: отсутствует mcp-session-id" },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("HTTP: ошибка обработки POST /mcp", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // GET/DELETE: SSE-поток уведомлений и завершение сессии.
  const handleSessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch (error) {
      logger.error("HTTP: ошибка обработки сессионного запроса", error);
      if (!res.headersSent) res.status(500).end();
    }
  };

  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  await new Promise<void>((resolve) => {
    app.listen(config.httpPort, config.httpHost, () => {
      logger.info(
        `MCP-сервер (HTTP) слушает http://${config.httpHost}:${config.httpPort}/mcp`,
      );
      resolve();
    });
  });
}
