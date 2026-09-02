import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "./logger.js";
import { WordPressClient, WordPressApiError } from "./wordpress.js";

const postStatusSchema = z
  .enum(["publish", "draft", "pending", "private", "future"])
  .describe("Статус публикации в WordPress");

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
    "wp_create_post",
    {
      title: "Создать/опубликовать статью",
      description:
        "Создаёт новую статью в WordPress. По умолчанию status=draft (черновик). " +
        "Для немедленной публикации укажите status='publish'. Контент принимает HTML.",
      inputSchema: {
        title: z.string().min(1).describe("Заголовок статьи"),
        content: z.string().min(1).describe("Содержимое статьи (HTML или текст)"),
        status: postStatusSchema.optional(),
        excerpt: z.string().optional().describe("Краткое описание (анонс)"),
        slug: z.string().optional().describe("URL-слаг статьи"),
        categories: z.array(z.number().int()).optional().describe("ID категорий"),
        tags: z.array(z.number().int()).optional().describe("ID меток"),
        featuredMediaId: z.number().int().optional().describe("ID изображения записи"),
        date: z
          .string()
          .optional()
          .describe("Дата в ISO 8601 для отложенной публикации (при status=future)"),
      },
    },
    async (args) =>
      runTool("wp_create_post", async () => {
        const post = await wp.createPost(args);
        return textResult(
          `Статья создана. id=${post.id}, status=${post.status}, ссылка: ${post.link}`,
        );
      }),
  );

  server.registerTool(
    "wp_update_post",
    {
      title: "Обновить статью",
      description:
        "Обновляет существующую статью по её id. Передавайте только те поля, " +
        "которые нужно изменить. Можно менять статус (например, draft -> publish).",
      inputSchema: {
        id: z.number().int().describe("ID статьи"),
        title: z.string().optional(),
        content: z.string().optional(),
        status: postStatusSchema.optional(),
        excerpt: z.string().optional(),
        slug: z.string().optional(),
        categories: z.array(z.number().int()).optional(),
        tags: z.array(z.number().int()).optional(),
        featuredMediaId: z.number().int().optional(),
      },
    },
    async (args) =>
      runTool("wp_update_post", async () => {
        const post = await wp.updatePost(args);
        return textResult(
          `Статья обновлена. id=${post.id}, status=${post.status}, ссылка: ${post.link}`,
        );
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
      description: "Возвращает категории сайта с их id (нужны для wp_create_post).",
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
      description: "Создаёт новую категорию и возвращает её id.",
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
      description: "Возвращает метки (теги) сайта с их id.",
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
      description: "Создаёт новую метку (тег) и возвращает её id.",
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

  logger.info("Инструменты MCP зарегистрированы (11 шт.)");
}
