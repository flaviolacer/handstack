// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatClient } from '../app/chat/chat-client.js';

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ChatClient', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('has no automated accessibility violations in the session entry state', async () => {
    const { container } = render(<ChatClient />);
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([]);
  });

  it('connects by keyboard, keeps credentials ephemeral and exposes the empty workspace', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [] }))
      .mockResolvedValueOnce(
        json({
          items: [
            {
              id: 'model-1',
              displayName: 'Governed model',
              providerModel: 'hidden-vendor-name',
              lifecycle: 'PUBLISHED',
              capabilities: ['chat'],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(json({ items: [] }));
    vi.stubGlobal('fetch', fetch);
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const user = userEvent.setup();
    render(<ChatClient />);

    await user.type(screen.getByLabelText('Organization ID'), 'org-1');
    await user.type(screen.getByLabelText('Bearer access token'), 'private-token');
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open workspace' }));
    await user.keyboard('{Enter}');

    expect(
      await screen.findByRole('heading', { name: 'What would you like to build?' }),
    ).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe(
      'model-1',
    );
    expect(storageWrite).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('private-token');
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('private-token'))).toBe(true);
  });

  it('shows typed Problem Details failures as an alert', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(json({ title: 'Forbidden', detail: 'chat.use is required' }, 403)),
        ),
    );
    const user = userEvent.setup();
    render(<ChatClient />);
    await user.type(screen.getByLabelText('Organization ID'), 'org-1');
    await user.type(screen.getByLabelText('Bearer access token'), 'token');
    await user.click(screen.getByRole('button', { name: 'Open workspace' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('chat.use is required');
  });
});
