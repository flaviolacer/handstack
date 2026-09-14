import { describe, expect, it } from 'vitest';
import { HandStack, HandStackApiError, HandStackSdkError, type FetchLike } from '../src/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HandStack SDK client', () => {
  it('rejects empty baseUrl or apiKey at construction', () => {
    expect(() => new HandStack({ baseUrl: '', apiKey: 'hs_live_x' })).toThrow(/baseUrl/);
    expect(() => new HandStack({ baseUrl: 'https://api.test', apiKey: '  ' })).toThrow(/apiKey/);
  });

  it('sends bearer authentication and parses a typed JSON body', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: FetchLike = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(
        jsonResponse({
          object: 'list',
          data: [{ id: 'fast', object: 'model', created: 1, owned_by: 'openai' }],
        }),
      );
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test/',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });
    const result = await client.openai.models.list();
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe('fast');
    expect(calls[0]?.url).toBe('https://api.example.test/v1/models');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer hs_live_x');
  });

  it('maps RFC 9457 problem details into a typed actionable error', async () => {
    const fakeFetch: FetchLike = () =>
      Promise.resolve(
        jsonResponse(
          {
            type: 'https://docs.handstack.dev/problems/rate_limit_exceeded',
            title: 'Rate limit exceeded',
            status: 429,
            detail: 'Too many requests',
            instance: '/v1/chat/completions',
            code: 'rate_limit_exceeded',
            requestId: 'req-1',
            traceId: 'trace-1',
            helpArticleId: 'developer/rate-limits',
          },
          429,
        ),
      );
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });
    const expectation = expect(
      client.openai.chat.completions.create({ model: 'fast', messages: [] }),
    ).rejects;
    await expectation.toBeInstanceOf(HandStackApiError);
    await expectation.toMatchObject({
      status: 429,
      code: 'rate_limit_exceeded',
      requestId: 'req-1',
      helpArticleId: 'developer/rate-limits',
    });
  });

  it('surfaces non-problem error responses as a generic API error', async () => {
    const fakeFetch: FetchLike = () =>
      Promise.resolve(
        new Response('gateway exploded', {
          status: 502,
          headers: { 'content-type': 'text/plain' },
        }),
      );
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });
    await expect(client.openai.models.list()).rejects.toMatchObject({
      status: 502,
      code: 'api_error',
    });
  });

  it('posts capabilities through the governed org-scoped endpoint', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: FetchLike = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(jsonResponse({ ok: true }));
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });
    await client.capabilities.run('acme corp', 'security.review', { repository: 'x/y' });
    expect(calls[0]?.url).toBe(
      'https://api.example.test/api/v1/organizations/acme%20corp/capabilities/security.review/run',
    );
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ repository: 'x/y' }));
  });

  it('streams SSE chunks and stops at the [DONE] sentinel', async () => {
    const stream = [
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"He"},"finish_reason":null}]}',
      '',
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":null}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');
    const fakeFetch: FetchLike = () =>
      Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });
    const parts: string[] = [];
    for await (const chunk of client.openai.chat.completions.stream({
      model: 'fast',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      parts.push(chunk.choices[0]?.delta.content ?? '');
    }
    expect(parts).toEqual(['He', 'llo']);
  });

  it('maps aborted transports to a typed SDK error', async () => {
    const fakeFetch: FetchLike = () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });
    await expect(client.openai.models.list()).rejects.toBeInstanceOf(HandStackSdkError);
  });
});
