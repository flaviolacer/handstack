import { describe, expect, it } from 'vitest';
import { AuthorizationError, toProblemDetails } from '../src/index.js';

describe('toProblemDetails', () => {
  it('maps typed errors without leaking internal details', () => {
    const problem = toProblemDetails(new AuthorizationError('Policy denied the action.'), {
      instance: '/api/v1/capabilities/demo/run',
      requestId: 'request-1',
      traceId: 'trace-1',
    });

    expect(problem).toMatchObject({ status: 403, code: 'authorization_denied' });
  });

  it('sanitizes unknown errors', () => {
    const problem = toProblemDetails(new Error('secret database detail'), {
      instance: '/health',
      requestId: 'request-2',
      traceId: 'trace-2',
    });

    expect(problem.detail).toBe('An unexpected error occurred.');
  });
});
