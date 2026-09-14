import { describe, expect, it } from 'vitest';
import { isUuidV7, uuidV7 } from '../src/index.js';

describe('uuidV7', () => {
  it('produces RFC 9562 version and variant bits', () => {
    for (let index = 0; index < 100; index += 1) {
      expect(isUuidV7(uuidV7())).toBe(true);
    }
  });

  it('is lexicographically monotonic within one millisecond', () => {
    const values = Array.from({ length: 100 }, () => uuidV7(1_700_000_000_000));
    expect([...values].sort()).toEqual(values);
    expect(new Set(values).size).toBe(values.length);
  });

  it('rejects timestamps outside the UUIDv7 field', () => {
    expect(() => uuidV7(-1)).toThrow(RangeError);
    expect(() => uuidV7(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });
});
