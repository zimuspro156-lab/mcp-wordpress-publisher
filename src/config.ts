import { config as loadDotenv } from "dotenv";
import { logger } from "./logger.js";

/**
 * Итоговая конфигурация сервера, собранная из переменных окружения.
 */
export interface AppConfig {
  wordpressUrl: string;
  username: string;
  appPassword: string;
  /** Транспорт: "stdio" (для Cursor/Claude) или "http" (для ChatGPT/удалённого доступа). */
  transport: "stdio" | "http";
  /** Порт HTTP-сервера (только для transport=http). */
  httpPort: number;
  /** Хост HTTP-сервера (только для transport=http). */
  httpHost: string;
  /** Bearer-токен для авторизации HTTP-запросов. Если не задан — доступ открыт (небезопасно). */
  authToken?: string;
}

/**
 * Загружает .env (если есть), переинициализирует логгер и валидирует
 * обязательные переменные. Бросает исключение с понятным текстом, если
 * чего-то не хватает.
 */
export function loadConfig(): AppConfig {
  // Загружаем .env для локального запуска. В проде переменные обычно
  // приходят из окружения MCP-клиента и dotenv просто ничего не находит.
  const result = loadDotenv();
  logger.reconfigure();

  if (result.parsed) {
    logger.debug("Файл .env загружен", { keys: Object.keys(result.parsed) });
  } else {
    logger.debug(".env не найден — используются переменные окружения процесса");
  }

  const rawUrl = process.env.WORDPRESS_URL?.trim();
  const username = process.env.WORDPRESS_USERNAME?.trim();
  const appPassword = process.env.WORDPRESS_APP_PASSWORD?.trim();

  const missing: string[] = [];
  if (!rawUrl) missing.push("WORDPRESS_URL");
  if (!username) missing.push("WORDPRESS_USERNAME");
  if (!appPassword) missing.push("WORDPRESS_APP_PASSWORD");

  if (missing.length > 0) {
    const message =
      `Отсутствуют обязательные переменные окружения: ${missing.join(", ")}. ` +
      `Задайте их в .env или в конфигурации MCP-клиента.`;
    logger.error(message);
    throw new Error(message);
  }

  // Нормализуем URL: убираем хвостовой слэш и возможный /wp-json.
  const wordpressUrl = normalizeWordpressUrl(rawUrl!);

  const transport = process.env.MCP_TRANSPORT?.trim().toLowerCase() === "http" ? "http" : "stdio";
  const httpPort = parsePort(process.env.MCP_HTTP_PORT, 3000);
  const httpHost = process.env.MCP_HTTP_HOST?.trim() || "0.0.0.0";
  const authToken = process.env.MCP_AUTH_TOKEN?.trim() || undefined;

  logger.info("Конфигурация загружена", {
    wordpressUrl,
    username,
    appPasswordLength: appPassword!.length,
    transport,
    httpPort: transport === "http" ? httpPort : undefined,
    authTokenSet: Boolean(authToken),
  });

  if (transport === "http" && !authToken) {
    logger.warn(
      "MCP_AUTH_TOKEN не задан — HTTP-эндпоинт будет открыт БЕЗ авторизации. " +
        "Для публичного доступа обязательно задайте токен.",
    );
  }

  return {
    wordpressUrl,
    username: username!,
    appPassword: appPassword!,
    transport,
    httpPort,
    httpHost,
    authToken,
  };
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
    return parsed;
  }
  return fallback;
}

function normalizeWordpressUrl(url: string): string {
  let normalized = url.trim().replace(/\/+$/, "");
  normalized = normalized.replace(/\/wp-json$/i, "");
  return normalized;
}
