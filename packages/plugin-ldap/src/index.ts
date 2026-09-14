export interface LdapProviderConfig {
  readonly organizationId: string;
  readonly providerId: string;
  readonly url: string;
  readonly baseDn: string;
  readonly bindIdentityReference: string;
  readonly userSearchFilter: string;
  readonly timeoutMs?: number;
}

export interface LdapUser {
  readonly organizationId: string;
  readonly providerId: string;
  readonly subject: string;
  readonly username: string;
  readonly displayName: string;
  readonly email?: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

export interface LdapTransport {
  bind(identityReference: string): Promise<void>;
  search(
    baseDn: string,
    filter: string,
    attributes: readonly string[],
  ): Promise<Readonly<Record<string, unknown>> | undefined>;
  unbind(): Promise<void>;
}

export class LdapProtocolError extends Error {
  constructor(
    readonly code: 'INVALID_CONFIGURATION' | 'AUTHENTICATION_FAILED' | 'USER_NOT_FOUND' | 'TIMEOUT',
    message: string,
  ) {
    super(message);
    this.name = 'LdapProtocolError';
  }
}

export function validateLdapProviderConfig(config: LdapProviderConfig): void {
  if (
    !config.organizationId ||
    !config.providerId ||
    !config.baseDn ||
    !config.bindIdentityReference ||
    !config.userSearchFilter
  )
    throw new LdapProtocolError('INVALID_CONFIGURATION', 'LDAP configuration is incomplete');
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new LdapProtocolError('INVALID_CONFIGURATION', 'url must be a URL');
  }
  if (url.protocol !== 'ldaps:')
    throw new LdapProtocolError('INVALID_CONFIGURATION', 'LDAP requires LDAPS/TLS');
  if ((config.timeoutMs ?? 10_000) < 100 || (config.timeoutMs ?? 10_000) > 30_000)
    throw new LdapProtocolError('INVALID_CONFIGURATION', 'timeoutMs must be between 100 and 30000');
}

export class LdapIdentityProvider {
  constructor(private readonly transport: LdapTransport) {}

  async authenticate(
    config: LdapProviderConfig,
    username: string,
    passwordReference: string,
  ): Promise<LdapUser> {
    validateLdapProviderConfig(config);
    if (!passwordReference || passwordReference.includes('password='))
      throw new LdapProtocolError('INVALID_CONFIGURATION', 'credentials must be secret references');
    const timeout = config.timeoutMs ?? 10_000;
    try {
      await Promise.race([
        this.transport.bind(config.bindIdentityReference),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            reject(new LdapProtocolError('TIMEOUT', 'LDAP bind timed out'));
          }, timeout),
        ),
      ]);
      const record = await Promise.race([
        this.transport.search(
          config.baseDn,
          config.userSearchFilter.replace('{username}', username),
          ['uid', 'cn', 'mail'],
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            reject(new LdapProtocolError('TIMEOUT', 'LDAP search timed out'));
          }, timeout),
        ),
      ]);
      if (record === undefined)
        throw new LdapProtocolError('USER_NOT_FOUND', 'LDAP user was not found');
      const text = (value: unknown, fallback: string): string =>
        typeof value === 'string' ? value : fallback;
      return {
        organizationId: config.organizationId,
        providerId: config.providerId,
        subject: text(record.uid, username),
        username,
        displayName: text(record.cn, username),
        ...(record.mail === undefined ? {} : { email: text(record.mail, '') }),
        claims: record,
      };
    } catch (error) {
      if (error instanceof LdapProtocolError) throw error;
      throw new LdapProtocolError('AUTHENTICATION_FAILED', 'LDAP authentication failed');
    } finally {
      await this.transport.unbind().catch(() => undefined);
    }
  }
}
