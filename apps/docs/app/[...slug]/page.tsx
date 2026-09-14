import {
  getArticle,
  loadArticles,
  supportedLocales,
  type DocumentationLocale,
} from '@handstack/docs-engine';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import ReactMarkdown from 'react-markdown';

export default async function DocsArticle({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string[] }>;
  searchParams: Promise<{ locale?: string }>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const locale: DocumentationLocale = supportedLocales.includes(query.locale as DocumentationLocale)
    ? (query.locale as DocumentationLocale)
    : 'en';
  const article = getArticle(locale, slug.join('/'));
  if (article === undefined) notFound();
  const articles = loadArticles(locale);
  return (
    <div className="layout">
      <aside className="sidebar">
        <nav aria-label="Documentation navigation">
          {articles.map(({ metadata }) => (
            <Link key={metadata.id} href={`/${metadata.id}?locale=${locale}`}>
              {metadata.title}
            </Link>
          ))}
        </nav>
      </aside>
      <main className="main">
        <div className="locale">
          {supportedLocales.map((item) => (
            <Link key={item} href={`/${article.metadata.id}?locale=${item}`}>
              {item}
            </Link>
          ))}
        </div>
        <article className="article">
          <ReactMarkdown>{article.body}</ReactMarkdown>
        </article>
      </main>
    </div>
  );
}
