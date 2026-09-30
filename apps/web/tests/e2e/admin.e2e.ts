import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('agent administration supports an accessible create-version-publish journey', async ({
  page,
}) => {
  let agents: Array<{ id: string; slug: string; name: string }> = [];
  let versions = [{ id: 'version-1', version: 1, status: 'DRAFT', model: 'provider/model' }];
  await page.route('**/api/v1/organizations/org-1/**', async (route) => {
    if (route.request().headers().authorization !== 'Bearer browser-token') {
      await route.fulfill({ status: 401, json: { title: 'Unauthorized' } });
      return;
    }
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/agents/templates')) {
      await route.fulfill({
        json: {
          items: [
            {
              id: 'general-assistant',
              name: 'General Assistant',
              description: 'A general-purpose assistant',
              model: 'provider/model',
              systemPrompt: 'Help safely',
              channels: ['WEB'],
              guardrails: [],
            },
          ],
        },
      });
      return;
    }
    if (url.pathname.endsWith('/agents') && route.request().method() === 'GET') {
      await route.fulfill({ json: { items: agents } });
      return;
    }
    if (url.pathname.endsWith('/agents') && route.request().method() === 'POST') {
      agents = [{ id: 'agent-1', slug: 'research-agent', name: 'Research Agent' }];
      await route.fulfill({
        status: 201,
        json: { id: 'agent-1', slug: 'research-agent', name: 'Research Agent' },
      });
      return;
    }
    if (url.pathname.endsWith('/versions') && route.request().method() === 'GET') {
      await route.fulfill({ json: { items: versions } });
      return;
    }
    if (url.pathname.endsWith('/versions') && route.request().method() === 'POST') {
      versions = [{ id: 'version-2', version: 2, status: 'DRAFT', model: 'provider/model' }];
      await route.fulfill({ status: 201, json: versions[0] });
      return;
    }
    if (url.pathname.endsWith('/publish') && route.request().method() === 'POST') {
      versions = versions.map((version) => ({ ...version, status: 'PUBLISHED' }));
      await route.fulfill({ json: versions[0] });
      return;
    }
    await route.fulfill({ status: 404, json: { title: 'Unexpected mocked request' } });
  });

  await page.goto('/agents');
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Carregar agents' })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByLabel('Organization ID').fill('org-1');
  await page.getByLabel('Bearer access token').fill('browser-token');
  await page.getByRole('button', { name: 'Carregar agents' }).click();
  await expect(page.getByText('General Assistant')).toBeVisible();

  await page.getByRole('button', { name: 'Novo agent' }).click();
  await page.getByLabel('Slug').fill('research-agent');
  await page.getByLabel('Nome').fill('Research Agent');
  await page.getByRole('button', { name: 'Criar agent' }).click();
  await expect(
    page.getByRole('button', { name: /Research Agent \(research-agent\)/u }),
  ).toBeVisible();

  await page.getByRole('button', { name: /Research Agent \(research-agent\)/u }).click();
  await page.getByRole('tab', { name: 'Prompt' }).click();
  await page.getByLabel('System prompt').fill('Answer with citations');
  await page.getByRole('tab', { name: 'Model' }).click();
  await page.getByLabel('Modelo').fill('provider/model');
  await page.getByRole('tab', { name: 'Publishing' }).click();
  await page.getByLabel(/Canais/u).fill('WEB, MCP');
  await page.getByRole('button', { name: 'Criar versão' }).click();
  await page.getByRole('tab', { name: 'Versions' }).click();
  await expect(page.getByText('v2 · provider/model · DRAFT')).toBeVisible();
  await page.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.getByText('v2 · provider/model · PUBLISHED')).toBeVisible();
});

test('agent administration presents a recoverable API error', async ({ page }) => {
  await page.route('**/api/v1/organizations/org-error/**', async (route) => {
    await route.fulfill({ status: 503, json: { title: 'Unavailable' } });
  });
  await page.goto('/agents');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('button', { name: 'Carregar agents' })).toBeVisible();
  await page.getByLabel('Organization ID').fill('org-error');
  await page.getByLabel('Bearer access token').fill('browser-token');
  await expect(page.getByLabel('Organization ID')).toHaveValue('org-error');
  await expect(page.getByLabel('Bearer access token')).toHaveValue('browser-token');
  await page.getByRole('button', { name: 'Carregar agents' }).click();
  await expect(page.locator('p[role="alert"]')).toHaveText(
    'Não foi possível carregar os agentes e templates. Verifique a organização e o token.',
  );
});
