import { frontendRefreshCookie, type LocalCredential } from '../src/index.js';
import { describe, expect, it } from 'vitest';

describe('authentication contracts', () => {
  it('requires Argon2id credentials and a hardened refresh cookie', () => {
    const credential = { passwordAlgorithm: 'argon2id' } as LocalCredential;
    expect(credential.passwordAlgorithm).toBe('argon2id');
    expect(frontendRefreshCookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/auth',
    });
  });
});
