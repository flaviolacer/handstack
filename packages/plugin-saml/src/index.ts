export interface SamlProviderConfig {
  readonly organizationId: string;
  readonly providerId: string;
  readonly issuer: string;
  readonly ssoUrl: string;
  readonly audience: string;
  readonly certificateFingerprint: string;
  readonly timeoutMs?: number;
}

export interface SamlAssertion {
  readonly organizationId: string;
  readonly providerId: string;
  readonly subject: string;
  readonly claims: Readonly<Record<string, unknown>>;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly assertionId: string;
}

export interface SamlResponseVerifier {
  verify(response: string, config: SamlProviderConfig): Promise<SamlAssertion>;
}

export interface ReplayStore {
  has(assertionId: string): Promise<boolean>;
  remember(assertionId: string, expiresAt: Date): Promise<void>;
}

export class SamlProtocolError extends Error {
  constructor(
    readonly code: 'INVALID_CONFIGURATION' | 'INVALID_ASSERTION' | 'REPLAYED_ASSERTION' | 'TIMEOUT',
    message: string,
  ) {
    super(message);
    this.name = 'SamlProtocolError';
  }
}

function assertHttps(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SamlProtocolError('INVALID_CONFIGURATION', `${field} must be a URL`);
  }
  if (url.protocol !== 'https:')
    throw new SamlProtocolError('INVALID_CONFIGURATION', `${field} must use HTTPS`);
}

export function validateSamlProviderConfig(config: SamlProviderConfig): void {
  if (
    !config.organizationId ||
    !config.providerId ||
    !config.issuer ||
    !config.audience ||
    !config.certificateFingerprint
  ) {
    throw new SamlProtocolError('INVALID_CONFIGURATION', 'SAML configuration is incomplete');
  }
  assertHttps(config.issuer, 'issuer');
  assertHttps(config.ssoUrl, 'ssoUrl');
  if ((config.timeoutMs ?? 10_000) < 100 || (config.timeoutMs ?? 10_000) > 30_000) {
    throw new SamlProtocolError('INVALID_CONFIGURATION', 'timeoutMs must be between 100 and 30000');
  }
}

export class InMemoryReplayStore implements ReplayStore {
  private readonly entries = new Map<string, number>();
  has(id: string): Promise<boolean> {
    const expiry = this.entries.get(id);
    if (expiry === undefined) return Promise.resolve(false);
    if (expiry <= Date.now()) {
      this.entries.delete(id);
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  }
  remember(id: string, expiresAt: Date): Promise<void> {
    this.entries.set(id, expiresAt.getTime());
    return Promise.resolve();
  }
}

export class SamlIdentityProvider {
  constructor(
    private readonly verifier: SamlResponseVerifier,
    private readonly replay: ReplayStore,
  ) {}

  async authenticate(config: SamlProviderConfig, response: string): Promise<SamlAssertion> {
    validateSamlProviderConfig(config);
    const timeout = config.timeoutMs ?? 10_000;
    const assertion = await Promise.race([
      this.verifier.verify(response, config),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(new SamlProtocolError('TIMEOUT', 'SAML verification timed out'));
        }, timeout),
      ),
    ]);
    if (
      assertion.organizationId !== config.organizationId ||
      assertion.providerId !== config.providerId ||
      assertion.expiresAt.getTime() <= Date.now()
    ) {
      throw new SamlProtocolError(
        'INVALID_ASSERTION',
        'SAML assertion scope or lifetime is invalid',
      );
    }
    if (await this.replay.has(assertion.assertionId))
      throw new SamlProtocolError('REPLAYED_ASSERTION', 'SAML assertion was already consumed');
    await this.replay.remember(assertion.assertionId, assertion.expiresAt);
    return assertion;
  }
}
