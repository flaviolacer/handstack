import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/organizations/org-1/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().headers().authorization !== 'Bearer browser-token') {
      await route.fulfill({ status: 401, json: { title: 'Unauthorized' } });
      return;
    }
    if (url.pathname.endsWith('/conversations') && route.request().method() === 'GET') {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (url.pathname.endsWith('/chat/models')) {
      await route.fulfill({
        json: {
          items: [
            {
              id: 'model-1',
              displayName: 'Governed model',
              providerModel: 'hidden-vendor-name',
              lifecycle: 'PUBLISHED',
              capabilities: ['chat'],
            },
          ],
        },
      });
      return;
    }
    if (url.pathname.endsWith('/conversations') && route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        json: {
          id: 'conversation-1',
          title: 'New conversation',
          activeBranchId: 'branch-1',
          status: 'ACTIVE',
          updatedAt: '2026-09-08T00:00:00.000Z',
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { title: 'Unexpected mocked request' } });
  });
});

test('keyboard-only chat is responsive, accessible and keeps credentials ephemeral', async ({
  page,
}) => {
  await page.goto('/chat');
  await expect(page.getByRole('heading', { name: 'Chat workspace' })).toBeVisible();
  await page.getByLabel('Organization ID').fill('org-1');
  await page.getByLabel('Bearer access token').fill('browser-token');
  await page.getByLabel('Bearer access token').press('Tab');
  await expect(page.getByRole('button', { name: 'Open workspace' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'What would you like to build?' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Model' })).toHaveValue('model-1');
  await page.getByRole('button', { name: 'Start a conversation' }).click();
  await expect(page.getByLabel('Message')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('browser-token');
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await expect(page).toHaveScreenshot('chat-workspace.png', { fullPage: true });
});
