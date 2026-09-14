import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

export const supportedLocales = ['en', 'pt-BR'] as const;
export type DocumentationLocale = (typeof supportedLocales)[number];

const articleMetadataSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-/]+$/),
    title: z.string().min(1),
    description: z.string().min(1),
    audience: z.array(z.string()).min(1),
    permissions: z.array(z.string()),
    features: z.array(z.string()).min(1),
    deploymentProfiles: z.array(z.enum(['compact', 'distributed'])).min(1),
    introducedIn: z.string().regex(/^\d+\.\d+\.\d+$/),
    lastReviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    owner: z.string().min(1),
    tags: z.array(z.string()).min(1),
  })
  .strict();

export type ArticleMetadata = z.infer<typeof articleMetadataSchema>;

export interface DocumentationArticle {
  readonly locale: DocumentationLocale;
  readonly metadata: ArticleMetadata;
  readonly body: string;
  readonly sourcePath: string;
}

export interface DocumentationSearchEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly headings: readonly string[];
  readonly tags: readonly string[];
  readonly searchableText: string;
}

export interface DocumentationSearchResult {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly score: number;
}

export function findWorkspaceRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, 'package-lock.json'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error('HandStack workspace root not found.');
    current = parent;
  }
}

export function loadArticles(
  locale: DocumentationLocale,
  workspaceRoot = findWorkspaceRoot(),
): readonly DocumentationArticle[] {
  const localeRoot = join(workspaceRoot, 'docs', 'content', locale);
  return walkMdx(localeRoot)
    .map((sourcePath) => parseArticle(sourcePath, locale))
    .sort((left, right) => left.metadata.id.localeCompare(right.metadata.id));
}

export function getArticle(
  locale: DocumentationLocale,
  id: string,
  workspaceRoot = findWorkspaceRoot(),
): DocumentationArticle | undefined {
  return loadArticles(locale, workspaceRoot).find((article) => article.metadata.id === id);
}

export function buildSearchIndex(
  locale: DocumentationLocale,
  workspaceRoot = findWorkspaceRoot(),
): readonly DocumentationSearchEntry[] {
  return loadArticles(locale, workspaceRoot).map(({ metadata, body }) => {
    const headings = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1] ?? '');
    return {
      id: metadata.id,
      title: metadata.title,
      description: metadata.description,
      headings,
      tags: metadata.tags,
      searchableText: normalizeSearchText(
        [
          metadata.title,
          metadata.description,
          ...metadata.features,
          ...metadata.tags,
          ...headings,
          body,
        ].join(' '),
      ),
    };
  });
}

