import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "./logger.js";
import {
  WordstatApiError,
  WordstatClient,
  parseDevices,
  parsePeriod,
  parseRegionMode,
} from "./wordstat.js";

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    isError,
  };
}

function formatCount(value: number): string {
  return value.toLocaleString("ru-RU");
}

function formatShare(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  return `${(value * 100).toFixed(4)}%`;
}

async function runTool(
  name: string,
  fn: () => Promise<ReturnType<typeof textResult>>,
): Promise<ReturnType<typeof textResult>> {
  logger.info(`Вызов инструмента: ${name}`);
  try {
    const result = await fn();
    logger.info(`Инструмент ${name} завершён успешно`);
    return result;
  } catch (error) {
    if (error instanceof WordstatApiError) {
      logger.error(`Инструмент ${name}: ошибка Wordstat`, {
        status: error.status,
        body: error.body,
      });
      return textResult(
        `Ошибка Wordstat (HTTP ${error.status}): ${error.message}\n` +
          `Тело ответа: ${JSON.stringify(error.body)}`,
        true,
      );
    }
    logger.error(`Инструмент ${name}: непредвиденная ошибка`, error);
    return textResult(`Непредвиденная ошибка: ${String(error)}`, true);
  }
}

const phraseSchema = z.string().min(1).max(400).describe("Ключевая фраза для Wordstat");
const regionsSchema = z
  .array(z.string())
  .max(100)
  .optional()
  .describe("ID регионов Wordstat, например [\"213\"] для Москвы. Ищите через wordstat_find_region.");
const devicesSchema = z
  .array(z.string())
  .max(3)
  .optional()
  .describe("Типы устройств: all, desktop, phone, tablet");

/**
 * Регистрирует инструменты Yandex Wordstat (Search API v2).
 */
