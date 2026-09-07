import { logger } from "./logger.js";
import type { AppConfig } from "./config.js";
import {
  decodeBase64Image,
  detectImageSourceKind,
  downloadImage,
  stripLeadingTitleHeading,
} from "./media.js";
import {
  formatTerm,
  matchTerms,
  resolveTerm,
  type TaxonomyRef,
  type TaxonomyTerm,
} from "./taxonomy.js";

/**
 * Статусы публикации, поддерживаемые WordPress REST API.
 */
export type PostStatus = "publish" | "draft" | "pending" | "private" | "future";

export interface CreatePostInput {
  title: string;
  content: string;
  status?: PostStatus;
  excerpt?: string;
  slug?: string;
  categories?: number[];
  tags?: number[];
  featuredMediaId?: number;
  /** Дата в формате ISO 8601 для отложенной публикации (status=future). */
  date?: string;
}

export interface UpdatePostInput {
  id: number;
  title?: string;
  content?: string;
  status?: PostStatus;
  excerpt?: string;
  slug?: string;
  categories?: number[];
  tags?: number[];
  featuredMediaId?: number;
}

export interface ListPostsInput {
  status?: PostStatus;
  perPage?: number;
  page?: number;
  search?: string;
}

export interface UploadMediaInput {
  source: string;
  filename?: string;
  title?: string;
  altText?: string;
  caption?: string;
}

export interface WpPost {
  id: number;
  link: string;
  status: string;
  title: { rendered: string };
  [key: string]: unknown;
}

export interface WpMedia {
  id: number;
  source_url: string;
  link: string;
  mime_type: string;
  alt_text?: string;
  title?: { rendered: string };
  caption?: { rendered: string };
}

export interface ResolvedTaxonomy {
  ids: number[];
  terms: TaxonomyTerm[];
  created: TaxonomyTerm[];
  notes: string[];
}

/**
 * Ошибка запроса к WordPress с сохранённым HTTP-статусом и телом ответа.
 */
export class WordPressApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "WordPressApiError";
  }
}

/**
 * Тонкий клиент над WordPress REST API (/wp-json/wp/v2).
 * Аутентификация — Basic Auth с Application Password.
 */
