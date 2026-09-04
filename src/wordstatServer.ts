#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "./logger.js";
import { loadWordstatConfig, WordstatClient } from "./wordstat.js";
import { registerWordstatTools } from "./wordstatTools.js";

const SERVER_NAME = "mcp-yandex-wordstat";
const SERVER_VERSION = "1.0.0";

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  loadDotenv();
  loadDotenv({ path: path.resolve(here, "../.env") });
  logger.reconfigure();

  logger.info(`Запуск ${SERVER_NAME} v${SERVER_VERSION}`);

  const config = loadWordstatConfig();
  if (!config) {
    throw new Error(
      "Задайте YANDEX_API_KEY и YANDEX_FOLDER_ID в .env или в конфигурации MCP-клиента.",
    );
  }

  const wordstat = new WordstatClient(config);
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  registerWordstatTools(server, wordstat);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Wordstat MCP подключён по stdio");
}

process.on("uncaughtException", (error) => {
  logger.error("uncaughtException", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", reason);
  process.exit(1);
});

main().catch((error) => {
  logger.error("Критическая ошибка при запуске Wordstat MCP", error);
  process.exit(1);
});
