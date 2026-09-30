// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsClient } from '../app/settings/settings-client.js';

const organizationSettings = {
  id: 'org-settings',
  tenantId: 'org-settings',
  organizationId: 'org-settings',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  locale: 'en-US',
  timezone: 'UTC',
  theme: 'system',
  branding: {
    displayName: 'HandStack',
    productName: 'HandStack',
    primaryColor: '#2563eb',
    secondaryColor: '#0f172a',
    accentColor: '#14b8a6',
    backgroundColor: '#f8fafc',
    legalLinks: [],
  },
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SettingsClient', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('has no automated accessibility violations before connecting', async () => {
    const { container } = render(<SettingsClient />);
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([]);
  });

  it('loads and saves global runtime and organization settings through the authenticated UI', async () => {
    let globalConfiguration: Record<string, unknown> = { timeouts: { http: 15_000 } };
    let savedOrganization = organizationSettings;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/v1/admin/settings/database')) {
        if (init?.method === 'PATCH') {
          globalConfiguration = JSON.parse(String(init.body)) as Record<string, unknown>;
          return json(globalConfiguration);
        }
        return json(globalConfiguration);
      }
      if (init?.method === 'PATCH') {
        savedOrganization = {
          ...savedOrganization,
          ...(JSON.parse(String(init.body)) as Partial<typeof organizationSettings>),
        };
        return json(savedOrganization);
      }
      return json(savedOrganization);
    });
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    render(<SettingsClient />);

    await user.type(screen.getByLabelText('Organization ID'), 'org-settings');
    await user.type(screen.getByLabelText('Bearer access token'), 'ephemeral-admin-token');
    await user.click(screen.getByRole('button', { name: 'Load organization settings' }));
    await screen.findByRole('heading', { name: 'Global runtime configuration' });

    const globalEditor = screen.getByLabelText('Global runtime configuration (JSON)');
    expect((globalEditor as HTMLTextAreaElement).value).toBe(
      JSON.stringify(globalConfiguration, null, 2),
    );
    await user.clear(globalEditor);
    fireEvent.change(globalEditor, { target: { value: '{"timeouts":{"http":12345}}' } });
    await user.click(screen.getByRole('button', { name: 'Save global configuration' }));
    await waitFor(() => expect(globalConfiguration).toEqual({ timeouts: { http: 12345 } }));

    await user.clear(screen.getByLabelText('Locale'));
    await user.type(screen.getByLabelText('Locale'), 'pt-BR');
    await user.clear(screen.getByLabelText('Display name'));
    await user.type(screen.getByLabelText('Display name'), 'Acme AI');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Settings saved.');
    expect(savedOrganization).toMatchObject({
      locale: 'pt-BR',
      branding: { displayName: 'Acme AI' },
    });

    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ephemeral-admin-token');
    }
    expect(document.documentElement.dataset.hsTheme).toBe('system');
    expect(document.documentElement.style.getPropertyValue('--hs-primary')).toBe('#2563eb');
    expect(document.body.textContent).not.toContain('ephemeral-admin-token');

    await user.clear(globalEditor);
    fireEvent.change(globalEditor, {
      target: { value: '{"database":{"adapter":"mongodb"}}' },
    });
    await user.click(screen.getByRole('button', { name: 'Save global configuration' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Global configuration must be an object and cannot contain database settings',
    );
    expect(globalConfiguration).toEqual({ timeouts: { http: 12345 } });
  });
});
