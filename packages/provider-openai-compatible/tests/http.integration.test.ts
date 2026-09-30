import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { verifyLLMProviderContract } from '@handstack/provider-testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider } from '../src/index.js';

const completion = {
  choices: [
    {
      message: { content: 'hello', tool_calls: [] },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 4, completion_tokens: 2 },
};

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function handler(_request: IncomingMessage, response: ServerResponse): void {
  if (_request.url?.endsWith('/models')) {
    json(response, { data: [{ id: 'loopback-model' }] });
    return;
  }
  if (_request.url?.endsWith('/chat/completions')) {
    if (_request.method === 'POST') {
      let body = '';
      _request.setEncoding('utf8');
      _request.on('data', (chunk: string) => (body += chunk));
      _request.on('end', () => {
        const request = JSON.parse(body) as { stream?: boolean };
        if (request.stream === true) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(
            [
              'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}',
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1}}',
              'data: [DONE]',
              '',
            ].join('\n'),
          );
          return;
        }
        json(response, completion);
      });
      return;
    }
  }
  response.writeHead(404);
  response.end();
}

describe('OpenAI-compatible HTTP boundary', () => {
  const server = createServer(handler);
  let baseUrl = '';

  beforeAll(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Server did not bind');
    baseUrl = `http://127.0.0.1:${String(address.port)}/v1`;
  });

  afterAll(() => server.close());

  it('passes the provider contract over real loopback HTTP', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl,
      allowInsecureLocalhost: true,
      now: () => new Date(0),
    });
    const report = await verifyLLMProviderContract(provider);
    expect(report.models).toEqual(['loopback-model']);
    expect(report.response).toMatchObject({
      content: 'hello',
      finishReason: 'stop',
      usage: { inputTokens: 4, outputTokens: 2 },
    });
    expect(report.events).toEqual([
      { type: 'content', delta: 'hello' },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 1 } },
      { type: 'done', finishReason: 'stop' },
    ]);
  });
});
