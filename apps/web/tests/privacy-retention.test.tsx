// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetentionClient } from '../app/privacy/retention-client.js';

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('RetentionClient', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('has no automated accessibility violations in the session entry state', async () => {
    const { container } = render(<RetentionClient />);
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([]);
  });

  it('configures retention and runs it only after explicit confirmation', async () => {
    let holds: { id: string; resourceType: string; reason: string; active: boolean }[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/retention/run'))
        return json({ runId: 'run-1', retentionDays: 30, scanned: 3, deleted: 2, retained: 1 });
      if (url.endsWith('/retention')) return json({ items: [] });
      if (url.endsWith('/legal-holds') && init?.method === 'POST') {
        holds = [
          ...holds,
          { id: 'hold-1', resourceType: 'conversations', reason: 'Review', active: true },
        ];
        return json({ id: 'hold-1' }, 201);
      }
      if (url.endsWith('/legal-holds')) return json({ items: holds });
      if (url.endsWith('/legal-holds/hold-1/release')) {
        holds = holds.map((hold) => ({ ...hold, active: false }));
        return json({ id: 'hold-1', active: false });
      }
      return json({});
    });
    const confirm = vi.fn(() => true);
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('confirm', confirm);
    const user = userEvent.setup();
    render(<RetentionClient />);

    await user.type(screen.getByLabelText('Organization ID'), 'org-retention');
    await user.type(screen.getByLabelText('Bearer access token'), 'ephemeral-token');
    await user.click(screen.getByRole('button', { name: 'Connect privacy settings' }));
    await screen.findByRole('heading', { name: 'Conversation retention' });

    await user.type(screen.getByLabelText('Reason'), 'Review');
    await user.click(screen.getByRole('button', { name: 'Create legal hold' }));
    await user.click(await screen.findByRole('button', { name: 'Release hold' }));
    await user.type(screen.getByLabelText('Retention days'), '30');
    await user.click(screen.getByRole('button', { name: 'Save retention policy' }));
    await user.click(screen.getByRole('button', { name: 'Run conversation retention…' }));

    expect(confirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('deleted 2'));
    const policyRequest = fetch.mock.calls.find(
      ([url, init]) => String(url).endsWith('/retention') && init?.method === 'POST',
    );
    expect(new Headers(policyRequest?.[1]?.headers).get('authorization')).toBe(
      'Bearer ephemeral-token',
    );
    expect(policyRequest?.[1]?.body).toBe(
      JSON.stringify({ resourceType: 'conversations', retentionDays: 30 }),
    );
    const runRequest = fetch.mock.calls.find(([url]) => String(url).endsWith('/retention/run'));
    expect(runRequest?.[1]?.method).toBe('POST');
    expect(document.body.textContent).not.toContain('ephemeral-token');
  });

  it('does not run retention when the administrator cancels confirmation', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ items: [] }));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );
    const user = userEvent.setup();
    render(<RetentionClient />);
    await user.type(screen.getByLabelText('Organization ID'), 'org-retention');
    await user.type(screen.getByLabelText('Bearer access token'), 'token');
    await user.click(screen.getByRole('button', { name: 'Connect privacy settings' }));
    await screen.findByRole('heading', { name: 'Conversation retention' });
    await user.click(screen.getByRole('button', { name: 'Run conversation retention…' }));
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/retention/run'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
