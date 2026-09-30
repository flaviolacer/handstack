import { describe, expect, it } from 'vitest';
import {
  BearerKnowledgeSourceConnector,
  confluencePageUrl,
  extractConfluenceText,
  extractNotionText,
  GitHubKnowledgeSourceConnector,
  googleDriveFileUrl,
  HttpKnowledgeSourceConnector,
  normalizeGitHubLocator,
  notionPageUrl,
  parseS3KnowledgeLocator,
  S3KnowledgeSourceConnector,
  sharePointItemUrl,
} from '../src/index.js';

describe('knowledge source connectors', () => {
  it('normalizes public GitHub blob URLs to raw content', () => {
    expect(normalizeGitHubLocator('https://github.com/acme/docs/blob/main/readme.md')).toBe(
      'https://raw.githubusercontent.com/acme/docs/main/readme.md',
    );
  });

  it('guards and bounds GitHub fetches', async () => {
    const guarded: string[] = [];
    const connector = new GitHubKnowledgeSourceConnector(
      (url) => {
        guarded.push(url);
        return Promise.resolve();
      },
      () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('content') }),
    );
    await expect(
      connector.fetch('https://github.com/acme/docs/blob/main/readme.md'),
    ).resolves.toEqual({ content: 'content' });
    expect(guarded).toEqual(['https://raw.githubusercontent.com/acme/docs/main/readme.md']);
  });

  it('builds authenticated SaaS locators and never falls back to inline credentials', async () => {
    expect(googleDriveFileUrl('drive://file-123')).toBe(
      'https://www.googleapis.com/drive/v3/files/file-123?alt=media',
    );
    expect(sharePointItemUrl('sharepoint://drive-1/item-2')).toContain(
      '/drives/drive-1/items/item-2/content',
    );
    expect(notionPageUrl('notion://page-123')).toContain('/blocks/page-123/children');
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const connector = new BearerKnowledgeSourceConnector(
      'knowledge-google-drive',
      googleDriveFileUrl,
      () => Promise.resolve(),
      (_organizationId, reference, connectorId) => {
        expect(reference).toBe('secret://drive-token');
        expect(connectorId).toBe('knowledge-google-drive');
        return Promise.resolve('vault-token');
      },
      new HttpKnowledgeSourceConnector(
        () => Promise.resolve(),
        (url, init) => {
          requests.push({ url, headers: init.headers });
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve('private content'),
          });
        },
      ),
    );
    await expect(
      connector.fetch({
        organizationId: 'org-a',
        locator: 'drive://file-123',
        credentialReference: 'secret://drive-token',
      }),
    ).resolves.toEqual({ content: 'private content' });
    expect(requests[0]).toMatchObject({ headers: { authorization: 'Bearer vault-token' } });
  });

  it('normalizes Confluence and Notion API responses before indexing', () => {
    expect(confluencePageUrl('confluence://docs.example.com/123')).toContain(
      '/wiki/rest/api/content/123',
    );
    expect(
      extractConfluenceText('{"body":{"storage":{"value":"<p>Hello <strong>world</strong></p>"}}}'),
    ).toBe('Hello world');
    expect(
      extractNotionText('{"results":[{"paragraph":{"rich_text":[{"plain_text":"Hello"}]}}]}'),
    ).toBe('Hello');
  });

  it('applies a connector-specific response transform after authenticated fetch', async () => {
    const connector = new BearerKnowledgeSourceConnector(
      'knowledge-confluence',
      confluencePageUrl,
      () => Promise.resolve(),
      () => Promise.resolve('confluence-token'),
      new HttpKnowledgeSourceConnector(
        () => Promise.resolve(),
        (_url, init) =>
          Promise.resolve({
            ok: init.headers.authorization === 'Bearer confluence-token',
            status: 200,
            text: () => Promise.resolve('{"body":{"storage":{"value":"<p>Secure page</p>"}}}'),
          }),
      ),
      extractConfluenceText,
    );
    await expect(
      connector.fetch({
        organizationId: 'org-a',
        locator: 'confluence://docs.example.com/123',
        credentialReference: 'secret://confluence',
      }),
    ).resolves.toEqual({ content: 'Secure page' });
  });

  it('fetches S3 objects with vault credentials and returns the provider version', async () => {
    let requested: { Bucket?: string; Key?: string } | undefined;
    const connector = new S3KnowledgeSourceConnector(
      (_organizationId, reference) => {
        expect(reference).toBe('secret://s3');
        return Promise.resolve(
          JSON.stringify({ region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret' }),
        );
      },
      () =>
        ({
          send: (command: { input: { Bucket?: string; Key?: string } }) => {
            requested = command.input;
            return Promise.resolve({
              ETag: '"v1"',
              Body: { transformToString: () => Promise.resolve('s3 content') },
            });
          },
        }) as never,
    );
    await expect(
      connector.fetch({
        organizationId: 'org-a',
        locator: 's3://bucket/docs/a.txt',
        credentialReference: 'secret://s3',
      }),
    ).resolves.toEqual({ content: 's3 content', sourceVersion: '"v1"' });
    expect(requested).toEqual({ Bucket: 'bucket', Key: 'docs/a.txt' });
    expect(parseS3KnowledgeLocator('s3://bucket/docs/a.txt')).toEqual({
      bucket: 'bucket',
      key: 'docs/a.txt',
    });
  });
});
