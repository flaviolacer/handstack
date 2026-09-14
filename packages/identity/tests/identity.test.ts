import { assertOrganizationScope, normalizeUsername, type User } from '../src/index.js';
import { describe, expect, it } from 'vitest';

describe('identity invariants', () => {
  it('normalizes local usernames canonically', () => {
    expect(normalizeUsername('  Ana.Silva ')).toBe('ana.silva');
    expect(() => normalizeUsername('../')).toThrow(TypeError);
  });

  it('rejects identity data whose repository and organization scopes diverge', () => {
    const user = {
      id: 'user-1',
      tenantId: 'organization-b',
      organizationId: 'organization-a',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      type: 'USER',
      status: 'ACTIVE',
      displayName: 'Ana',
      username: 'ana',
      normalizedUsername: 'ana',
    } satisfies User;
    expect(() => {
      assertOrganizationScope(user);
    }).toThrow(/tenantId/);
  });
});
