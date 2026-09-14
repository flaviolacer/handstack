import { describe, expect, it } from 'vitest';
import DocsArticle from '../app/[...slug]/page.js';
import DocsIndex from '../app/page.js';

describe('Documentation routes', () => {
  it('renders the public documentation catalog', async () => {
    const page = await DocsIndex({ searchParams: Promise.resolve({ locale: 'en' }) });
    expect(page).toMatchObject({ type: 'div' });
  });

  it('renders a Portuguese canonical article', async () => {
    const page = await DocsArticle({
      params: Promise.resolve({ slug: ['user', 'help-center'] }),
      searchParams: Promise.resolve({ locale: 'pt-BR' }),
    });
    expect(page).toMatchObject({ type: 'div' });
  });
});
