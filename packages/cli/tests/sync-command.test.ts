import { describe, expect, it } from 'vitest';
import { executeConfigSyncCommand } from '../src/sync-command.js';

describe('configuration Git sync', () => {
  it('validates the ref, reads the manifest from that ref and applies it', async () => {
    const calls: string[] = [];
    const output: string[] = [];
    process.env.HANDSTACK_API_URL = 'https://api.example.test';
    process.env.HANDSTACK_ORGANIZATION_ID = 'org';
    process.env.HANDSTACK_ACCESS_TOKEN = 'token';
    try {
      await executeConfigSyncCommand(
        ['config', 'sync', '--repo', 'repo', '--ref', 'main', '-f', 'handstack.yaml'],
        {
          verifyRef: (repository, ref) => {
            calls.push(`verify:${repository}:${ref}`);
            return Promise.resolve();
          },
          readAtRef: (repository, ref, path) => {
            calls.push(`read:${repository}:${ref}:${path}`);
            return Promise.resolve(
              'apiVersion: handstack.io/v1\nkind: Policy\nmetadata:\n  name: support-read\nspec:\n  effect: deny\n',
            );
          },
          request: () => Promise.resolve(new Response(null, { status: 201 })),
          output: (value) => output.push(value),
        },
      );
    } finally {
      delete process.env.HANDSTACK_API_URL;
      delete process.env.HANDSTACK_ORGANIZATION_ID;
      delete process.env.HANDSTACK_ACCESS_TOKEN;
    }
    expect(calls).toEqual(['verify:repo:main', 'read:repo:main:handstack.yaml']);
    expect(output).toContain('Applied Policy/support-read');
    expect(output[1]).toContain('Configuration synchronized from repo@main:handstack.yaml');
  });
});
