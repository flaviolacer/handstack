import { IdentityAdministrationService } from '@handstack/identity-service';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { createApplication } from '../src/main.js';

const organizationId = 'http-auth-organization';
const password = 'correct horse battery staple';

function cookieValue(setCookie: string | string[] | undefined): string {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (value === undefined) throw new Error('Set-Cookie header is missing');
  const pair = value.split(';', 1)[0];
  if (pair === undefined) throw new Error('Cookie value is missing');
  return pair;
}

describe('authentication HTTP contract', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET = 'http-test-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'http-test-token-pepper-at-least-32-characters';
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const runtime = app.get(AuthRuntimeService);
    await new IdentityAdministrationService(runtime.storage).createUser(organizationId, {
      id: 'http-auth-user',
      username: 'ana.silva',
      displayName: 'Ana Silva',
    });
    await runtime.authentication.setPassword(organizationId, 'http-auth-user', password);
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
  });

  it('keeps refresh credentials out of the response and rotates the hardened cookie', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { organizationId, username: 'ana.silva', password: 'incorrect password' },
    });
    expect(invalid.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { organizationId, username: 'ana.silva', password },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers['cache-control']).toBe('no-store');
    expect(typeof login.json<{ accessToken: unknown }>().accessToken).toBe('string');
    expect(login.json()).not.toHaveProperty('refreshToken');
    const originalCookie = cookieValue(login.headers['set-cookie']);
    const cookieHeader = String(login.headers['set-cookie']);
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('Secure');
    expect(cookieHeader).toContain('SameSite=Strict');
    expect(cookieHeader).toContain('Path=/auth');

    const csrfRejected = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: originalCookie },
    });
    expect(csrfRejected.statusCode).toBe(403);

    const refreshed = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: originalCookie, 'x-handstack-csrf': '1' },
    });
    expect(refreshed.statusCode).toBe(200);
    const rotatedCookie = cookieValue(refreshed.headers['set-cookie']);
    expect(rotatedCookie).not.toBe(originalCookie);

    const replay = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: originalCookie, 'x-handstack-csrf': '1' },
    });
    expect(replay.statusCode).toBe(401);

    const revokedSuccessor = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: rotatedCookie, 'x-handstack-csrf': '1' },
    });
    expect(revokedSuccessor.statusCode).toBe(401);
  });

  it('populates the authentication context and denies it immediately after logout', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { organizationId, username: 'ana.silva', password },
    });
    const accessToken = login.json<{ accessToken: string }>().accessToken;
    const authorization = { authorization: `Bearer ${accessToken}` };

    const session = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: authorization,
    });
    expect(session.statusCode).toBe(200);
    expect(
      session.json<{ subject: string; organizationId: string; sessionId: string }>(),
    ).toMatchObject({
      subject: 'http-auth-user',
      organizationId,
    });
    expect(typeof session.json<{ sessionId: unknown }>().sessionId).toBe('string');

    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: authorization,
    });
    expect(logout.statusCode).toBe(200);
    expect(String(logout.headers['set-cookie'])).toContain('handstack_refresh=;');

    const denied = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: authorization,
    });
    expect(denied.statusCode).toBe(401);
  });
});
