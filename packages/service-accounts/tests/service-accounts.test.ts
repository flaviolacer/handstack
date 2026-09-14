import { describe, expect, it } from 'vitest';
import {
  InMemoryServiceAccountStore,
  ServiceAccountError,
  ServiceAccountService,
} from '../src/index.js';

describe('service accounts', () => {
  it('issues an opaque secret once and authenticates a machine principal', async () => {
    const service = new ServiceAccountService(new InMemoryServiceAccountStore());
    const issued = await service.issue({
      organizationId: 'org-1',
      displayName: 'CI',
      scopes: ['models.execute', 'capabilities.run'],
    });
    expect(issued.secret).toMatch(/^hs_sa_org-1\.client_/);
    expect(issued.account.secretHash).not.toContain(issued.secret);
    const principal = await service.authenticate('org-1', issued.account.clientId, issued.secret);
    expect(principal).toMatchObject({
      id: issued.account.id,
      organizationId: 'org-1',
      principalType: 'SERVICE_ACCOUNT',
    });
  });

  it('isolates tenants and invalidates the old secret after rotation or revocation', async () => {
    const service = new ServiceAccountService(new InMemoryServiceAccountStore());
    const issued = await service.issue({
      organizationId: 'org-1',
      displayName: 'Deploy',
      scopes: ['deploy.run'],
    });
    await expect(
      service.authenticate('org-2', issued.account.clientId, issued.secret),
    ).rejects.toThrowError(ServiceAccountError);
    const rotated = await service.rotate('org-1', issued.account.id);
    await expect(
      service.authenticate('org-1', issued.account.clientId, issued.secret),
    ).rejects.toThrowError(ServiceAccountError);
    await service.authenticate('org-1', rotated.account.clientId, rotated.secret);
    await service.revoke('org-1', issued.account.id);
    await expect(
      service.authenticate('org-1', issued.account.clientId, rotated.secret),
    ).rejects.toThrowError(ServiceAccountError);
  });

  it('rejects invalid lifecycle and scopes', async () => {
    const service = new ServiceAccountService(new InMemoryServiceAccountStore());
    await expect(
      service.issue({ organizationId: 'org-1', displayName: '', scopes: ['x'] }),
    ).rejects.toThrow();
    await expect(
      service.issue({ organizationId: 'org-1', displayName: 'bad', scopes: ['x', 'x'] }),
    ).rejects.toThrow();
  });
});
