import { afterEach, describe, expect, it, vi } from 'vitest';
import { identityApi } from '../app/settings/identity-providers/identity-api.js';

describe('identity administration browser client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('scopes requests and keeps authorization out of the URL and body', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    await identityApi(
      { organizationId: 'acme / south', accessToken: 'private-token' },
      'https://api.test',
    ).providers();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/organizations/acme%20%2F%20south/identity/providers');
    expect(url).not.toContain('private-token');
    expect(init.headers).toMatchObject({ authorization: 'Bearer private-token' });
    expect(init.body).toBeUndefined();
    expect(init.cache).toBe('no-store');
  });

  it('serializes only explicit allowlisted mappings', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    await identityApi({ organizationId: 'acme', accessToken: 'token' }).setMappings('provider', [
      {
        sourceClaim: 'groups',
        sourceValue: 'engineering',
        targetType: 'GROUP',
        targetId: 'engineers',
        enabled: true,
      },
    ]);
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual([
      {
        sourceClaim: 'groups',
        sourceValue: 'engineering',
        targetType: 'GROUP',
        targetId: 'engineers',
        enabled: true,
      },
    ]);
    expect(String(init.body)).not.toContain('token');
  });

  it('starts a connection test without sending provider configuration or credentials', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, stage: 'COMPLETE', code: 'CONNECTED' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetch);
    await identityApi({ organizationId: 'acme', accessToken: 'private-token' }).testConnection(
      'provider / one',
    );
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/providers/provider%20%2F%20one/test-connection');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(url).not.toContain('private-token');
  });
});
