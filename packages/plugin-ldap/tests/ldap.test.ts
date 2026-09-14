import { describe, expect, it } from 'vitest';
import { LdapIdentityProvider, type LdapProviderConfig } from '../src/index.js';

const config: LdapProviderConfig = {
  organizationId: 'org-a',
  providerId: 'ldap-a',
  url: 'ldaps://directory.example:636',
  baseDn: 'dc=example,dc=com',
  bindIdentityReference: 'secret://ldap/bind',
  userSearchFilter: '(uid={username})',
};
describe('LDAP protocol boundary', () => {
  it('requires LDAPS and secret references', async () => {
    const provider = new LdapIdentityProvider({
      bind: () => Promise.resolve(),
      search: () => Promise.resolve({ uid: 'u', cn: 'User' }),
      unbind: () => Promise.resolve(),
    });
    await expect(
      provider.authenticate({ ...config, url: 'ldap://directory.example' }, 'u', 'secret://user'),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    await expect(provider.authenticate(config, 'u', 'password=inline')).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });
  });
  it('returns a tenant-scoped normalized identity through the injected transport', async () => {
    const provider = new LdapIdentityProvider({
      bind: () => Promise.resolve(),
      search: () => Promise.resolve({ uid: 'u', cn: 'User', mail: 'u@example.test' }),
      unbind: () => Promise.resolve(),
    });
    await expect(provider.authenticate(config, 'u', 'secret://user')).resolves.toMatchObject({
      organizationId: 'org-a',
      providerId: 'ldap-a',
      username: 'u',
      email: 'u@example.test',
    });
  });
});
