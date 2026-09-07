import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "./logger.js";
import { injectMediaIntoContent } from "./media.js";
import { formatTerm, type TaxonomyRef } from "./taxonomy.js";
import {
  WordPressClient,
  WordPressApiError,
  type WpMedia,
  type WpPost,
} from "./wordpress.js";

const postStatusSchema = z
  .enum(["publish", "draft", "pending", "private", "future"])
  .describe("Статус публикации в WordPress");

const taxonomyRefSchema = z
  .union([z.number().int(), z.string().min(1)])
  .describe("ID или название уже существующей рубрики/метки на сайте");

const imageInputSchema = z.object({
  source: z
    .string()
    .min(1)
    .describe(
      "Готовое изображение: http(s) URL или base64 / data URI. Этот MCP картинки не генерирует — их даёт пользователь или отдельный image-MCP.",
    ),
  filename: z.string().optional().describe("Имя файла, например hero.jpg"),
  altText: z.string().optional().describe("Alt-текст"),
  title: z.string().optional().describe("Заголовок в медиабиблиотеке"),
  caption: z.string().optional().describe("Подпись под картинкой"),
  featured: z.boolean().optional().describe("true — сделать обложкой записи"),
});

/**
 * Единый формат текстового ответа инструмента.
 */
function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    isError,
  };
}

/**
 * Оборачивает выполнение инструмента: логирует старт/финиш и превращает
 * исключения в аккуратный текстовый ответ вместо падения сервера.
 */
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
    if (error instanceof WordPressApiError) {
      logger.error(`Инструмент ${name}: ошибка WordPress`, {
        status: error.status,
        body: error.body,
      });
      return textResult(
        `Ошибка WordPress (HTTP ${error.status}): ${error.message}\n` +
          `Тело ответа: ${JSON.stringify(error.body)}`,
        true,
      );
    }
    logger.error(`Инструмент ${name}: непредвиденная ошибка`, error);
    return textResult(`Непредвиденная ошибка: ${String(error)}`, true);
  }
}

function postRawContent(post: WpPost): string {
  const content = post.content;
  if (content && typeof content === "object" && "raw" in content) {
    return String((content as { raw: unknown }).raw ?? "");
  }
  if (content && typeof content === "object" && "rendered" in content) {
    return String((content as { rendered: unknown }).rendered ?? "");
  }
  return "";
}

function mediaLine(media: WpMedia): string {
  const alt = media.alt_text ? `, alt="${media.alt_text}"` : "";
  return `id=${media.id} ${media.source_url}${alt}`;
}

async function collectMedia(
  wp: WordPressClient,
  images?: Array<z.infer<typeof imageInputSchema>>,
  mediaIds?: number[],
): Promise<{ items: WpMedia[]; featuredId?: number }> {
  const items: WpMedia[] = [];
  let featuredId: number | undefined;

  for (const image of images ?? []) {
    const uploaded = await wp.uploadMedia(image);
    items.push(uploaded);
    if (image.featured && featuredId === undefined) {
      featuredId = uploaded.id;
    }
  }

  for (const id of mediaIds ?? []) {
    if (items.some((item) => item.id === id)) continue;
    items.push(await wp.getMedia(id));
  }

  return { items, featuredId };
}

async function resolvePostTaxonomy(
  wp: WordPressClient,
  text: string,
  categories?: TaxonomyRef[],
  tags?: TaxonomyRef[],
): Promise<{
  categoryIds?: number[];
  tagIds?: number[];
  lines: string[];
}> {
  const lines: string[] = [];

  if (categories && categories.length > 0) {
    const resolved = await wp.resolveCategories(categories, false);
    lines.push(
      resolved.terms.length > 0
        ? `Категории: ${resolved.terms.map(formatTerm).join(", ")}`
        : "Категории: не найдены среди существующих на сайте",
    );
    lines.push(...resolved.notes);
    return {
      categoryIds: resolved.ids.length > 0 ? resolved.ids : undefined,
      tagIds: await resolveTagIds(wp, tags, text, lines),
      lines,
    };
  }

  const matched = await wp.matchTaxonomyForArticle(text);
  if (matched.categories.length > 0) {
    lines.push(
      `Категории (подобраны автоматически): ${matched.categories.map(formatTerm).join(", ")}`,
    );
  } else {
    lines.push("Категории: подходящих среди существующих не нашлось — WordPress поставит «Без рубрики».");
  }

  const tagIds = await resolveTagIds(wp, tags, text, lines, matched.tags);
  return {
    categoryIds: matched.categories.length > 0 ? matched.categories.map((item) => item.id) : undefined,
    tagIds,
    lines,
  };
}

