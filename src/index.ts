#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger } from "./logger.js";
import { loadConfig } from "./config.js";
import { WordPressClient } from "./wordpress.js";
import { WordstatClient } from "./wordstat.js";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "./mcpServer.js";
import { startHttpServer } from "./httpServer.js";

async function main(): Promise<void> {
  logger.info(`Запуск ${SERVER_NAME} v${SERVER_VERSION}`);

  // 1. Конфигурация (с валидацией обязательных переменных).
  const config = loadConfig();

  // 2. Клиенты внешних API.
  const wp = new WordPressClient(config);
  const wordstat = config.wordstat ? new WordstatClient(config.wordstat) : null;
  if (!wordstat) {
    logger.info(
      "Wordstat отключён: задайте YANDEX_API_KEY и YANDEX_FOLDER_ID, чтобы включить инструменты частотности.",
    );
  }

  // 3. Выбор транспорта.
  if (config.transport === "http") {
    // HTTP (Streamable HTTP) — для ChatGPT и удалённого доступа.
    await startHttpServer(config, wp, wordstat);
  } else {
    // stdio — для Cursor / Claude Desktop.
    const server = createMcpServer(wp, wordstat);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("MCP-сервер подключён по stdio и готов принимать запросы");
  }
}

// Глобальные перехватчики, чтобы любые сбои попадали в лог, а не терялись.
process.on("uncaughtException", (error) => {
  logger.error("uncaughtException", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", reason);
  process.exit(1);
});

main().catch((error) => {
  logger.error("Критическая ошибка при запуске сервера", error);
  process.exit(1);
});
