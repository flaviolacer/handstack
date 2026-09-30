import { describe, expect, it } from 'vitest';
import { executeApplyCommand } from '../src/apply-command.js';

describe('configuration as code apply command', () => {
  it('applies supported YAML resources through the organization API', async () => {
    const calls: { url: string; body: string }[] = [];
    const output: string[] = [];
    const old = {
      url: process.env.HANDSTACK_API_URL,
      organization: process.env.HANDSTACK_ORGANIZATION_ID,
      token: process.env.HANDSTACK_ACCESS_TOKEN,
    };
    process.env.HANDSTACK_API_URL = 'http://localhost:3001';
    process.env.HANDSTACK_ORGANIZATION_ID = 'org-a';
    process.env.HANDSTACK_ACCESS_TOKEN = 'token';
    try {
      await executeApplyCommand(['apply', '-f', 'agent.yaml'], {
        read: () =>
          Promise.resolve(
            '- apiVersion: handstack.io/v1\n  kind: Group\n  metadata:\n    name: Engineering\n  spec:\n    name: Engineering\n- apiVersion: handstack.io/v1\n  kind: Policy\n  metadata:\n    name: support-read\n  spec:\n    principalIds: [user-1]\n    resource: support\n    action: read\n    effect: allow\n',
          ),
        output: (value) => output.push(value),
        request: (url, init) => {
          calls.push({ url, body: typeof init.body === 'string' ? init.body : '' });
          return Promise.resolve(new Response('{}', { status: 201 }));
        },
      });
    } finally {
      if (old.url === undefined) delete process.env.HANDSTACK_API_URL;
      else process.env.HANDSTACK_API_URL = old.url;
      if (old.organization === undefined) delete process.env.HANDSTACK_ORGANIZATION_ID;
      else process.env.HANDSTACK_ORGANIZATION_ID = old.organization;
      if (old.token === undefined) delete process.env.HANDSTACK_ACCESS_TOKEN;
      else process.env.HANDSTACK_ACCESS_TOKEN = old.token;
    }
    expect(calls[0]?.url).toBe('http://localhost:3001/api/v1/organizations/org-a/groups');
    expect(calls[0]?.body).toContain('Engineering');
    expect(calls[1]?.url).toBe('http://localhost:3001/api/v1/organizations/org-a/policies');
    expect(calls[1]?.body).toContain('support');
    expect(output).toEqual(['Applied Group/Engineering', 'Applied Policy/support-read']);
  });

  it('rejects resources without a supported API endpoint', async () => {
    await expect(
      executeApplyCommand(['apply', '-f', 'unknown.yaml'], {
        read: () => Promise.resolve('apiVersion: handstack.io/v1\nkind: Unknown\nspec: {}'),
        output: () => undefined,
        request: () => Promise.resolve(new Response('{}', { status: 201 })),
      }),
    ).rejects.toThrow('Unsupported apply resource: Unknown');
  });

  it('rejects resources without metadata.name before contacting the API', async () => {
    let requests = 0;
    await expect(
      executeApplyCommand(['apply', '-f', 'unnamed.yaml'], {
        read: () => Promise.resolve('apiVersion: handstack.io/v1\nkind: Policy\nspec: {}'),
        output: () => undefined,
        request: () => {
          requests += 1;
          return Promise.resolve(new Response('{}', { status: 201 }));
        },
      }),
    ).rejects.toThrow('Policy metadata.name is required');
    expect(requests).toBe(0);
  });

  it('rejects duplicate kind/name resources before contacting the API', async () => {
    let requests = 0;
    await expect(
      executeApplyCommand(['apply', '-f', 'duplicates.yaml'], {
        read: () =>
          Promise.resolve(
            '- apiVersion: handstack.io/v1\n  kind: Policy\n  metadata:\n    name: support-read\n  spec: {}\n- apiVersion: handstack.io/v1\n  kind: Policy\n  metadata:\n    name: support-read\n  spec:\n    effect: deny\n',
          ),
        output: () => undefined,
        request: () => {
          requests += 1;
          return Promise.resolve(new Response('{}', { status: 201 }));
        },
      }),
    ).rejects.toThrow('Policy/support-read is duplicated');
    expect(requests).toBe(0);
  });
});
