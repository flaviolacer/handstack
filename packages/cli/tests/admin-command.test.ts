import { describe, expect, it } from 'vitest';
import { executeAdminCommand } from '../src/admin-command.js';

describe('organization CLI commands', () => {
  it('lists agents through the authenticated organization API', async () => {
    const original = {
      url: process.env.HANDSTACK_API_URL,
      organization: process.env.HANDSTACK_ORGANIZATION_ID,
      token: process.env.HANDSTACK_ACCESS_TOKEN,
    };
    process.env.HANDSTACK_API_URL = 'http://localhost:3001';
    process.env.HANDSTACK_ORGANIZATION_ID = 'org/a';
    process.env.HANDSTACK_ACCESS_TOKEN = 'token';
    const calls: { url: string; method?: string; authorization?: string }[] = [];
    try {
      await executeAdminCommand(['agent', 'list'], {
        request: (url, init) => {
          const authorization =
            init?.headers instanceof Headers ? init.headers.get('authorization') : null;
          calls.push({
            url,
            ...(init?.method === undefined ? {} : { method: init.method }),
            ...(authorization === null ? {} : { authorization }),
          });
          return Promise.resolve(new Response('{"items":[]}', { status: 200 }));
        },
        output: () => undefined,
      });
    } finally {
      if (original.url === undefined) delete process.env.HANDSTACK_API_URL;
      else process.env.HANDSTACK_API_URL = original.url;
      if (original.organization === undefined) delete process.env.HANDSTACK_ORGANIZATION_ID;
      else process.env.HANDSTACK_ORGANIZATION_ID = original.organization;
      if (original.token === undefined) delete process.env.HANDSTACK_ACCESS_TOKEN;
      else process.env.HANDSTACK_ACCESS_TOKEN = original.token;
    }
    expect(calls[0]).toMatchObject({
      url: 'http://localhost:3001/api/v1/organizations/org%2Fa/agents',
      method: 'GET',
    });
  });

  it('requires JSON input when creating a user', async () => {
    await expect(
      executeAdminCommand(['user', 'create'], {
        request: () => Promise.reject(new Error('unexpected')),
        output: () => undefined,
      }),
    ).rejects.toThrow('--data');
  });

  it('installs a plugin through the tenant-scoped API', async () => {
    const original = {
      url: process.env.HANDSTACK_API_URL,
      organization: process.env.HANDSTACK_ORGANIZATION_ID,
      token: process.env.HANDSTACK_ACCESS_TOKEN,
    };
    process.env.HANDSTACK_API_URL = 'http://localhost:3001';
    process.env.HANDSTACK_ORGANIZATION_ID = 'org-a';
    process.env.HANDSTACK_ACCESS_TOKEN = 'token';
    const calls: { url: string; body?: string }[] = [];
    try {
      await executeAdminCommand(['plugin', 'install', '--data', '{"manifest":{}}'], {
        request: (url, init) => {
          calls.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
          return Promise.resolve(new Response('{"installed":true}', { status: 201 }));
        },
        output: () => undefined,
      });
    } finally {
      if (original.url === undefined) delete process.env.HANDSTACK_API_URL;
      else process.env.HANDSTACK_API_URL = original.url;
      if (original.organization === undefined) delete process.env.HANDSTACK_ORGANIZATION_ID;
      else process.env.HANDSTACK_ORGANIZATION_ID = original.organization;
      if (original.token === undefined) delete process.env.HANDSTACK_ACCESS_TOKEN;
      else process.env.HANDSTACK_ACCESS_TOKEN = original.token;
    }
    expect(calls[0]).toMatchObject({
      url: 'http://localhost:3001/api/v1/organizations/org-a/plugins',
      body: '{"manifest":{}}',
    });
  });

  it('reconnects an MCP server through the authenticated management API', async () => {
    const original = {
      url: process.env.HANDSTACK_API_URL,
      organization: process.env.HANDSTACK_ORGANIZATION_ID,
      token: process.env.HANDSTACK_ACCESS_TOKEN,
    };
    process.env.HANDSTACK_API_URL = 'http://localhost:3001';
    process.env.HANDSTACK_ORGANIZATION_ID = 'org-a';
    process.env.HANDSTACK_ACCESS_TOKEN = 'token';
    const calls: { url: string; method?: string }[] = [];
    try {
      await executeAdminCommand(['mcp', 'reconnect', '--server', 'server/1'], {
        request: (url, init) => {
          calls.push({ url, ...(init?.method === undefined ? {} : { method: init.method }) });
          return Promise.resolve(new Response('{"reconnected":true}', { status: 201 }));
        },
        output: () => undefined,
      });
    } finally {
      if (original.url === undefined) delete process.env.HANDSTACK_API_URL;
      else process.env.HANDSTACK_API_URL = original.url;
      if (original.organization === undefined) delete process.env.HANDSTACK_ORGANIZATION_ID;
      else process.env.HANDSTACK_ORGANIZATION_ID = original.organization;
      if (original.token === undefined) delete process.env.HANDSTACK_ACCESS_TOKEN;
      else process.env.HANDSTACK_ACCESS_TOKEN = original.token;
    }
    expect(calls[0]).toEqual({
      url: 'http://localhost:3001/mcp/servers/org-a/server%2F1/reconnect',
      method: 'POST',
    });
  });
});
