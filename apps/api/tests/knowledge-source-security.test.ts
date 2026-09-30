import { describe, expect, it } from 'vitest';
import { assertSafeKnowledgeUrl } from '../src/knowledge/knowledge-runtime.service.js';

describe('knowledge source SSRF protection', () => {
  it('rejects non-HTTPS URLs and embedded credentials', async () => {
    await expect(assertSafeKnowledgeUrl('http://example.com')).rejects.toThrow('HTTPS');
    await expect(assertSafeKnowledgeUrl('https://user:password@example.com')).rejects.toThrow(
      'HTTPS',
    );
  });

  it('rejects loopback and private addresses before fetching', async () => {
    await expect(assertSafeKnowledgeUrl('https://127.0.0.1')).rejects.toThrow('private or local');
    await expect(assertSafeKnowledgeUrl('https://localhost')).rejects.toThrow('private or local');
  });
});
