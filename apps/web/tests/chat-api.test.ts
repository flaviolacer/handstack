import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatApi, streamEvents } from '../app/chat/chat-api.js';

describe('chat browser client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('scopes history and keeps the bearer token out of the URL', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await chatApi(
      { organizationId: 'org/a', accessToken: 'secret-token' },
      'https://api.example',
    ).history('conversation/1', 'branch/1');
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.example/api/v1/organizations/org%2Fa/conversations/conversation%2F1/branches/branch%2F1/messages?limit=50',
    );
    expect(url).not.toContain('secret-token');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-token');
  });

  it('uploads multipart without forcing a JSON content type', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'attachment-1' }), { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    await chatApi({ organizationId: 'org', accessToken: 'token' }).upload(
      'conversation',
      new File(['hello'], 'note.txt', { type: 'text/plain' }),
    );
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
    expect(new Headers(init.headers).has('content-type')).toBe(false);
  });

  it('starts regenerate and retry with idempotency and an explicit classification', async () => {
    const fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ branch: { id: 'branch' }, message: { id: 'message' } }), {
          status: 201,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const api = chatApi({ organizationId: 'org', accessToken: 'token' });
    await api.regenerate('conversation', 'assistant', 'model-2');
    await api.retry('conversation', 'failed');
    const regenerate = fetch.mock.calls[0]?.[1] as RequestInit;
    const retry = fetch.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(regenerate.headers).get('Idempotency-Key')).toBeTruthy();
    expect(JSON.parse(String(regenerate.body))).toEqual({
      model: 'model-2',
      dataClassification: 'INTERNAL',
    });
    expect(new Headers(retry.headers).get('Idempotency-Key')).toBeTruthy();
    expect(JSON.parse(String(retry.body))).toEqual({ dataClassification: 'INTERNAL' });
  });

  it('parses SSE frames, ignores heartbeats and stops at terminal', async () => {
    const body =
      ': heartbeat\n\nid: 1\nevent: delta\ndata: {"sequence":1,"type":"DELTA","part":{"id":"p","type":"text","text":"Hi"}}\n\nid: 2\nevent: completed\ndata: {"sequence":2,"type":"COMPLETED"}\n\n';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        ),
    );
    const events = [];
    for await (const event of streamEvents('/events', 'token', 0, new AbortController().signal))
      events.push(event);
    expect(events.map((event) => event.type)).toEqual(['DELTA', 'COMPLETED']);
  });

  it('reconnects from the committed cursor and deduplicates replayed events', async () => {
    const first =
      'id: 1\nevent: delta\ndata: {"sequence":1,"type":"DELTA","part":{"id":"p","type":"text","text":"Hi"}}\n\n';
    const second = `${first}id: 2\nevent: completed\ndata: {"sequence":2,"type":"COMPLETED"}\n\n`;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(first, { status: 200 }))
      .mockResolvedValueOnce(new Response(second, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const events = [];
    for await (const event of streamEvents('/events', 'token', 0, new AbortController().signal))
      events.push(event);
    expect(events.map(({ sequence }) => sequence)).toEqual([1, 2]);
    expect(
      new Headers((fetch.mock.calls[1]?.[1] as RequestInit).headers).get('Last-Event-ID'),
    ).toBe('1');
  });
});
