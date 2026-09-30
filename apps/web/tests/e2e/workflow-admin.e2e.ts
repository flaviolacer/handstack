import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('workflow administration creates and publishes a draft', async ({ page }) => {
  let workflows: Array<{ id: string; name: string; trigger: string; status: string }> = [];
  await page.route('**/api/v1/organizations/org-workflows/**', async (route) => {
    if (route.request().headers().authorization !== 'Bearer workflow-token') {
      await route.fulfill({ status: 401, json: { title: 'Unauthorized' } });
      return;
    }
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/workflows') && route.request().method() === 'GET') {
      await route.fulfill({ json: { items: workflows } });
      return;
    }
    if (url.pathname.endsWith('/workflows') && route.request().method() === 'POST') {
      workflows = [
        { id: 'workflow-1', name: 'Example workflow', trigger: 'manual', status: 'DRAFT' },
      ];
      await route.fulfill({ status: 201, json: workflows[0] });
      return;
    }
    if (url.pathname.endsWith('/publish') && route.request().method() === 'POST') {
      workflows = workflows.map((workflow) => ({ ...workflow, status: 'PUBLISHED' }));
      await route.fulfill({ json: workflows[0] });
      return;
    }
    await route.fulfill({ status: 404, json: { title: 'Unexpected mocked request' } });
  });

  await page.goto('/workflows');
  await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  const workflowOrg = page.locator('main').getByLabel('Organization ID').first();
  const workflowToken = page.locator('main').getByLabel('Bearer access token').first();
  await workflowOrg.fill('org-workflows');
  await workflowToken.fill('workflow-token');
  await page.getByRole('button', { name: 'Carregar workflows' }).click();
  await expect(page.getByRole('button', { name: 'Novo workflow' })).toBeVisible();

  await page.getByRole('button', { name: 'Novo workflow' }).click();
  await page
    .getByLabel('JSON do workflow')
    .fill('{"name":"Example workflow","trigger":"manual","nodes":[],"edges":[]}');
  await page.getByRole('button', { name: 'Criar draft' }).click();
  await expect(page.getByText('Example workflow · manual · DRAFT')).toBeVisible();
  await page.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.getByText('Example workflow · manual · PUBLISHED')).toBeVisible();
});

test('workflow administration presents a recoverable API error', async ({ page }) => {
  await page.route('**/api/v1/organizations/org-workflow-error/**', async (route) => {
    await route.fulfill({ status: 503, json: { title: 'Unavailable' } });
  });
  await page.goto('/workflows');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('button', { name: 'Carregar workflows' })).toBeVisible();
  const workflowOrg = page.locator('main').getByLabel('Organization ID').first();
  const workflowToken = page.locator('main').getByLabel('Bearer access token').first();
  await workflowOrg.fill('org-workflow-error');
  await workflowToken.fill('workflow-token');
  await page.getByRole('button', { name: 'Carregar workflows' }).click();
  await expect(
    page.locator('main').getByText('Não foi possível carregar os workflows.'),
  ).toBeVisible();
});
