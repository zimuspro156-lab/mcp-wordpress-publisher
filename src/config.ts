import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { logger } from "./logger.js";
import { loadWordstatConfig, type WordstatConfig } from "./wordstat.js";

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
  /** Ключ и каталог Yandex Wordstat. Если нет — инструменты Wordstat не регистрируются. */
  wordstat: WordstatConfig | null;
}

/**
 * Загружает .env (если есть), переинициализирует логгер и валидирует
 * обязательные переменные. Бросает исключение с понятным текстом, если
 * чего-то не хватает.
 */
export function loadConfig(): AppConfig {
  // Загружаем .env для локального запуска. В проде переменные обычно
  // приходят из окружения MCP-клиента и dotenv просто ничего не находит.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fromCwd = loadDotenv();
  const fromRoot = loadDotenv({ path: path.resolve(here, "../.env") });
  logger.reconfigure();

  const parsedKeys = [
    ...Object.keys(fromCwd.parsed ?? {}),
    ...Object.keys(fromRoot.parsed ?? {}),
  ];
  if (parsedKeys.length > 0) {
    logger.debug("Файл .env загружен", { keys: [...new Set(parsedKeys)] });
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
  const wordstat = loadWordstatConfig();

  logger.info("Конфигурация загружена", {
    wordpressUrl,
    username,
    appPasswordLength: appPassword!.length,
    transport,
    httpPort: transport === "http" ? httpPort : undefined,
    authTokenSet: Boolean(authToken),
    wordstatFolderId: wordstat?.folderId,
    wordstatEnabled: Boolean(wordstat),
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
    wordstat,
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