async function resolveTagIds(
  wp: WordPressClient,
  tags: TaxonomyRef[] | undefined,
  text: string,
  lines: string[],
  alreadyMatched?: Array<{ id: number; name: string }>,
): Promise<number[] | undefined> {
  if (tags && tags.length > 0) {
    const resolved = await wp.resolveTags(tags, false);
    lines.push(
      resolved.terms.length > 0
        ? `Метки: ${resolved.terms.map(formatTerm).join(", ")}`
        : "Метки: не найдены среди существующих на сайте",
    );
    lines.push(...resolved.notes);
    return resolved.ids.length > 0 ? resolved.ids : undefined;
  }

  if (alreadyMatched) {
    if (alreadyMatched.length > 0) {
      lines.push(`Метки (подобраны автоматически): ${alreadyMatched.map(formatTerm).join(", ")}`);
    } else {
      lines.push("Метки: подходящих среди существующих не нашлось.");
    }
    return alreadyMatched.length > 0 ? alreadyMatched.map((item) => item.id) : undefined;
  }

  const matched = await wp.matchTaxonomyForArticle(text);
  if (matched.tags.length > 0) {
    lines.push(`Метки (подобраны автоматически): ${matched.tags.map(formatTerm).join(", ")}`);
  } else {
    lines.push("Метки: подходящих среди существующих не нашлось.");
  }
  return matched.tags.length > 0 ? matched.tags.map((item) => item.id) : undefined;
}

/**
 * Регистрирует все инструменты для работы с WordPress.
 */
