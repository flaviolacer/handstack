import { afterEach, describe, expect, it, vi } from 'vitest';
import { testOidcConnection } from '../src/auth/oidc-runtime.service.js';

const issuer = 'https://identity.example.test';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OIDC connection diagnostics', () => {
  afterEach(() => vi.useRealTimers());

  it('validates discovery and a non-empty JWKS', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        }),
      )
      .mockResolvedValueOnce(json({ keys: [{ kty: 'RSA', kid: 'primary' }] }));
    await expect(testOidcConnection(issuer, transport)).resolves.toEqual({
      ok: true,
      stage: 'COMPLETE',
      code: 'CONNECTED',
    });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });

  it.each([
    [
      'issuer mismatch',
      {
        issuer: 'https://other.test',
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      },
      'ISSUER_MISMATCH',
    ],
    [
      'insecure endpoint',
      {
        issuer,
        authorization_endpoint: 'http://identity.example.test/authorize',
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      },
      'INSECURE_ENDPOINT',
    ],
  ])('redacts a %s', async (_name, discovery, code) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(json(discovery));
    const result = await testOidcConnection(issuer, transport);
    expect(result).toEqual({ ok: false, stage: 'DISCOVERY', code });
    expect(JSON.stringify(result)).not.toContain('identity.example.test');
  });

  it('rejects an empty JWKS with a closed result', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        }),
      )
      .mockResolvedValueOnce(json({ keys: [] }));
    await expect(testOidcConnection(issuer, transport)).resolves.toEqual({
      ok: false,
      stage: 'JWKS',
      code: 'JWKS_EMPTY',
    });
  });

  it('aborts a stalled discovery request after the bounded timeout', async () => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('private transport detail', 'AbortError'));
          });
        }),
    );
    const pending = testOidcConnection(issuer, transport);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual({ ok: false, stage: 'DISCOVERY', code: 'TIMEOUT' });
  });
});
