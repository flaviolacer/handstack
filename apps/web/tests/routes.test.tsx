import { describe, expect, it } from 'vitest';
import HelpArticle from '../app/help/[...slug]/page.js';
import HelpIndex from '../app/help/page.js';
import HelpSearch from '../app/help/search/page.js';
import HomePage from '../app/page.js';
import IdentityProvidersPage from '../app/settings/identity-providers/page.js';
import ChatPage from '../app/chat/page.js';
import DeadLettersPage from '../app/operations/dead-letters/page.js';
import PrivacyPage from '../app/privacy/page.js';

describe('Web routes', () => {
  it('renders the workspace shell', () => {
    expect(HomePage()).toMatchObject({ type: 'div' });
  });

  it('renders the identity provider settings route', () => {
    expect(IdentityProvidersPage()).toMatchObject({ type: 'div' });
  });

  it('renders the chat workspace route', () => {
    expect(ChatPage()).toMatchObject({ type: 'div' });
  });

  it('renders the dead-letter operations route', () => {
    expect(DeadLettersPage()).toMatchObject({ type: 'div' });
  });

  it('renders the privacy administration route with retention controls', () => {
    expect(PrivacyPage()).toMatchObject({ type: 'div' });
  });

  it('renders the localized Help Center catalog', async () => {
    const page = await HelpIndex({ searchParams: Promise.resolve({ locale: 'pt-BR' }) });
    expect(page).toMatchObject({ type: 'div' });
  });

  it('renders a canonical Help Center article', async () => {
    const page = await HelpArticle({
      params: Promise.resolve({ slug: ['getting-started', 'overview'] }),
      searchParams: Promise.resolve({ locale: 'en' }),
    });
    expect(page).toMatchObject({ type: 'div' });
  });

  it('searches the packaged Portuguese documentation index', async () => {
    const page = await HelpSearch({
      searchParams: Promise.resolve({ locale: 'pt-BR', q: 'ajuda offline' }),
    });
    expect(page).toMatchObject({ type: 'div' });
  });
});
