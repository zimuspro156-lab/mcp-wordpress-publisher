import fs from "node:fs";
import path from "node:path";

/**
 * Уровни логирования по возрастанию детализации.
 */
export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function parseLevel(value: string | undefined): LogLevel {
  const normalized = (value ?? "info").toLowerCase();
  if (normalized === "error" || normalized === "warn" || normalized === "info" || normalized === "debug") {
    return normalized;
  }
  return "info";
}

/**
 * Простой логгер для MCP-сервера.
 *
 * ВАЖНО: при работе по stdio-транспорту stdout занят JSON-RPC протоколом,
 * поэтому ВСЕ логи пишутся в stderr (и, опционально, в файл).
 */
class Logger {
  private level: LogLevel;
  private fileStream: fs.WriteStream | null = null;

  constructor() {
    this.level = parseLevel(process.env.LOG_LEVEL);
    this.initFileStream(process.env.LOG_FILE);
  }

  /** Переинициализация после загрузки .env (уровень и файл могли измениться). */
  reconfigure(): void {
    this.level = parseLevel(process.env.LOG_LEVEL);
    this.initFileStream(process.env.LOG_FILE);
  }

  private initFileStream(logFile: string | undefined): void {
    if (!logFile) {
      return;
    }
    try {
      const absolute = path.resolve(logFile);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      this.fileStream = fs.createWriteStream(absolute, { flags: "a" });
    } catch (error) {
      // Не роняем сервер из-за проблем с файлом логов — сообщаем в stderr.
      process.stderr.write(
        `[logger] Не удалось открыть файл логов "${logFile}": ${String(error)}\n`,
      );
      this.fileStream = null;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] <= LEVEL_ORDER[this.level];
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const timestamp = new Date().toISOString();
    let line = `${timestamp} [${level.toUpperCase()}] ${message}`;

    if (meta !== undefined) {
      line += ` ${safeStringify(meta)}`;
    }
    line += "\n";

    // stderr — безопасный канал для stdio-транспорта.
    process.stderr.write(line);

    if (this.fileStream) {
      this.fileStream.write(line);
    }
  }

  error(message: string, meta?: unknown): void {
    this.write("error", message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write("warn", message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.write("info", message, meta);
  }

  debug(message: string, meta?: unknown): void {
    this.write("debug", message, meta);
  }
}

/**
 * Безопасная сериализация метаданных: не падает на циклических ссылках
 * и на объектах Error (у которых поля неперечислимые).
 */
function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return JSON.stringify({
      name: value.name,
      message: value.message,
      stack: value.stack,
    });
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const logger = new Logger();
