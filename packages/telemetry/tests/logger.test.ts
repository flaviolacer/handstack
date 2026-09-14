import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/index.js';

describe('structured logger', () => {
  it('redacts common credential fields', () => {
    let output = '';
    const destination = new Writable({
      write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        callback();
      },
    });
    createLogger({ name: 'test' }, destination).info(
      { apiKey: 'hs_live_secret', authorization: 'Bearer secret' },
      'credential test',
    );
    expect(output).not.toContain('hs_live_secret');
    expect(output).not.toContain('Bearer secret');
    expect(output).toContain('[REDACTED]');
  });
});
