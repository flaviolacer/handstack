import { isIdentityProviderCapability } from '../src/index.js';
import { describe, expect, it } from 'vitest';

describe('identity provider capabilities', () => {
  it('accepts only namespaced provider capabilities', () => {
    expect(isIdentityProviderCapability('identity.oidc')).toBe(true);
    expect(isIdentityProviderCapability('identity.provider.admin')).toBe(false);
  });
});