export function searchDocumentation(
  locale: DocumentationLocale,
  query: string,
  workspaceRoot = findWorkspaceRoot(),
): readonly DocumentationSearchResult[] {
  const normalizedQuery = normalizeSearchText(query).replace(/\bajuda\b/gu, 'help center');
  const terms = normalizedQuery.split(/\s+/).filter((term) => term.length > 1);
  if (terms.length === 0) return [];
  return buildSearchIndex(locale, workspaceRoot)
    .map((entry) => {
      const normalizedTitle = normalizeSearchText(entry.title);
      const normalizedDescription = normalizeSearchText(entry.description);
      const score =
        terms.reduce(
          (total, term) =>
            total +
            (normalizedTitle.includes(term) ? 5 : 0) +
            (entry.tags.some((tag) => normalizeSearchText(tag).includes(term)) ? 3 : 0) +
            (entry.searchableText.includes(term) ? 1 : 0),
          0,
        ) +
        (normalizedTitle.includes(normalizedQuery) ? 12 : 0) +
        (normalizedDescription.includes(normalizedQuery) ? 12 : 0);
      return { id: entry.id, title: entry.title, description: entry.description, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export interface DocumentationValidationResult {
  readonly articleCount: number;
  readonly errors: readonly string[];
}

const requirementSchema = z.object({
  id: z.string().regex(/^HS-(CORE|SEC|DATA|AI|API|OPS|UX|DOC)-\d{3}$/),
  title: z.string().min(1),
  normativeStatement: z.string().min(1),
  rationale: z.string().min(1),
  owner: z.string().min(1),
  status: z.enum(['planned', 'in-progress', 'implemented', 'verified']),
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  affectedModules: z.array(z.string()).min(1),
  publicContracts: z.array(z.string()),
  dataEntities: z.array(z.string()),
  securityPrivacyImpact: z.string().min(1),
  acceptanceCriteria: z.string().min(1),
  testIds: z.array(z.string().regex(/^HS-T-[A-Z0-9-]+$/)).min(1),
  testPaths: z.array(z.string()).min(1),
  documentationArticleIds: z.array(z.string()).min(1),
  introducedVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
});

const requirementCatalogSchema = z.object({
  version: z.literal(1),
  requirements: z.array(requirementSchema).min(1),
});

const contextualHelpSchema = z.object({
  version: z.literal(1),
  targets: z
    .array(
      z.object({
        surface: z.string().min(1),
        route: z.string().startsWith('/'),
        articleId: z.string().min(1),
      }),
    )
    .min(1),
});

export interface GovernanceValidationResult {
  readonly requirementCount: number;
  readonly contextualHelpTargetCount: number;
  readonly errors: readonly string[];
}

export function validateGovernance(
  workspaceRoot = findWorkspaceRoot(),
): GovernanceValidationResult {
  const errors: string[] = [];
  const catalogPath = join(workspaceRoot, 'docs', 'requirements', 'catalog.yaml');
  const helpPath = join(workspaceRoot, 'docs', 'contextual-help.yaml');
  const catalog = requirementCatalogSchema.parse(parse(readFileSync(catalogPath, 'utf8')));
  const contextualHelp = contextualHelpSchema.parse(parse(readFileSync(helpPath, 'utf8')));
  const articleIdsByLocale = new Map(
    supportedLocales.map(
      (locale) =>
        [
          locale,
          new Set(loadArticles(locale, workspaceRoot).map(({ metadata }) => metadata.id)),
        ] as const,
    ),
  );
  const allArticleIds = new Set(
    [...articleIdsByLocale.values()].flatMap((articleIds) => [...articleIds]),
  );
  const requirementIds = new Set<string>();
  const testIds = new Set<string>();

  for (const requirement of catalog.requirements) {
    if (requirementIds.has(requirement.id))
      errors.push(`Duplicate requirement id: ${requirement.id}`);
    requirementIds.add(requirement.id);
    for (const modulePath of requirement.affectedModules) {
      if (!existsSync(join(workspaceRoot, modulePath))) {
        errors.push(`${requirement.id} missing affected module: ${modulePath}`);
      }
    }
    for (const testPath of requirement.testPaths) {
      if (!existsSync(join(workspaceRoot, testPath)))
        errors.push(`${requirement.id} missing test: ${testPath}`);
    }
    for (const testId of requirement.testIds) {
      if (testIds.has(testId)) errors.push(`Duplicate test id: ${testId}`);
      testIds.add(testId);
    }
    for (const articleId of requirement.documentationArticleIds) {
      for (const locale of supportedLocales) {
        if (!articleIdsByLocale.get(locale)?.has(articleId)) {
          errors.push(`${requirement.id} missing ${locale} documentation: ${articleId}`);
        }
      }
    }
  }

  for (const target of contextualHelp.targets) {
    if (!existsSync(join(workspaceRoot, target.surface))) {
      errors.push(`Contextual help surface does not exist: ${target.surface}`);
    }
    if (!allArticleIds.has(target.articleId)) {
      errors.push(`Contextual help article does not exist: ${target.articleId}`);
    }
  }

  return {
    requirementCount: catalog.requirements.length,
    contextualHelpTargetCount: contextualHelp.targets.length,
    errors,
  };
}

export function validateDocumentation(
  workspaceRoot = findWorkspaceRoot(),
): DocumentationValidationResult {
  const errors: string[] = [];
  const byLocale = new Map<DocumentationLocale, readonly DocumentationArticle[]>();

  for (const locale of supportedLocales) {
    try {
      const articles = loadArticles(locale, workspaceRoot);
      byLocale.set(locale, articles);
      validateUniqueIds(articles, locale, errors);
      for (const article of articles) validateOperationalTemplate(article, errors);
      validateInternalLinks(articles, locale, errors);
    } catch (error) {
      errors.push(`${locale}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const englishIds = new Set((byLocale.get('en') ?? []).map(({ metadata }) => metadata.id));
  const portugueseIds = new Set((byLocale.get('pt-BR') ?? []).map(({ metadata }) => metadata.id));
  for (const id of englishIds)
    if (!portugueseIds.has(id)) errors.push(`Missing pt-BR article: ${id}`);
  for (const id of portugueseIds) if (!englishIds.has(id)) errors.push(`Missing en article: ${id}`);

  return {
    articleCount: [...byLocale.values()].reduce((total, articles) => total + articles.length, 0),
    errors,
  };
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase();
}

function validateInternalLinks(
  articles: readonly DocumentationArticle[],
  locale: DocumentationLocale,
  errors: string[],
): void {
  const ids = new Set(articles.map(({ metadata }) => metadata.id));
  for (const article of articles) {
    for (const match of article.body.matchAll(/\]\(\/(?:help\/)?([^?#)]+)(?:[?#][^)]*)?\)/g)) {
      const target = match[1];
      if (target !== undefined && !ids.has(target)) {
        errors.push(`${locale}:${article.metadata.id} has broken internal link: ${target}`);
      }
    }
  }
}

function parseArticle(sourcePath: string, locale: DocumentationLocale): DocumentationArticle {
  const source = readFileSync(sourcePath, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`Invalid or missing frontmatter: ${relative(findWorkspaceRoot(), sourcePath)}`);
  }
  const metadata = articleMetadataSchema.parse(parse(match[1]));
  return { locale, metadata, body: match[2].trim(), sourcePath };
}

function walkMdx(directory: string): readonly string[] {
  if (!existsSync(directory))
    throw new Error(`Documentation directory does not exist: ${directory}`);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walkMdx(path);
    return entry.isFile() && entry.name.endsWith('.mdx') ? [path] : [];
  });
}

function validateUniqueIds(
  articles: readonly DocumentationArticle[],
  locale: DocumentationLocale,
  errors: string[],
): void {
  const ids = new Set<string>();
  for (const article of articles) {
    if (ids.has(article.metadata.id))
      errors.push(`Duplicate ${locale} article id: ${article.metadata.id}`);
    ids.add(article.metadata.id);
  }
}

function validateOperationalTemplate(article: DocumentationArticle, errors: string[]): void {
  const requiredHeadings = ['## Prerequisites', '## Steps', '## Verify', '## Troubleshooting'];
  for (const heading of requiredHeadings) {
    if (!article.body.includes(heading)) {
      errors.push(`${article.locale}:${article.metadata.id} missing heading: ${heading}`);
    }
  }
}
