import { loadArticles, supportedLocales, type DocumentationLocale } from '@handstack/docs-engine';
import Link from 'next/link';

export default async function DocsIndex({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string }>;
}) {
  const requested = (await searchParams).locale;
  const locale: DocumentationLocale = supportedLocales.includes(requested as DocumentationLocale)
    ? (requested as DocumentationLocale)
    : 'en';
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
            <Link key={item} href={`/?locale=${item}`}>
              {item}
            </Link>
          ))}
        </div>
        <h1>Documentation</h1>
        <p>
          Canonical, versioned guidance for HandStack users, administrators, developers, security
          teams, and operators.
        </p>
        <div className="cards">
          {articles.map(({ metadata }) => (
            <Link className="card" key={metadata.id} href={`/${metadata.id}?locale=${locale}`}>
              <strong>{metadata.title}</strong>
              <p>{metadata.description}</p>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