export function registerWordstatTools(server: McpServer, wordstat: WordstatClient): void {
  server.registerTool(
    "wordstat_top",
    {
      title: "Wordstat: топ запросов",
      description:
        "Яндекс Wordstat: частотность фразы за последние 30 дней, топ запросов, которые её содержат, " +
        "и семантически близкие ассоциации. Используйте перед выбором H1/ключа статьи.",
      inputSchema: {
        phrase: phraseSchema,
        numPhrases: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("Сколько фраз вернуть (1-2000, по умолчанию 20)"),
        regions: regionsSchema,
        devices: devicesSchema,
      },
    },
    async ({ phrase, numPhrases, regions, devices }) =>
      runTool("wordstat_top", async () => {
        const data = await wordstat.topRequests({
          phrase,
          numPhrases,
          regions,
          devices: parseDevices(devices),
        });

        const lines = [
          `Фраза: «${phrase}»`,
          regions?.length ? `Регионы: ${regions.join(", ")}` : "Регионы: все",
          `Всего запросов за 30 дней: ${formatCount(data.totalCount)}`,
          "",
          `Топ запросов (${data.results.length}):`,
        ];
        if (data.results.length === 0) {
          lines.push("  (пусто)");
        } else {
          for (const item of data.results) {
            lines.push(`  ${formatCount(item.count).padStart(10)}  ${item.phrase}`);
          }
        }

        lines.push("", `Ассоциации (${data.associations.length}):`);
        if (data.associations.length === 0) {
          lines.push("  (нет — для узких ниш это нормально)");
        } else {
          for (const item of data.associations) {
            lines.push(`  ${formatCount(item.count).padStart(10)}  ${item.phrase}`);
          }
        }

        return textResult(lines.join("\n"));
      }),
  );

  server.registerTool(
    "wordstat_dynamics",
    {
      title: "Wordstat: динамика",
      description:
        "Яндекс Wordstat: как часто искали фразу во времени (день / неделя / месяц). " +
        "Если даты не заданы, берётся разумный диапазон: 30 дней / 12 недель / 12 месяцев.",
      inputSchema: {
        phrase: phraseSchema,
        period: z
          .string()
          .optional()
          .describe("Гранулярность: daily, weekly или monthly (по умолчанию monthly)"),
        fromDate: z.string().optional().describe("Начало периода, ISO 8601 (например 2025-09-01)"),
        toDate: z.string().optional().describe("Конец периода, ISO 8601"),
        regions: regionsSchema,
        devices: devicesSchema,
      },
    },
    async ({ phrase, period, fromDate, toDate, regions, devices }) =>
      runTool("wordstat_dynamics", async () => {
        const parsedPeriod = parsePeriod(period ?? "monthly");
        const points = await wordstat.dynamics({
          phrase,
          period: parsedPeriod,
          fromDate,
          toDate,
          regions,
          devices: parseDevices(devices),
        });

        const lines = [
          `Фраза: «${phrase}»`,
          `Период: ${parsedPeriod}`,
          regions?.length ? `Регионы: ${regions.join(", ")}` : "Регионы: все",
          `Точек: ${points.length}`,
          "",
        ];
        if (points.length === 0) {
          lines.push("Данных нет.");
        } else {
          for (const point of points) {
            lines.push(
              `  ${point.date.slice(0, 10)}  ${formatCount(point.count).padStart(10)}  доля ${formatShare(point.share)}`,
            );
          }
        }
        return textResult(lines.join("\n"));
      }),
  );

  server.registerTool(
    "wordstat_regions",
    {
      title: "Wordstat: география",
      description:
        "Яндекс Wordstat: распределение спроса по регионам/городам за 30 дней. " +
        "affinityIndex > 100 — интерес выше среднего по стране.",
      inputSchema: {
        phrase: phraseSchema,
        regionMode: z
          .string()
          .optional()
          .describe("Группировка: regions (субъекты), cities (города) или all. По умолчанию regions."),
        devices: devicesSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Сколько строк вернуть (по умолчанию 20, сортировка по count)"),
      },
    },
    async ({ phrase, regionMode, devices, limit }) =>
      runTool("wordstat_regions", async () => {
        const mode = parseRegionMode(regionMode);
        const rows = await wordstat.regionsDistribution({
          phrase,
          regionMode: mode,
          devices: parseDevices(devices),
        });
        const topN = limit ?? 20;
        const byVolume = [...rows].sort((a, b) => b.count - a.count).slice(0, topN);
        const byAffinity = [...rows]
          .filter((row) => row.affinityIndex > 0)
          .sort((a, b) => b.affinityIndex - a.affinityIndex)
          .slice(0, Math.min(10, topN));

        const lines = [
          `Фраза: «${phrase}»`,
          `Режим: ${mode}`,
          `Всего строк: ${rows.length}. Показаны топ-${byVolume.length} по объёму.`,
          "",
          "По частотности:",
        ];
        if (byVolume.length === 0) {
          lines.push("  (пусто)");
        } else {
          for (const row of byVolume) {
            lines.push(
              `  ${formatCount(row.count).padStart(10)}  affinity ${row.affinityIndex.toFixed(1).padStart(6)}  ${row.regionName} (${row.regionId})  доля ${formatShare(row.share)}`,
            );
          }
        }

        lines.push("", "По индексу интереса (affinity):");
        for (const row of byAffinity) {
          lines.push(
            `  ${row.affinityIndex.toFixed(1).padStart(6)}  ${formatCount(row.count).padStart(10)}  ${row.regionName} (${row.regionId})`,
          );
        }
        return textResult(lines.join("\n"));
      }),
  );

  server.registerTool(
    "wordstat_find_region",
    {
      title: "Wordstat: найти регион",
      description:
        "Справочник регионов Яндекс Wordstat: поиск по названию (Москва, Россия) или ID. " +
        "Нужен, чтобы передать regions в wordstat_top / wordstat_dynamics. " +
        "Без query возвращает корневые регионы.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Название или ID региона, например «Москва» или «213»"),
        parentId: z.string().optional().describe("Показать дочерние регионы у этого ID"),
        limit: z.number().int().min(1).max(50).optional().describe("Максимум совпадений (по умолчанию 20)"),
      },
    },
    async ({ query, parentId, limit }) =>
      runTool("wordstat_find_region", async () => {
        if (parentId) {
          const node = await wordstat.getRegionChildren(parentId, 1);
          if (!node) {
            return textResult(`Регион с id=${parentId} не найден.`);
          }
          const children = node.children ?? [];
          const lines = [
            `${node.label} (${node.id}), дочерних: ${children.length}`,
            ...children.map((child) => `  ${child.id}  ${child.label}`),
          ];
          return textResult(lines.join("\n"));
        }

        if (!query?.trim()) {
          const roots = await wordstat.topLevelRegions();
          const lines = [
            `Корневые регионы (${roots.length}):`,
            ...roots.map((item) => `  ${item.id}  ${item.label}`),
          ];
          return textResult(lines.join("\n"));
        }

        const matches = await wordstat.findRegions(query, limit ?? 20);
        if (matches.length === 0) {
          return textResult(`Ничего не найдено по запросу «${query}».`);
        }
        const lines = [
          `Найдено: ${matches.length}`,
          ...matches.map(
            (item) =>
              `  ${item.id}  ${item.path}${item.childrenCount ? `  (дочерних: ${item.childrenCount})` : ""}`,
          ),
        ];
        return textResult(lines.join("\n"));
      }),
  );

  logger.info("Инструменты Wordstat зарегистрированы (4 шт.)");
}
