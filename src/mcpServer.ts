import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { registerWordstatTools } from "./wordstatTools.js";
import type { WordPressClient } from "./wordpress.js";
import type { WordstatClient } from "./wordstat.js";

export const SERVER_NAME = "mcp-wordpress-publisher";
export const SERVER_VERSION = "1.2.0";

const SERVER_INSTRUCTIONS = [
  "Этот MCP публикует статьи на WordPress и (если настроено) смотрит частотность в Яндекс Wordstat.",
  "Картинки он НЕ генерирует. Их даёт пользователь или отдельный image-MCP — как http(s) URL или base64 / data URI.",
  "",
  "Сценарий «напиши статью на тему X и опубликуй»:",
  "1. Если пользователь просит ключи / Wordstat — сначала wordstat_top (при необходимости dynamics и regions).",
  "2. Напиши HTML-статью без ведущего H1: заголовок уже показывает тема сайта.",
  "3. Прими готовые изображения и загрузи их: wp_upload_media или поле images у wp_create_post.",
  "4. Категории и метки возьми из уже существующих на сайте (по названию или доверь автоподбор wp_create_post).",
  "5. Опубликуй через wp_create_post со status=publish. Если просят не публиковать — status=draft.",
].join("\n");

/**
 * Собирает настроенный экземпляр MCP-сервера с зарегистрированными
 * инструментами. Вынесено отдельно, чтобы переиспользовать и в stdio-,
 * и в HTTP-транспорте (в HTTP на каждую сессию создаётся свой экземпляр).
 */
export function createMcpServer(
  wp: WordPressClient,
  wordstat?: WordstatClient | null,
): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, wp);
  if (wordstat) {
    registerWordstatTools(server, wordstat);
  }
  return server;
}
