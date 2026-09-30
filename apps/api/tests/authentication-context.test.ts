import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { requestTraceContext } from '../src/auth/authentication-context.js';

describe('request trace context', () => {
  it('accepts bounded diagnostic headers and falls back from unsafe values', () => {
    const request = {
      id: 'server-request-1',
      headers: {
        'x-request-id': 'caller-request-1',
        'x-trace-id': 'caller-trace-1',
      },
    } as unknown as FastifyRequest;
    expect(requestTraceContext(request)).toEqual({
      requestId: 'caller-request-1',
      traceId: 'caller-trace-1',
    });

    const unsafe = {
      id: 'server-request-2',
      headers: {
        'x-request-id': 'caller request with spaces',
        'x-trace-id': ['multiple', 'values'],
      },
    } as unknown as FastifyRequest;
    expect(requestTraceContext(unsafe)).toEqual({
      requestId: 'server-request-2',
      traceId: 'server-request-2',
    });
  });
});
