import { loadArticles, supportedLocales, type DocumentationLocale } from '@handstack/docs-engine';
import Link from 'next/link';

export default async function HelpIndex({
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
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack Help</div>
        <nav className="nav" aria-label="Help navigation">
          <Link href="/">Workspace</Link>
          {articles.map(({ metadata }) => (
            <Link key={metadata.id} href={`/help/${metadata.id}?locale=${locale}`}>
              {metadata.title}
            </Link>
          ))}
        </nav>
      </aside>
      <main className="main">
        <div className="eyebrow">Offline-capable · Versioned · Canonical</div>
        <h1>Help Center</h1>
        <form action="/help/search" role="search">
          <input type="hidden" name="locale" value={locale} />
          <label htmlFor="help-query">Search articles</label>
          <div className="search-row">
            <input id="help-query" name="q" autoComplete="off" />
            <button type="submit">Search</button>
          </div>
        </form>
        <div className="locale" aria-label="Language">
          {supportedLocales.map((item) => (
            <Link key={item} href={`/help?locale=${item}`}>
              {item}
            </Link>
          ))}
        </div>
        <div className="cards">
          {articles.map(({ metadata }) => (
            <Link className="card" key={metadata.id} href={`/help/${metadata.id}?locale=${locale}`}>
              <strong>{metadata.title}</strong>
              <p>{metadata.description}</p>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
