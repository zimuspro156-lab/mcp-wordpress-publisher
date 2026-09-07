/**
 * Сопоставление категорий и меток WordPress с текстом статьи.
 * Новые рубрики сами не выдумываем — выбираем из уже существующих на сайте.
 */

export interface TaxonomyTerm {
  id: number;
  name: string;
  slug: string;
  description?: string;
}

export type TaxonomyRef = string | number;

const SKIP_NAMES = new Set(["без рубрики", "uncategorized", "без категории", "без метки"]);

const STOPWORDS = new Set([
  "и",
  "в",
  "во",
  "на",
  "с",
  "со",
  "по",
  "для",
  "как",
  "это",
  "что",
  "или",
  "из",
  "к",
  "ко",
  "а",
  "но",
  "же",
  "от",
  "за",
  "не",
  "о",
  "об",
  "про",
  "при",
  "то",
  "же",
  "у",
  "до",
  "the",
  "and",
  "for",
  "with",
  "from",
]);

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

export function scoreTerm(term: TaxonomyTerm, text: string): number {
  const hay = normalizeText(text);
  if (!hay) return 0;

  const name = normalizeText(term.name);
  const slug = normalizeText(term.slug.replace(/-/g, " "));
  if (SKIP_NAMES.has(name)) return 0;

  let score = 0;
  if (name && hay.includes(name)) score += 12;
  if (slug && slug !== name && hay.includes(slug)) score += 8;

  const textTokens = new Set(tokenize(text));
  const termTokens = tokenize(`${term.name} ${term.slug} ${term.description ?? ""}`);
  for (const token of termTokens) {
    if (textTokens.has(token)) {
      score += token.length <= 3 ? 4 : 2;
    }
  }

  return score;
}

export function matchTerms(
  terms: TaxonomyTerm[],
  text: string,
  options: { limit: number; minScore?: number } = { limit: 3 },
): Array<TaxonomyTerm & { score: number }> {
  const minScore = options.minScore ?? 3;
  return terms
    .map((term) => ({ ...term, score: scoreTerm(term, text) }))
    .filter((term) => term.score >= minScore)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ru"))
    .slice(0, options.limit);
}

export function resolveTerm(terms: TaxonomyTerm[], ref: TaxonomyRef): TaxonomyTerm | undefined {
  if (typeof ref === "number") {
    return terms.find((term) => term.id === ref);
  }

  const needle = normalizeText(ref);
  if (!needle) return undefined;

  const exact = terms.find(
    (term) => normalizeText(term.name) === needle || normalizeText(term.slug) === needle,
  );
  if (exact) return exact;

  const partial = terms.filter((term) => {
    const name = normalizeText(term.name);
    const slug = normalizeText(term.slug);
    return name.includes(needle) || needle.includes(name) || slug.includes(needle) || needle.includes(slug);
  });
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    return [...partial].sort((a, b) => a.name.length - b.name.length)[0];
  }
  return undefined;
}

export function formatTerm(term: Pick<TaxonomyTerm, "id" | "name">): string {
  return `${term.name} (id=${term.id})`;
}
