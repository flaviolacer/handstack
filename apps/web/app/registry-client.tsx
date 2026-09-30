'use client';

import { useState, type SyntheticEvent } from 'react';

export function RegistryClient() {
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState('');
  async function load(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const catalog = data.get('catalog');
    const search = data.get('search');
    const selectedCatalog = typeof catalog === 'string' ? catalog : 'OFFICIAL';
    const query = new URLSearchParams({ catalog: selectedCatalog });
    if (typeof search === 'string' && search.trim() !== '') query.set('search', search.trim());
    const response = await fetch(`/registry/plugins?${query.toString()}`, { cache: 'no-store' });
    if (!response.ok) {
      setError('Unable to load plugin registry');
      return;
    }
    setResult(await response.json());
    setError('');
  }
  return (
    <div className="settings-stack">
      <section className="panel narrow-panel">
        <h2>Search plugin registry</h2>
        <form className="form-grid" onSubmit={(event) => void load(event)}>
          <label>
            Catalog
            <select name="catalog" defaultValue="OFFICIAL">
              <option>OFFICIAL</option>
              <option>COMMUNITY</option>
              <option>INSTALLED</option>
              <option>UPDATES</option>
            </select>
          </label>
          <label>
            Search
            <input name="search" />
          </label>
          <button className="primary-button" type="submit">
            Load plugins
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </section>
      {result !== undefined && (
        <section className="panel">
          <h2>Registry results</h2>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}