export function registerTools(server: McpServer, wp: WordPressClient): void {
  server.registerTool(
    "wp_verify_connection",
    {
      title: "Проверить подключение к WordPress",
      description:
        "Проверяет URL, логин и пароль приложения, обращаясь к /wp/v2/users/me. " +
        "Используйте это в первую очередь, чтобы убедиться, что доступ настроен верно.",
      inputSchema: {},
    },
    async () =>
      runTool("wp_verify_connection", async () => {
        const me = await wp.verifyConnection();
        return textResult(
          `Подключение успешно. Авторизован как: ${me.name} (id=${me.id}, slug=${me.slug}).`,
        );
      }),
  );

  server.registerTool(
    "wp_upload_media",
    {
      title: "Загрузить изображение в WordPress",
      description:
        "Кладёт готовое изображение в медиабиблиотеку WordPress и возвращает id + URL. " +
        "Принимает http(s) URL или base64 / data URI. Картинки НЕ генерирует — их нужно получить " +
        "у пользователя или у отдельного image-MCP, затем передать сюда. " +
        "Полученный id используйте в wp_create_post (mediaIds / featuredMediaId) или вставьте URL в HTML статьи.",
      inputSchema: {
        source: z
          .string()
          .min(1)
          .describe("http(s) URL или base64 / data URI изображения"),
        filename: z.string().optional().describe("Имя файла, например article-cover.jpg"),
        title: z.string().optional(),
        altText: z.string().optional(),
        caption: z.string().optional(),
      },
    },
    async (args) =>
      runTool("wp_upload_media", async () => {
        const media = await wp.uploadMedia(args);
        return textResult(
          `Изображение загружено.\n${mediaLine(media)}\n` +
            `Дальше: передайте id=${media.id} в wp_create_post (mediaIds или featuredMediaId) ` +
            `либо вставьте URL в HTML статьи.`,
        );
      }),
  );

  server.registerTool(
    "wp_create_post",
    {
      title: "Создать/опубликовать статью",
      description:
        "Создаёт статью в WordPress. По умолчанию status=draft; для публикации укажите status='publish'. " +
        "Контент — HTML без ведущего H1 (заголовок уже рисует тема сайта). " +
        "Сценарий «напиши статью и опубликуй»: 1) если пользователь просит ключи/Wordstat — сначала wordstat_top; " +
        "2) напиши HTML; 3) прими готовые картинки (URL/base64 от пользователя или image-MCP) через images[] " +
        "или заранее через wp_upload_media + mediaIds — этот MCP сам картинки не рисует; " +
        "4) категории и метки подставляются из уже существующих на сайте (по названию или автоматически по теме). " +
        "Первая картинка становится обложкой, остальные вставляются в текст, если их URL там ещё нет.",
      inputSchema: {
        title: z.string().min(1).describe("Заголовок статьи"),
        content: z.string().min(1).describe("Содержимое статьи (HTML или текст, без ведущего H1)"),
        status: postStatusSchema.optional(),
        excerpt: z.string().optional().describe("Краткое описание (анонс)"),
        slug: z.string().optional().describe("URL-слаг статьи"),
        categories: z
          .array(taxonomyRefSchema)
          .optional()
          .describe("ID или названия категорий с сайта. Если не указать — подберутся автоматически."),
        tags: z
          .array(taxonomyRefSchema)
          .optional()
          .describe("ID или названия меток с сайта. Если не указать — подберутся автоматически."),
        featuredMediaId: z.number().int().optional().describe("ID обложки, если картинка уже в медиабиблиотеке"),
        mediaIds: z
          .array(z.number().int())
          .optional()
          .describe("ID уже загруженных изображений (после wp_upload_media)"),
        images: z
          .array(imageInputSchema)
          .optional()
          .describe("Готовые картинки (URL или base64) — загрузятся и привяжутся к статье"),
        date: z
          .string()
          .optional()
          .describe("Дата в ISO 8601 для отложенной публикации (при status=future)"),
      },
    },
    async (args) =>
      runTool("wp_create_post", async () => {
        const media = await collectMedia(wp, args.images, args.mediaIds);
        const featuredMediaId = args.featuredMediaId ?? media.featuredId ?? media.items[0]?.id;
        const content =
          media.items.length > 0
            ? injectMediaIntoContent(
                args.content,
                media.items.map((item) => ({
                  id: item.id,
                  sourceUrl: item.source_url,
                  altText: item.alt_text,
                  caption: item.caption?.rendered,
                })),
              )
            : args.content;

        const taxonomy = await resolvePostTaxonomy(
          wp,
          `${args.title}\n${args.excerpt ?? ""}\n${args.content}`,
          args.categories,
          args.tags,
        );

        const post = await wp.createPost({
          title: args.title,
          content,
          status: args.status,
          excerpt: args.excerpt,
          slug: args.slug,
          categories: taxonomy.categoryIds,
          tags: taxonomy.tagIds,
          featuredMediaId,
          date: args.date,
        });

        const extra = [
          `Статья создана. id=${post.id}, status=${post.status}, ссылка: ${post.link}`,
          featuredMediaId ? `Обложка: media id=${featuredMediaId}` : "Обложка: не задана",
        ];
        if (media.items.length > 0) {
          extra.push(`Изображения:\n${media.items.map((item) => `  - ${mediaLine(item)}`).join("\n")}`);
        }
        extra.push(...taxonomy.lines);
        return textResult(extra.join("\n"));
      }),
  );

  server.registerTool(
    "wp_update_post",
    {
      title: "Обновить статью",
      description:
        "Обновляет существующую статью по её id. Передавайте только те поля, " +
        "которые нужно изменить. Можно менять статус (например, draft -> publish), " +
        "добавлять картинки (images / mediaIds) и задавать категории/метки по названию.",
      inputSchema: {
        id: z.number().int().describe("ID статьи"),
        title: z.string().optional(),
        content: z.string().optional(),
        status: postStatusSchema.optional(),
        excerpt: z.string().optional(),
        slug: z.string().optional(),
        categories: z.array(taxonomyRefSchema).optional(),
        tags: z.array(taxonomyRefSchema).optional(),
        featuredMediaId: z.number().int().optional(),
        mediaIds: z.array(z.number().int()).optional(),
        images: z.array(imageInputSchema).optional(),
      },
    },
    async (args) =>
      runTool("wp_update_post", async () => {
        const media = await collectMedia(wp, args.images, args.mediaIds);
        const featuredMediaId = args.featuredMediaId ?? media.featuredId ?? media.items[0]?.id;
        let content = args.content;
        if (media.items.length > 0) {
          if (content === undefined) {
            content = postRawContent(await wp.getPost(args.id));
          }
          content = injectMediaIntoContent(
            content,
            media.items.map((item) => ({
              id: item.id,
              sourceUrl: item.source_url,
              altText: item.alt_text,
              caption: item.caption?.rendered,
            })),
          );
        }

        const textForMatch = `${args.title ?? ""}\n${args.excerpt ?? ""}\n${args.content ?? ""}`;
        const shouldResolveTaxonomy =
          (args.categories && args.categories.length > 0) ||
          (args.tags && args.tags.length > 0);
        const taxonomy = shouldResolveTaxonomy
          ? await resolvePostTaxonomy(wp, textForMatch, args.categories, args.tags)
          : undefined;

        const post = await wp.updatePost({
          id: args.id,
          title: args.title,
          content,
          status: args.status,
          excerpt: args.excerpt,
          slug: args.slug,
          categories: taxonomy?.categoryIds,
          tags: taxonomy?.tagIds,
          featuredMediaId,
        });

        const extra = [
          `Статья обновлена. id=${post.id}, status=${post.status}, ссылка: ${post.link}`,
        ];
        if (featuredMediaId) extra.push(`Обложка: media id=${featuredMediaId}`);
        if (media.items.length > 0) {
          extra.push(`Изображения:\n${media.items.map((item) => `  - ${mediaLine(item)}`).join("\n")}`);
        }
        if (taxonomy) extra.push(...taxonomy.lines);
        return textResult(extra.join("\n"));
      }),
  );

  server.registerTool(
    "wp_get_post",
    {
      title: "Получить статью по ID",
      description: "Возвращает данные статьи по её id (в контексте редактирования).",
      inputSchema: {
        id: z.number().int().describe("ID статьи"),
      },
    },
    async ({ id }) =>
      runTool("wp_get_post", async () => {
        const post = await wp.getPost(id);
        return textResult(
          `id=${post.id}, status=${post.status}, title="${post.title?.rendered ?? ""}", ссылка: ${post.link}`,
        );
      }),
  );

  server.registerTool(
    "wp_list_posts",
    {
      title: "Список статей",
      description: "Возвращает список статей с фильтрами по статусу, поиску и пагинации.",
      inputSchema: {
        status: postStatusSchema.optional(),
        perPage: z.number().int().min(1).max(100).optional().describe("Записей на страницу (1-100)"),
        page: z.number().int().min(1).optional().describe("Номер страницы"),
        search: z.string().optional().describe("Поисковая строка"),
      },
    },
    async (args) =>
      runTool("wp_list_posts", async () => {
        const posts = await wp.listPosts(args);
        if (posts.length === 0) {
          return textResult("Статьи не найдены.");
        }
        const lines = posts.map(
          (p) => `- id=${p.id} [${p.status}] ${p.title?.rendered ?? ""} (${p.link})`,
        );
        return textResult(`Найдено статей: ${posts.length}\n${lines.join("\n")}`);
      }),
  );

  server.registerTool(
    "wp_delete_post",
    {
      title: "Удалить статью",
      description:
        "Удаляет статью по id. По умолчанию перемещает в корзину; " +
        "force=true удаляет безвозвратно.",
      inputSchema: {
        id: z.number().int().describe("ID статьи"),
        force: z.boolean().optional().describe("true — удалить навсегда, минуя корзину"),
      },
    },
    async ({ id, force }) =>
      runTool("wp_delete_post", async () => {
        await wp.deletePost(id, force ?? false);
        return textResult(`Статья id=${id} удалена (force=${force ?? false}).`);
      }),
  );

  server.registerTool(
    "wp_list_categories",
    {
      title: "Список категорий",
      description:
        "Возвращает категории сайта с id и названиями. " +
        "Нужны, если хотите явно указать рубрику. " +
        "wp_create_post и так подберёт категорию из этого списка по теме статьи.",
      inputSchema: {},
    },
    async () =>
      runTool("wp_list_categories", async () => {
        const cats = await wp.listCategories();
        const lines = cats.map((c) => `- id=${c.id} ${c.name} (${c.slug})`);
        return textResult(`Категории (${cats.length}):\n${lines.join("\n")}`);
      }),
  );

  server.registerTool(
    "wp_create_category",
    {
      title: "Создать категорию",
      description: "Создаёт новую категорию и возвращает её id. Обычные статьи берут рубрики из уже существующих.",
      inputSchema: {
        name: z.string().min(1).describe("Название категории"),
        description: z.string().optional().describe("Описание категории"),
      },
    },
    async ({ name, description }) =>
      runTool("wp_create_category", async () => {
        const cat = await wp.createCategory(name, description);
        return textResult(`Категория создана: id=${cat.id}, name="${cat.name}".`);
      }),
  );

  server.registerTool(
    "wp_list_tags",
    {
      title: "Список меток",
      description:
        "Возвращает метки (теги) сайта с id и названиями. " +
        "wp_create_post подберёт метки сам, если их не передать.",
      inputSchema: {},
    },
    async () =>
      runTool("wp_list_tags", async () => {
        const tags = await wp.listTags();
        const lines = tags.map((t) => `- id=${t.id} ${t.name} (${t.slug})`);
        return textResult(`Метки (${tags.length}):\n${lines.join("\n")}`);
      }),
  );

  server.registerTool(
    "wp_create_tag",
    {
      title: "Создать метку",
      description: "Создаёт новую метку (тег) и возвращает её id. Обычные статьи берут метки из уже существующих.",
      inputSchema: {
        name: z.string().min(1).describe("Название метки"),
        description: z.string().optional().describe("Описание метки"),
      },
    },
    async ({ name, description }) =>
      runTool("wp_create_tag", async () => {
        const tag = await wp.createTag(name, description);
        return textResult(`Метка создана: id=${tag.id}, name="${tag.name}".`);
      }),
  );

  logger.info("Инструменты MCP зарегистрированы (12 шт.)");
}
