import { describe, expect, it } from 'vitest';
import { executeExportCommand } from '../src/export-command.js';

describe('configuration as code export command', () => {
  it('rejects a missing output path before contacting the API', async () => {
    let requests = 0;
    await expect(
      executeExportCommand(['export'], {
        request: () => {
          requests += 1;
          return Promise.resolve(new Response('{}'));
        },
        write: () => Promise.resolve(),
        output: () => undefined,
      }),
    ).rejects.toThrow('-o is required');
    expect(requests).toBe(0);
  });

  it('exports sanitized resources as handstack manifests', async () => {
    let written = '';
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
      await executeExportCommand(['export', '-o', 'config.yaml', '--resource', 'Agent,Provider'], {
        request: (url) => {
          if (url.endsWith('/agents'))
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  items: [{ id: 'id', slug: 'helper', name: 'Helper', token: 'do-not-export' }],
                }),
                { status: 200 },
              ),
            );
          expect(url).toContain('/api/v1/organizations/org-a/providers');
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        },
        write: (_path, content) => {
          written = content;
          return Promise.resolve();
        },
        output: (value) => output.push(value),
      });
    } finally {
      if (old.url === undefined) delete process.env.HANDSTACK_API_URL;
      else process.env.HANDSTACK_API_URL = old.url;
      if (old.organization === undefined) delete process.env.HANDSTACK_ORGANIZATION_ID;
      else process.env.HANDSTACK_ORGANIZATION_ID = old.organization;
      if (old.token === undefined) delete process.env.HANDSTACK_ACCESS_TOKEN;
      else process.env.HANDSTACK_ACCESS_TOKEN = old.token;
    }
    expect(written).toContain('kind: Agent');
    expect(written).toContain('name: helper');
    expect(written).not.toContain('do-not-export');
    expect(output).toEqual(['Configuration export written: config.yaml (1 resources)']);
  });
});
