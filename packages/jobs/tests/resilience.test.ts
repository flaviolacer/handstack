import { describe, expect, it } from 'vitest';
import { BackpressureError, InMemoryJobQueue } from '../src/index.js';

describe('offline resilience scenarios', () => {
  it('keeps spike admission bounded and exposes retry guidance', () => {
    const queue = new InMemoryJobQueue('agents', { maxBacklog: 10, retryAfterSeconds: 7 });
    for (let index = 0; index < 10; index += 1) {
      queue.enqueue({
        id: `spike-${String(index)}`,
        payload: { index },
        idempotencyKey: `spike-${String(index)}`,
      });
    }
    expect(() =>
      queue.enqueue({ id: 'rejected', payload: {}, idempotencyKey: 'rejected' }),
    ).toThrowError(BackpressureError);
    try {
      queue.enqueue({ id: 'rejected-again', payload: {}, idempotencyKey: 'rejected-again' });
    } catch (error) {
      expect(error).toMatchObject({ code: 'JOB_BACKPRESSURE', retryAfterSeconds: 7 });
    }
    expect(queue.backlog).toBe(10);
  });

  it('does not duplicate a side effect when the same idempotency key is retried', async () => {
    const queue = new InMemoryJobQueue('webhooks', {
      maxAttempts: 2,
      retryBaseMs: 0,
      retryJitterMs: 0,
    });
    const job = queue.enqueue({ id: 'side-effect', payload: {}, idempotencyKey: 'stable-key' });
    expect(queue.enqueue({ id: 'different-id', payload: {}, idempotencyKey: 'stable-key' })).toBe(
      job,
    );
    let effects = 0;
    await queue.process(() => {
      effects += 1;
      throw new Error('worker crash after effect');
    });
    await queue.process(() => {
      effects += 1;
      throw new Error('worker crash after effect');
    });
    expect(effects).toBe(2);
    expect(queue.listDeadLetters()).toHaveLength(1);
    expect(queue.listDeadLetters()[0]?.job.idempotencyKey).toBe('stable-key');
  });

  it('retains accepted jobs in the dead-letter path after repeated failure', async () => {
    const queue = new InMemoryJobQueue('cleanup', {
      maxAttempts: 3,
      retryBaseMs: 0,
      retryJitterMs: 0,
    });
    queue.enqueue({ id: 'accepted', payload: {}, idempotencyKey: 'accepted' });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await queue.process(() => Promise.reject(new Error('dependency unavailable')));
    }
    expect(queue.backlog).toBe(0);
    expect(queue.listDeadLetters()).toMatchObject([
      { job: { id: 'accepted', attempts: 3 }, error: 'dependency unavailable' },
    ]);
  });
});
