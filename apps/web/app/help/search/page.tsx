import {
  searchDocumentation,
  supportedLocales,
  type DocumentationLocale,
} from '@handstack/docs-engine';
import Link from 'next/link';

export default async function HelpSearch({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string; q?: string }>;
}) {
  const query = await searchParams;
  const locale: DocumentationLocale = supportedLocales.includes(query.locale as DocumentationLocale)
    ? (query.locale as DocumentationLocale)
    : 'en';
  const phrase = query.q?.trim() ?? '';
  const results = searchDocumentation(locale, phrase);
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack Help</div>
        <nav className="nav" aria-label="Search navigation">
          <Link href={`/help?locale=${locale}`}>← Help Center</Link>
          <Link href="/">Workspace</Link>
        </nav>
      </aside>
      <main className="main">
        <div className="eyebrow">Local documentation index</div>
        <h1>Search Help</h1>
        <form action="/help/search" role="search">
          <input type="hidden" name="locale" value={locale} />
          <label htmlFor="help-query">Search articles</label>
          <div className="search-row">
            <input id="help-query" name="q" defaultValue={phrase} autoComplete="off" />
            <button type="submit">Search</button>
          </div>
        </form>
        {phrase.length > 0 && results.length === 0 ? <p>No matching articles.</p> : null}
        <div className="cards">
          {results.map((result) => (
            <Link className="card" key={result.id} href={`/help/${result.id}?locale=${locale}`}>
              <strong>{result.title}</strong>
              <p>{result.description}</p>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
