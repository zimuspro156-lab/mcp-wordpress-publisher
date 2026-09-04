import { logger } from "./logger.js";

const API_BASE = "https://searchapi.api.cloud.yandex.net/v2/wordstat";

export type WordstatDevice = "DEVICE_ALL" | "DEVICE_DESKTOP" | "DEVICE_PHONE" | "DEVICE_TABLET";
export type WordstatPeriod = "PERIOD_DAILY" | "PERIOD_WEEKLY" | "PERIOD_MONTHLY";
export type WordstatRegionMode = "REGION_ALL" | "REGION_CITIES" | "REGION_REGIONS";

export interface WordstatConfig {
  apiKey: string;
  folderId: string;
}

export interface PhraseInfo {
  phrase: string;
  count: number;
}

export interface TopRequestsResult {
  totalCount: number;
  results: PhraseInfo[];
  associations: PhraseInfo[];
}

export interface DynamicsPoint {
  date: string;
  count: number;
  share: number;
}

export interface RegionStat {
  regionId: string;
  regionName: string;
  count: number;
  share: number;
  affinityIndex: number;
}

export interface RegionNode {
  id: string;
  label: string;
  children?: RegionNode[];
}

/**
 * Ошибка запроса к Yandex Wordstat (Search API v2).
 */
export class WordstatApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "WordstatApiError";
  }
}

const DEVICE_ALIASES: Record<string, WordstatDevice> = {
  all: "DEVICE_ALL",
  desktop: "DEVICE_DESKTOP",
  phone: "DEVICE_PHONE",
  tablet: "DEVICE_TABLET",
  device_all: "DEVICE_ALL",
  device_desktop: "DEVICE_DESKTOP",
  device_phone: "DEVICE_PHONE",
  device_tablet: "DEVICE_TABLET",
};

const PERIOD_ALIASES: Record<string, WordstatPeriod> = {
  daily: "PERIOD_DAILY",
  weekly: "PERIOD_WEEKLY",
  monthly: "PERIOD_MONTHLY",
  day: "PERIOD_DAILY",
  week: "PERIOD_WEEKLY",
  month: "PERIOD_MONTHLY",
  period_daily: "PERIOD_DAILY",
  period_weekly: "PERIOD_WEEKLY",
  period_monthly: "PERIOD_MONTHLY",
};

const REGION_MODE_ALIASES: Record<string, WordstatRegionMode> = {
  all: "REGION_ALL",
  cities: "REGION_CITIES",
  regions: "REGION_REGIONS",
  city: "REGION_CITIES",
  region: "REGION_REGIONS",
  region_all: "REGION_ALL",
  region_cities: "REGION_CITIES",
  region_regions: "REGION_REGIONS",
};

export function parseDevices(values: string[] | undefined): WordstatDevice[] | undefined {
  if (!values?.length) return undefined;
  return values.map((value) => {
    const mapped = DEVICE_ALIASES[value.trim().toLowerCase()];
    if (!mapped) {
      throw new Error(
        `Неизвестный тип устройства "${value}". Допустимо: all, desktop, phone, tablet.`,
      );
    }
    return mapped;
  });
}

export function parsePeriod(value: string): WordstatPeriod {
  const mapped = PERIOD_ALIASES[value.trim().toLowerCase()];
  if (!mapped) {
    throw new Error(`Неизвестный период "${value}". Допустимо: daily, weekly, monthly.`);
  }
  return mapped;
}

export function parseRegionMode(value: string | undefined): WordstatRegionMode {
  if (!value) return "REGION_REGIONS";
  const mapped = REGION_MODE_ALIASES[value.trim().toLowerCase()];
  if (!mapped) {
    throw new Error(`Неизвестный режим регионов "${value}". Допустимо: all, cities, regions.`);
  }
  return mapped;
}

/**
 * Читает API-ключ и folder ID из окружения. Возвращает null, если Wordstat
 * не настроен — тогда инструменты просто не регистрируются.
 */
/**
 * В n8n в заголовок Authorization кладут целиком `Api-Key AQVN...`.
 * В .env нужен только ключ: префикс добавляет клиент. Срезаем его, если вставили как в n8n.
 */
function normalizeApiKey(raw: string): string {
  return raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^(api-key|bearer)\s+/i, "")
    .trim();
}

export function loadWordstatConfig(): WordstatConfig | null {
  const apiKey = normalizeApiKey(
    process.env.YANDEX_WORDSTAT_API_KEY ??
      process.env.YANDEX_API_KEY ??
      process.env.YANDEX_SEARCH_API_KEY ??
      process.env.WORDSTAT_API_KEY ??
      "",
  );

  const folderId = (
    process.env.YANDEX_WORDSTAT_FOLDER_ID ??
    process.env.YANDEX_FOLDER_ID ??
    process.env.WORDSTAT_FOLDER_ID ??
    ""
  ).trim();

  if (!apiKey && !folderId) {
    return null;
  }
  if (!apiKey || !folderId) {
    const missing = [
      !apiKey ? "YANDEX_API_KEY" : null,
      !folderId ? "YANDEX_FOLDER_ID" : null,
    ].filter(Boolean);
    logger.warn(
      `Wordstat настроен частично — не хватает ${missing.join(", ")}. Инструменты Wordstat отключены.`,
    );
    return null;
  }

  return { apiKey, folderId };
}

function toCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toShare(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toIsoDate(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as { seconds?: string | number };
    if (record.seconds !== undefined) {
      const seconds = Number(record.seconds);
      if (Number.isFinite(seconds)) {
        return new Date(seconds * 1000).toISOString();
      }
    }
  }
  return String(value ?? "");
}

function lastDayOfMonthUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59));
}

function lastDayOfWeekUtc(date: Date): Date {
  // Неделя Wordstat: пн–вс, toDate должен быть воскресеньем.
  const day = date.getUTCDay();
  const daysUntilSunday = (7 - day) % 7;
  const end = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + daysUntilSunday, 23, 59, 59),
  );
  return end;
}

function startOfMonthUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0));
}

function addMonthsUtc(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1, 0, 0, 0));
}

export function resolveDynamicsRange(
  period: WordstatPeriod,
  fromDate?: string,
  toDate?: string,
): { fromDate: string; toDate: string } {
  const now = new Date();
  let from: Date;
  let to: Date;

  if (fromDate) {
    from = new Date(fromDate);
  } else if (period === "PERIOD_DAILY") {
    from = new Date(now);
    from.setUTCDate(from.getUTCDate() - 30);
    from.setUTCHours(0, 0, 0, 0);
  } else if (period === "PERIOD_WEEKLY") {
    from = new Date(now);
    from.setUTCDate(from.getUTCDate() - 7 * 12);
    from.setUTCHours(0, 0, 0, 0);
  } else {
    from = addMonthsUtc(startOfMonthUtc(now), -11);
  }

  if (toDate) {
    to = new Date(toDate);
  } else {
    to = new Date(now);
  }

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("Некорректная дата fromDate/toDate. Используйте ISO 8601, например 2026-01-01.");
  }

  if (period === "PERIOD_MONTHLY") {
    from = startOfMonthUtc(from);
    to = lastDayOfMonthUtc(to);
  } else if (period === "PERIOD_WEEKLY") {
    to = lastDayOfWeekUtc(to);
  } else {
    to.setUTCHours(23, 59, 59, 0);
  }

  return {
    fromDate: from.toISOString().replace(/\.\d{3}Z$/, "Z"),
    toDate: to.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

function flattenRegions(
  nodes: RegionNode[],
  ancestors: string[] = [],
): Array<{ id: string; label: string; path: string; childrenCount: number }> {
  const out: Array<{ id: string; label: string; path: string; childrenCount: number }> = [];
  for (const node of nodes) {
    const path = [...ancestors, node.label].join(" / ");
    out.push({
      id: node.id,
      label: node.label,
      path,
      childrenCount: node.children?.length ?? 0,
    });
    if (node.children?.length) {
      out.push(...flattenRegions(node.children, [...ancestors, node.label]));
    }
  }
  return out;
}

function findNode(nodes: RegionNode[], id: string): RegionNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children?.length) {
      const found = findNode(node.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

function clipTree(nodes: RegionNode[], depth: number): RegionNode[] {
  if (depth <= 0) {
    return nodes.map((node) => ({ id: node.id, label: node.label }));
  }
  return nodes.map((node) => ({
    id: node.id,
    label: node.label,
    children: node.children?.length ? clipTree(node.children, depth - 1) : undefined,
  }));
}

/**
 * Клиент Yandex Cloud Search API v2 → Wordstat.
 * Документация: https://aistudio.yandex.ru/ru/docs/search-api/concepts/wordstat
 */
export class WordstatClient {
  private readonly apiKey: string;
  private readonly folderId: string;
  private regionsTree: RegionNode[] | null = null;
  private regionsIndex: Map<string, { label: string; path: string }> | null = null;

  constructor(config: WordstatConfig) {
    this.apiKey = config.apiKey;
    this.folderId = config.folderId;
    logger.debug("WordstatClient инициализирован", { folderId: this.folderId });
  }

  async topRequests(input: {
    phrase: string;
    numPhrases?: number;
    regions?: string[];
    devices?: WordstatDevice[];
  }): Promise<TopRequestsResult> {
    const body = await this.post("topRequests", {
      phrase: input.phrase,
      numPhrases: input.numPhrases ?? 20,
      regions: input.regions,
      devices: input.devices,
    });

    const results = Array.isArray(body.results) ? body.results : [];
    const associations = Array.isArray(body.associations) ? body.associations : [];

    return {
      totalCount: toCount(body.totalCount),
      results: results.map((item: { phrase?: string; count?: unknown }) => ({
        phrase: String(item.phrase ?? ""),
        count: toCount(item.count),
      })),
      associations: associations.map((item: { phrase?: string; count?: unknown }) => ({
        phrase: String(item.phrase ?? ""),
        count: toCount(item.count),
      })),
    };
  }

  async dynamics(input: {
    phrase: string;
    period: WordstatPeriod;
    fromDate?: string;
    toDate?: string;
    regions?: string[];
    devices?: WordstatDevice[];
  }): Promise<DynamicsPoint[]> {
    const range = resolveDynamicsRange(input.period, input.fromDate, input.toDate);
    const body = await this.post("dynamics", {
      phrase: input.phrase,
      period: input.period,
      fromDate: range.fromDate,
      toDate: range.toDate,
      regions: input.regions,
      devices: input.devices,
    });

    const results = Array.isArray(body.results) ? body.results : [];
    return results.map((item: { date?: unknown; count?: unknown; share?: unknown }) => ({
      date: toIsoDate(item.date),
      count: toCount(item.count),
      share: toShare(item.share),
    }));
  }

  async regionsDistribution(input: {
    phrase: string;
    regionMode?: WordstatRegionMode;
    devices?: WordstatDevice[];
  }): Promise<RegionStat[]> {
    const body = await this.post("regions", {
      phrase: input.phrase,
      region: input.regionMode ?? "REGION_REGIONS",
      devices: input.devices,
    });

    const names = await this.ensureRegionIndex();
    const results = Array.isArray(body.results) ? body.results : [];
    return results.map(
      (item: {
        region?: string;
        count?: unknown;
        share?: unknown;
        affinityIndex?: unknown;
      }) => {
        const regionId = String(item.region ?? "");
        return {
          regionId,
          regionName: names.get(regionId)?.label ?? regionId,
          count: toCount(item.count),
          share: toShare(item.share),
          affinityIndex: toShare(item.affinityIndex),
        };
      },
    );
  }

  async getRegionsTree(): Promise<RegionNode[]> {
    if (this.regionsTree) return this.regionsTree;
    const body = await this.post("getRegionsTree", {});
    const regions = Array.isArray(body.regions) ? (body.regions as RegionNode[]) : [];
    this.regionsTree = regions;
    return regions;
  }

  async findRegions(query: string, limit = 20): Promise<Array<{ id: string; label: string; path: string; childrenCount: number }>> {
    const tree = await this.getRegionsTree();
    const needle = query.trim().toLowerCase();
    const matches = flattenRegions(tree).filter(
      (item) =>
        item.label.toLowerCase().includes(needle) ||
        item.id === query.trim() ||
        item.path.toLowerCase().includes(needle),
    );
    matches.sort((a, b) => a.path.length - b.path.length || a.label.localeCompare(b.label, "ru"));
    return matches.slice(0, limit);
  }

  async getRegionChildren(regionId: string, maxDepth = 1): Promise<RegionNode | undefined> {
    const tree = await this.getRegionsTree();
    const node = findNode(tree, regionId);
    if (!node) return undefined;
    return {
      id: node.id,
      label: node.label,
      children: node.children?.length ? clipTree(node.children, Math.max(0, maxDepth - 1)) : undefined,
    };
  }

  async topLevelRegions(): Promise<RegionNode[]> {
    const tree = await this.getRegionsTree();
    return clipTree(tree, 0);
  }

  private async ensureRegionIndex(): Promise<Map<string, { label: string; path: string }>> {
    if (this.regionsIndex) return this.regionsIndex;
    const tree = await this.getRegionsTree();
    const index = new Map<string, { label: string; path: string }>();
    for (const item of flattenRegions(tree)) {
      index.set(item.id, { label: item.label, path: item.path });
    }
    this.regionsIndex = index;
    return index;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { ...body, folderId: this.folderId };
    for (const key of Object.keys(payload)) {
      if (payload[key] === undefined) {
        delete payload[key];
      }
    }

    const url = `${API_BASE}/${path}`;
    logger.debug(`Wordstat ${path}`, { keys: Object.keys(payload) });
    const started = Date.now();

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${this.apiKey}`,
        "Content-Type": "application/json",
        "Accept-Language": "ru",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });

    const rawText = await response.text();
    let parsed: unknown = rawText;
    try {
      parsed = rawText ? JSON.parse(rawText) : {};
    } catch {
      parsed = { raw: rawText };
    }

    const elapsed = Date.now() - started;
    logger.debug(`Wordstat ${path} → HTTP ${response.status} за ${elapsed} мс`);

    if (!response.ok) {
      const message =
        (parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : rawText) || `HTTP ${response.status}`;
      throw new WordstatApiError(message, response.status, parsed);
    }

    return (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  }
}
