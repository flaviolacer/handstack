export interface OrganizationSettings {
  readonly branding: {
    readonly displayName: string;
    readonly productName: string;
    readonly logo?: string;
    readonly favicon?: string;
    readonly primaryColor: string;
    readonly secondaryColor: string;
    readonly accentColor: string;
    readonly backgroundColor: string;
    readonly font?: string;
    readonly loginBackground?: string;
    readonly customCss?: string;
    readonly customDomain?: string;
    readonly welcomeMessage?: string;
    readonly supportUrl?: string;
    readonly legalLinks: readonly { readonly label: string; readonly url: string }[];
  };
  readonly locale: string;
  readonly timezone: string;
  readonly theme: 'light' | 'dark' | 'system' | 'custom';
  readonly configuration?: Readonly<Record<string, unknown>>;
}

export type GlobalConfiguration = Readonly<Record<string, unknown>>;

export function settingsApi(organizationId: string, accessToken: string, baseUrl = '') {
  const root = `${baseUrl}/api/v1/organizations/${encodeURIComponent(organizationId)}/settings`;
  async function request<T>(path = root, init?: RequestInit): Promise<T> {
    const response = await fetch(path, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Organization settings request failed');
    return (await response.json()) as T;
  }
  return {
    get: () => request<OrganizationSettings>(root),
    update: (value: unknown) =>
      request<OrganizationSettings>(root, { method: 'PATCH', body: JSON.stringify(value) }),
    global: {
      get: () => request<GlobalConfiguration>(`${baseUrl}/api/v1/admin/settings/database`),
      update: (value: unknown) =>
        request<GlobalConfiguration>(`${baseUrl}/api/v1/admin/settings/database`, {
          method: 'PATCH',
          body: JSON.stringify(value),
        }),
    },
  };
}
