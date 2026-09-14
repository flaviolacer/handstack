import { getArticle, supportedLocales, type DocumentationLocale } from '@handstack/docs-engine';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import ReactMarkdown from 'react-markdown';

export default async function HelpArticle({
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
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack Help</div>
        <nav className="nav" aria-label="Article navigation">
          <Link href={`/help?locale=${locale}`}>← All articles</Link>
          <Link href="/">Workspace</Link>
        </nav>
      </aside>
      <main className="main">
        <div className="locale">
          {supportedLocales.map((item) => (
            <Link key={item} href={`/help/${article.metadata.id}?locale=${item}`}>
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
