import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }, testInfo) => {
  let streamAttempts = 0;
  const includePublishedAgent = testInfo.title.includes('selects a published agent');
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
    if (url.pathname.endsWith('/chat/agents')) {
      await route.fulfill({
        json: {
          items: includePublishedAgent
            ? [{ id: 'agent-1', name: 'Research assistant', description: 'Published for web' }]
            : [],
        },
      });
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
    if (
      url.pathname.endsWith('/branches/branch-1/messages') &&
      route.request().method() === 'POST'
    ) {
      await route.fulfill({
        status: 201,
        json: {
          id: 'user-message-1',
          conversationId: 'conversation-1',
          branchId: 'branch-1',
          sequence: 1,
          role: 'user',
          parts: [{ id: 'user-part-1', type: 'text', text: 'Hello' }],
          status: 'COMPLETED',
        },
      });
      return;
    }
    if (url.pathname.endsWith('/branches/branch-1/executions')) {
      const body = route.request().postDataJSON() as { agentId?: string };
      if (body.agentId !== undefined) {
        await route.fulfill({
          status: 201,
          json: {
            id: 'agent-assistant-message-1',
            conversationId: 'conversation-1',
            branchId: 'branch-1',
            sequence: 2,
            role: 'assistant',
            parts: [{ id: 'agent-part-1', type: 'text', text: 'Agent response from workspace' }],
            status: 'COMPLETED',
          },
        });
        return;
      }
      await route.fulfill({
        status: 201,
        json: {
          id: 'assistant-message-1',
          conversationId: 'conversation-1',
          branchId: 'branch-1',
          sequence: 2,
          role: 'assistant',
          parts: [],
          status: 'STREAMING',
        },
      });
      return;
    }
    if (url.pathname.endsWith('/messages/assistant-message-1/events')) {
      streamAttempts += 1;
      const body =
        streamAttempts === 1
          ? 'data: {"sequence":3,"type":"DELTA","part":{"id":"assistant-part-1","type":"text","text":"Recovered"}}\n\n'
          : 'data: {"sequence":4,"type":"COMPLETED"}\n\n';
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body,
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

test('reconnects the SSE stream after a transient network disconnect', async ({ page }) => {
  await page.goto('/chat');
  await page.getByLabel('Organization ID').fill('org-1');
  await page.getByLabel('Bearer access token').fill('browser-token');
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await page.getByRole('button', { name: 'Start a conversation' }).click();
  await page.getByLabel('Message').fill('Hello');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('Recovered')).toBeVisible();
  await expect(
    page.getByRole('article').filter({ hasText: 'Recovered' }).locator('.badge'),
  ).toBeVisible();
  await expect(
    page.getByRole('article').filter({ hasText: 'Recovered' }).locator('.badge'),
  ).toHaveText('COMPLETED');
});

test('selects a published agent and sends it through the chat execution contract', async ({
  page,
}) => {
  let executionAgentId: string | undefined;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/branches/branch-1/executions')) {
      const body = request.postDataJSON() as { agentId?: string };
      executionAgentId = body.agentId;
    }
  });
  await page.goto('/chat');
  await page.getByLabel('Organization ID').fill('org-1');
  await page.getByLabel('Bearer access token').fill('browser-token');
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await page.getByRole('combobox', { name: 'Agent' }).selectOption('agent-1');
  await page.getByRole('button', { name: 'Start a conversation' }).click();
  await page.getByLabel('Message').fill('Find the answer');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('Agent response from workspace')).toBeVisible();
  expect(executionAgentId).toBe('agent-1');
});
