import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import type { WordPressClient } from "./wordpress.js";

export const SERVER_NAME = "mcp-wordpress-publisher";
export const SERVER_VERSION = "1.1.0";

/**
 * Собирает настроенный экземпляр MCP-сервера с зарегистрированными
 * инструментами. Вынесено отдельно, чтобы переиспользовать и в stdio-,
 * и в HTTP-транспорте (в HTTP на каждую сессию создаётся свой экземпляр).
 */
export function createMcpServer(wp: WordPressClient): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  registerTools(server, wp);
  return server;
}
