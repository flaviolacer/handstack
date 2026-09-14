export interface AdminSession {
  readonly organizationId: string;
  readonly accessToken: string;
}

export interface PublicIdentityProvider {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly enabled: boolean;
  readonly hasClientSecret: boolean;
  readonly priority: number;
  readonly configuration: {
    readonly issuer: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly scopes: readonly string[];
  };
}

export interface LoginPolicy {
  readonly mode: 'LOCAL_ALLOWED' | 'LOCAL_DISABLED' | 'SSO_REQUIRED' | 'SPECIFIC_IDP_REQUIRED';
  readonly requiredProviderId?: string;
  readonly breakGlassEnabled: boolean;
  readonly maxBreakGlassAccounts: number;
}

export interface IdentityMapping {
  readonly id: string;
  readonly sourceClaim: string;
  readonly sourceValue: string;
  readonly targetType: 'GROUP' | 'ROLE';
  readonly targetId: string;
  readonly enabled: boolean;
}

export interface OidcConnectionTestResult {
  readonly ok: boolean;
  readonly stage: 'DISCOVERY' | 'JWKS' | 'COMPLETE';
  readonly code: string;
}

export class IdentityApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityApiError';
  }
}

export function identityApi(session: AdminSession, baseUrl = '') {
  const root = `${baseUrl}/organizations/${encodeURIComponent(session.organizationId)}/identity`;
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${root}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      cache: 'no-store',
    });
    if (!response.ok) {
      const problem = (await response.json().catch(() => undefined)) as
        { detail?: string; title?: string } | undefined;
      throw new IdentityApiError(
        response.status,
        problem?.detail ?? problem?.title ?? 'Identity administration request failed',
      );
    }
    return (await response.json()) as T;
  }
  return {
    providers: () => request<PublicIdentityProvider[]>('/providers'),
    policy: () => request<LoginPolicy>('/login-policy'),
    createProvider: (input: unknown) =>
      request<PublicIdentityProvider>('/providers', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    setProviderEnabled: (providerId: string, enabled: boolean) =>
      request<PublicIdentityProvider>(`/providers/${encodeURIComponent(providerId)}/enabled`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    testConnection: (providerId: string) =>
      request<OidcConnectionTestResult>(
        `/providers/${encodeURIComponent(providerId)}/test-connection`,
        { method: 'POST' },
      ),
    mappings: (providerId: string) =>
      request<IdentityMapping[]>(`/providers/${encodeURIComponent(providerId)}/mappings`),
    setMappings: (providerId: string, mappings: readonly Omit<IdentityMapping, 'id'>[]) =>
      request<IdentityMapping[]>(`/providers/${encodeURIComponent(providerId)}/mappings`, {
        method: 'PATCH',
        body: JSON.stringify(mappings),
      }),
    setPolicy: (input: unknown) =>
      request<LoginPolicy>('/login-policy', { method: 'PATCH', body: JSON.stringify(input) }),
  };
}
