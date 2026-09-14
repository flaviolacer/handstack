import { afterEach, describe, expect, it, vi } from 'vitest';
import { deadLetterApi } from '../app/operations/dead-letters/dead-letter-api.js';

describe('dead-letter operations browser client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('scopes inspection to the encoded organization and selected queue', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await deadLetterApi(
      { organizationId: 'acme / south', accessToken: 'private-token' },
      'https://api.test',
    ).deadLetters('agents');
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/organizations/acme%20%2F%20south/jobs/agents/dead-letters');
    expect(url).not.toContain('private-token');
    expect(init.headers).toMatchObject({ authorization: 'Bearer private-token' });
    expect(init.cache).toBe('no-store');
  });

  it('uses retry and discard methods with encoded idempotency keys', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ job: { id: 'job-1' } }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ discarded: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const api = deadLetterApi({ organizationId: 'acme', accessToken: 'token' });
    await api.retryDeadLetter('audit', 'job / 42');
    await api.discardDeadLetter('audit', 'job / 42');
    expect(fetch.mock.calls[0]?.[0]).toContain('/audit/dead-letters/job%20%2F%2042/retry');
    expect((fetch.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    expect(fetch.mock.calls[1]?.[0]).toContain('/audit/dead-letters/job%20%2F%2042');
    expect((fetch.mock.calls[1]?.[1] as RequestInit).method).toBe('DELETE');
  });

  it('surfaces permission failures without retrying or leaking the token', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'jobs.manage permission is required' }), {
        status: 403,
      }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      deadLetterApi({ organizationId: 'acme', accessToken: 'private-token' }).discardDeadLetter(
        'agents',
        'job-1',
      ),
    ).rejects.toMatchObject({ status: 403, message: 'jobs.manage permission is required' });
    expect(String(fetch.mock.calls[0]?.[0])).not.toContain('private-token');
  });
});
