import { describe, expect, it } from 'vitest';
import {
  InMemoryReplayStore,
  SamlIdentityProvider,
  type SamlProviderConfig,
} from '../src/index.js';

const config: SamlProviderConfig = {
  organizationId: 'org-a',
  providerId: 'idp-a',
  issuer: 'https://idp.example/issuer',
  ssoUrl: 'https://idp.example/sso',
  audience: 'handstack',
  certificateFingerprint: 'sha256:abc',
};
const assertion = () => ({
  organizationId: 'org-a',
  providerId: 'idp-a',
  subject: 'user-1',
  claims: {},
  issuedAt: new Date(),
  expiresAt: new Date(Date.now() + 10_000),
  assertionId: 'assertion-1',
});

describe('SAML protocol boundary', () => {
  it('validates scope and rejects replay', async () => {
    const provider = new SamlIdentityProvider(
      { verify: () => Promise.resolve(assertion()) },
      new InMemoryReplayStore(),
    );
    await provider.authenticate(config, '<signed-response>');
    await expect(provider.authenticate(config, '<signed-response>')).rejects.toMatchObject({
      code: 'REPLAYED_ASSERTION',
    });
  });
  it('requires HTTPS endpoints', () =>
    expect(
      new SamlIdentityProvider(
        { verify: () => Promise.resolve(assertion()) },
        new InMemoryReplayStore(),
      ).authenticate({ ...config, ssoUrl: 'http://idp.example/sso' }, 'x'),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' }));
  it('fails closed on cross-tenant assertions', async () => {
    const provider = new SamlIdentityProvider(
      { verify: () => Promise.resolve({ ...assertion(), organizationId: 'org-b' }) },
      new InMemoryReplayStore(),
    );
    await expect(provider.authenticate(config, 'x')).rejects.toMatchObject({
      code: 'INVALID_ASSERTION',
    });
  });
});
