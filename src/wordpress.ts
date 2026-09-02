import { logger } from "./logger.js";
import type { AppConfig } from "./config.js";

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

export interface WpPost {
  id: number;
  link: string;
  status: string;
  title: { rendered: string };
  [key: string]: unknown;
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
   * Проверка соединения и аутентификации: /wp/v2/users/me.
   */
  async verifyConnection(): Promise<{ id: number; name: string; slug: string }> {
    logger.info("Проверка соединения с WordPress");
    return this.request("GET", "/users/me", { query: { context: "edit" } });
  }

  async createPost(input: CreatePostInput): Promise<WpPost> {
    const body: Record<string, unknown> = {
      title: input.title,
      content: input.content,
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
    if (input.content !== undefined) body.content = input.content;
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

  async listCategories(): Promise<Array<{ id: number; name: string; slug: string }>> {
    logger.info("Список категорий");
    return this.request("GET", "/categories", { query: { per_page: 100 } });
  }

  async createCategory(name: string, description?: string): Promise<{ id: number; name: string }> {
    logger.info(`Создание категории: "${name}"`);
    return this.request("POST", "/categories", { body: { name, description } });
  }

  async listTags(): Promise<Array<{ id: number; name: string; slug: string }>> {
    logger.info("Список меток");
    return this.request("GET", "/tags", { query: { per_page: 100 } });
  }

  async createTag(name: string, description?: string): Promise<{ id: number; name: string }> {
    logger.info(`Создание метки: "${name}"`);
    return this.request("POST", "/tags", { body: { name, description } });
  }
}
