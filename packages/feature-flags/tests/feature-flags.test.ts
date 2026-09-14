import { describe, expect, it } from 'vitest';
import { InMemoryFeatureFlagService } from '../src/index.js';

describe('feature flags', () => {
  it('resolves user, organization and global precedence including false overrides', () => {
    const service = new InMemoryFeatureFlagService();
    service.set({ key: 'new-ui', scope: 'global', enabled: true });
    service.set({ key: 'new-ui', scope: 'organization', organizationId: 'org-a', enabled: false });
    service.set({
      key: 'new-ui',
      scope: 'user',
      organizationId: 'org-a',
      userId: 'u-1',
      enabled: true,
    });
    expect(service.isEnabled('new-ui', { organizationId: 'org-a', userId: 'u-1' })).toBe(true);
    expect(service.isEnabled('new-ui', { organizationId: 'org-a', userId: 'u-2' })).toBe(false);
    expect(service.isEnabled('new-ui', { organizationId: 'org-b', userId: 'u-2' })).toBe(true);
  });

  it('rejects ambiguous scopes and isolates user records by organization', () => {
    const service = new InMemoryFeatureFlagService();
    expect(() => service.set({ key: 'x', scope: 'user', userId: 'u', enabled: true })).toThrow(
      /organizationId/,
    );
    service.set({ key: 'x', scope: 'user', organizationId: 'org-a', userId: 'u', enabled: true });
    expect(service.isEnabled('x', { organizationId: 'org-b', userId: 'u' })).toBe(false);
    expect(service.remove({ key: 'x', scope: 'user', organizationId: 'org-a', userId: 'u' })).toBe(
      true,
    );
  });
});
