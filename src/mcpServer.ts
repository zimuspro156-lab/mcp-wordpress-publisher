import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { registerWordstatTools } from "./wordstatTools.js";
import type { WordPressClient } from "./wordpress.js";
import type { WordstatClient } from "./wordstat.js";

export const SERVER_NAME = "mcp-wordpress-publisher";
export const SERVER_VERSION = "1.1.0";

/**
 * Собирает настроенный экземпляр MCP-сервера с зарегистрированными
 * инструментами. Вынесено отдельно, чтобы переиспользовать и в stdio-,
 * и в HTTP-транспорте (в HTTP на каждую сессию создаётся свой экземпляр).
 */
export function createMcpServer(
  wp: WordPressClient,
  wordstat?: WordstatClient | null,
): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  registerTools(server, wp);
  if (wordstat) {
    registerWordstatTools(server, wordstat);
  }
  return server;
}