export class WordPressClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(config: AppConfig) {
    this.baseUrl = `${config.wordpressUrl}/wp-json/wp/v2`;
    const token = Buffer.from(`${config.username}:${config.appPassword}`).toString("base64");
    this.authHeader = `Basic ${token}`;
    logger.debug("WordPressClient инициализирован", { baseUrl: this.baseUrl });
  }

  /**
   * Общий низкоуровневый запрос с логированием и разбором ошибок.
   */
  private async request<T>(
    method: string,
    endpoint: string,
    options: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
      "User-Agent": "mcp-wordpress-publisher/1.2.0",
    };

    let bodyString: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyString = JSON.stringify(options.body);
    }

    logger.info(`WP -> ${method} ${url.pathname}${url.search}`);
    logger.debug("Тело запроса", options.body ?? null);

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(url, { method, headers, body: bodyString });
    } catch (error) {
      logger.error("Сетевая ошибка при запросе к WordPress", error);
      throw new WordPressApiError(
        `Сетевая ошибка при обращении к WordPress: ${String(error)}`,
        0,
        null,
      );
    }

    const durationMs = Date.now() - startedAt;
    const rawText = await response.text();
    let parsed: unknown = null;
    if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = rawText;
      }
    }

    logger.info(`WP <- ${response.status} ${method} ${url.pathname} (${durationMs} ms)`);

    if (!response.ok) {
      logger.error("WordPress вернул ошибку", { status: response.status, body: parsed });
      const wpMessage =
        typeof parsed === "object" && parsed !== null && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : `HTTP ${response.status}`;
      throw new WordPressApiError(
        `WordPress API error (${response.status}): ${wpMessage}`,
        response.status,
        parsed,
      );
    }

    logger.debug("Ответ WordPress", parsed);
    return parsed as T;
  }

  /**
   * Собирает все страницы списка (категории, метки и т.п.).
   */
  private async requestPaged<T>(endpoint: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= 50; page++) {
      try {
        const batch = await this.request<T[]>("GET", endpoint, {
          query: { per_page: 100, page },
        });
        if (!Array.isArray(batch) || batch.length === 0) break;
        items.push(...batch);
        if (batch.length < 100) break;
      } catch (error) {
        if (error instanceof WordPressApiError && (error.status === 400 || error.status === 404)) {
          break;
        }
        throw error;
      }
    }
    return items;
  }

  /**
   * Проверка соединения и аутентификации: /wp/v2/users/me.
   */
  async verifyConnection(): Promise<{ id: number; name: string; slug: string }> {
    logger.info("Проверка соединения с WordPress");
    return this.request("GET", "/users/me", { query: { context: "edit" } });
  }

  async createPost(input: CreatePostInput): Promise<WpPost> {
    const body: Record<string, unknown> = {
      title: input.title,
      content: stripLeadingTitleHeading(input.content),
      status: input.status ?? "draft",
    };
    if (input.excerpt !== undefined) body.excerpt = input.excerpt;
    if (input.slug !== undefined) body.slug = input.slug;
    if (input.categories !== undefined) body.categories = input.categories;
    if (input.tags !== undefined) body.tags = input.tags;
    if (input.featuredMediaId !== undefined) body.featured_media = input.featuredMediaId;
    if (input.date !== undefined) body.date = input.date;

    logger.info(`Создание поста: "${input.title}" (status=${body.status})`);
    return this.request<WpPost>("POST", "/posts", { body });
  }

  async updatePost(input: UpdatePostInput): Promise<WpPost> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.content !== undefined) body.content = stripLeadingTitleHeading(input.content);
    if (input.status !== undefined) body.status = input.status;
    if (input.excerpt !== undefined) body.excerpt = input.excerpt;
    if (input.slug !== undefined) body.slug = input.slug;
    if (input.categories !== undefined) body.categories = input.categories;
    if (input.tags !== undefined) body.tags = input.tags;
    if (input.featuredMediaId !== undefined) body.featured_media = input.featuredMediaId;

    logger.info(`Обновление поста id=${input.id}`);
    return this.request<WpPost>("POST", `/posts/${input.id}`, { body });
  }

  async getPost(id: number): Promise<WpPost> {
    logger.info(`Получение поста id=${id}`);
    return this.request<WpPost>("GET", `/posts/${id}`, { query: { context: "edit" } });
  }

  async listPosts(input: ListPostsInput = {}): Promise<WpPost[]> {
    logger.info("Список постов", input);
    return this.request<WpPost[]>("GET", "/posts", {
      query: {
        status: input.status,
        per_page: input.perPage ?? 10,
        page: input.page ?? 1,
        search: input.search,
        context: "edit",
      },
    });
  }

  async deletePost(id: number, force = false): Promise<unknown> {
    logger.info(`Удаление поста id=${id} (force=${force})`);
    return this.request("DELETE", `/posts/${id}`, { query: { force: force ? "true" : "false" } });
  }

  async listCategories(): Promise<TaxonomyTerm[]> {
    logger.info("Список категорий");
    return this.requestPaged<TaxonomyTerm>("/categories");
  }

  async createCategory(name: string, description?: string): Promise<{ id: number; name: string }> {
    logger.info(`Создание категории: "${name}"`);
    return this.request("POST", "/categories", { body: { name, description } });
  }

  async listTags(): Promise<TaxonomyTerm[]> {
    logger.info("Список меток");
    return this.requestPaged<TaxonomyTerm>("/tags");
  }

  async createTag(name: string, description?: string): Promise<{ id: number; name: string }> {
    logger.info(`Создание метки: "${name}"`);
    return this.request("POST", "/tags", { body: { name, description } });
  }

  async getMedia(id: number): Promise<WpMedia> {
    logger.info(`Получение медиа id=${id}`);
    return this.request<WpMedia>("GET", `/media/${id}`, { query: { context: "edit" } });
  }

  /**
   * Загружает изображение в медиабиблиотеку WordPress.
   * source — http(s) URL или base64 / data URI. Картинки сервер сам не рисует.
   */
  async uploadMedia(input: UploadMediaInput): Promise<WpMedia> {
    const kind = detectImageSourceKind(input.source);
    logger.info(`Подготовка изображения (${kind})`, {
      filename: input.filename,
      sourceChars: input.source.length,
    });

    const prepared =
      kind === "url"
        ? await downloadImage(input.source, input.filename)
        : decodeBase64Image(input.source, input.filename);

    logger.info(`Загрузка медиа в WordPress: ${prepared.filename} (${prepared.mimeType}, ${prepared.buffer.length} байт)`);

    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(prepared.buffer)], { type: prepared.mimeType }),
      prepared.filename,
    );
    form.append("title", input.title ?? prepared.filename);
    if (input.altText) form.append("alt_text", input.altText);
    if (input.caption) form.append("caption", input.caption);

    const url = `${this.baseUrl}/media`;
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "User-Agent": "mcp-wordpress-publisher/1.2.0",
        },
        body: form,
      });
    } catch (error) {
      logger.error("Сетевая ошибка при загрузке медиа", error);
      throw new WordPressApiError(
        `Сетевая ошибка при загрузке медиа: ${String(error)}`,
        0,
        null,
      );
    }

    const rawText = await response.text();
    let parsed: unknown = null;
    if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = rawText;
      }
    }

    logger.info(`WP <- ${response.status} POST /media (${Date.now() - startedAt} ms)`);
    if (!response.ok) {
      const wpMessage =
        typeof parsed === "object" && parsed !== null && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : `HTTP ${response.status}`;
      throw new WordPressApiError(
        `WordPress API error (${response.status}): ${wpMessage}`,
        response.status,
        parsed,
      );
    }

    return parsed as WpMedia;
  }

  async resolveCategories(refs: TaxonomyRef[], createIfMissing = true): Promise<ResolvedTaxonomy> {
    return this.resolveTaxonomy("category", refs, createIfMissing);
  }

  async resolveTags(refs: TaxonomyRef[], createIfMissing = true): Promise<ResolvedTaxonomy> {
    return this.resolveTaxonomy("tag", refs, createIfMissing);
  }

  /**
   * Подбирает существующие категории и метки по заголовку/тексту статьи.
   */
  async matchTaxonomyForArticle(
    text: string,
    options: { categoryLimit?: number; tagLimit?: number } = {},
  ): Promise<{ categories: TaxonomyTerm[]; tags: TaxonomyTerm[] }> {
    const [categories, tags] = await Promise.all([this.listCategories(), this.listTags()]);
    return {
      categories: matchTerms(categories, text, { limit: options.categoryLimit ?? 2, minScore: 3 }),
      tags: matchTerms(tags, text, { limit: options.tagLimit ?? 5, minScore: 3 }),
    };
  }

  private async resolveTaxonomy(
    kind: "category" | "tag",
    refs: TaxonomyRef[],
    createIfMissing: boolean,
  ): Promise<ResolvedTaxonomy> {
    const existing = kind === "category" ? await this.listCategories() : await this.listTags();
    const ids: number[] = [];
    const terms: TaxonomyTerm[] = [];
    const created: TaxonomyTerm[] = [];
    const notes: string[] = [];
    const seen = new Set<number>();

    for (const ref of refs) {
      const found = resolveTerm(existing, ref);
      if (found) {
        if (!seen.has(found.id)) {
          seen.add(found.id);
          ids.push(found.id);
          terms.push(found);
        }
        continue;
      }

      const label = String(ref);
      if (!createIfMissing || typeof ref === "number") {
        notes.push(`${kind === "category" ? "Категория" : "Метка"} не найдена: ${label}`);
        continue;
      }

      const createdTerm =
        kind === "category" ? await this.createCategory(ref) : await this.createTag(ref);
      const term: TaxonomyTerm = {
        id: createdTerm.id,
        name: createdTerm.name,
        slug: "",
      };
      existing.push(term);
      seen.add(term.id);
      ids.push(term.id);
      terms.push(term);
      created.push(term);
      notes.push(`Создана ${kind === "category" ? "категория" : "метка"} ${formatTerm(term)}`);
    }

    return { ids, terms, created, notes };
  }
}
