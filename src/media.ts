/**
 * Подготовка изображений (URL / base64) и вставка их в HTML статьи.
 * Генерации картинок здесь нет — только приём готовых файлов.
 */

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export interface PreparedImage {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

export interface MediaForContent {
  id: number;
  sourceUrl: string;
  altText?: string;
  caption?: string;
}

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
};

const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
]);

export function isHttpUrl(source: string): boolean {
  return /^https?:\/\//i.test(source.trim());
}

export function isDataUri(source: string): boolean {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(source.trim());
}

export function looksLikeBase64(source: string): boolean {
  const trimmed = source.trim();
  if (isDataUri(trimmed)) return true;
  if (isHttpUrl(trimmed)) return false;
  if (trimmed.length < 32) return false;
  return /^[A-Za-z0-9+/=\s]+$/.test(trimmed);
}

export function detectImageSourceKind(source: string): "url" | "base64" {
  if (isHttpUrl(source)) return "url";
  if (isDataUri(source) || looksLikeBase64(source)) return "base64";
  throw new Error(
    "Непонятный источник изображения: нужен http(s) URL либо base64 / data URI (data:image/...;base64,...).",
  );
}

export function normalizeMime(mime: string): string {
  const clean = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return clean === "image/jpg" ? "image/jpeg" : clean;
}

export function extForMime(mime: string): string {
  return MIME_TO_EXT[normalizeMime(mime)] ?? ".jpg";
}

export function sanitizeFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "upload.jpg";
  const cleaned = base.replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "upload.jpg";
}

function sniffMime(buffer: Buffer): string | undefined {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (buffer.length >= 6 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

function assertImage(buffer: Buffer, mimeType: string): string {
  const sniffed = sniffMime(buffer);
  const mime = sniffed ?? normalizeMime(mimeType);
  if (!ALLOWED_MIMES.has(mime) && mime !== "application/octet-stream") {
    throw new Error(`Неподдерживаемый тип файла: ${mime}. Нужны JPEG, PNG, GIF, WebP или AVIF.`);
  }
  const resolved = sniffed ?? (mime === "application/octet-stream" ? "" : mime);
  if (!resolved || !ALLOWED_MIMES.has(resolved)) {
    throw new Error("Файл не похож на изображение (JPEG/PNG/GIF/WebP).");
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Изображение слишком большое (${buffer.length} байт). Лимит ${MAX_IMAGE_BYTES} байт.`);
  }
  return normalizeMime(resolved);
}

export function decodeBase64Image(source: string, filename?: string): PreparedImage {
  const trimmed = source.trim();
  const dataUri = trimmed.match(/^data:([^;]+);base64,([\s\S]+)$/i);
  let declaredMime = "image/jpeg";
  let raw = trimmed;
  if (dataUri) {
    declaredMime = dataUri[1];
    raw = dataUri[2];
  }
  const buffer = Buffer.from(raw.replace(/\s/g, ""), "base64");
  if (buffer.length === 0) {
    throw new Error("Пустой base64: не удалось декодировать изображение.");
  }
  const mimeType = assertImage(buffer, declaredMime);
  return {
    buffer,
    mimeType,
    filename: sanitizeFilename(filename ?? `upload${extForMime(mimeType)}`),
  };
}

export async function downloadImage(url: string, filename?: string): Promise<PreparedImage> {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error(`Некорректный URL изображения: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URL изображения должен начинаться с http:// или https://");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(parsed, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        Accept: "image/*,*/*;q=0.8",
        "User-Agent": "mcp-wordpress-publisher/1.2.0",
      },
    });
  } catch (error) {
    throw new Error(`Не удалось скачать изображение по URL: ${String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`URL изображения вернул HTTP ${response.status}: ${parsed.href}`);
  }

  const lengthHeader = Number(response.headers.get("content-length") ?? 0);
  if (lengthHeader > MAX_IMAGE_BYTES) {
    throw new Error(`Изображение по URL больше лимита ${MAX_IMAGE_BYTES} байт.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const headerMime = response.headers.get("content-type") ?? "application/octet-stream";
  const mimeType = assertImage(buffer, headerMime);

  const fromUrl = sanitizeFilename(parsed.pathname);
  const hasExt = /\.(jpe?g|png|gif|webp|avif)$/i.test(fromUrl);
  return {
    buffer,
    mimeType,
    filename: sanitizeFilename(filename ?? (hasExt ? fromUrl : `upload${extForMime(mimeType)}`)),
  };
}

/**
 * Убирает ведущий H1 / markdown-заголовок: тему сайта уже рисует тема WordPress.
 */
export function stripLeadingTitleHeading(content: string): string {
  const text = content.replace(/^\s+/, "");
  const withoutH1 = text.replace(/^<h1\b[^>]*>[\s\S]*?<\/h1>\s*/i, "");
  if (withoutH1 !== text) return withoutH1;
  return text.replace(/^#\s+[^\n]+\n+/, "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function mediaToFigure(media: MediaForContent): string {
  const alt = escapeHtml(media.altText ?? "");
  const img = `<img src="${escapeHtml(media.sourceUrl)}" alt="${alt}" class="wp-image-${media.id}" />`;
  const caption = media.caption?.trim()
    ? `\n  <figcaption>${escapeHtml(media.caption.trim())}</figcaption>`
    : "";
  return `<!-- wp:image {"id":${media.id},"sizeSlug":"large"} -->\n<figure class="wp-block-image size-large">${img}${caption}</figure>\n<!-- /wp:image -->`;
}

/**
 * Вставляет ещё не упомянутые в HTML картинки: в плейсхолдер, после первого абзаца или в начало.
 */
export function injectMediaIntoContent(content: string, media: MediaForContent[]): string {
  const missing = media.filter(
    (item) => !content.includes(item.sourceUrl) && !content.includes(`wp-image-${item.id}`),
  );
  if (missing.length === 0) return content;

  const html = missing.map(mediaToFigure).join("\n");
  if (/<!--\s*wp:images\s*-->/i.test(content)) {
    return content.replace(/<!--\s*wp:images\s*-->/i, html);
  }

  const firstParagraph = content.match(/<\/p>/i);
  if (firstParagraph?.index !== undefined) {
    const at = firstParagraph.index + firstParagraph[0].length;
    return `${content.slice(0, at)}\n${html}\n${content.slice(at)}`;
  }

  return `${html}\n${content}`;
}
