'use client';

import Link from 'next/link';
import { useCallback, useState, type SyntheticEvent } from 'react';
import {
  identityApi,
  type AdminSession,
  type LoginPolicy,
  type IdentityMapping,
  type PublicIdentityProvider,
} from './identity-api';

type ViewState = 'signed-out' | 'loading' | 'ready' | 'error';
type FormSubmitEvent = SyntheticEvent<HTMLFormElement>;

function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
}

export function IdentityProvidersClient() {
  const [session, setSession] = useState<AdminSession>();
  const [state, setState] = useState<ViewState>('signed-out');
  const [providers, setProviders] = useState<PublicIdentityProvider[]>([]);
  const [policy, setPolicy] = useState<LoginPolicy>();
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [mappingEditor, setMappingEditor] = useState<{
    provider: PublicIdentityProvider;
    mappings: IdentityMapping[];
  }>();
  const [connectionResult, setConnectionResult] = useState<Record<string, string>>({});
  const baseUrl = process.env.NEXT_PUBLIC_HANDSTACK_API_URL ?? '';

  const load = useCallback(
    async (active: AdminSession) => {
      setState('loading');
      setError('');
      try {
        const api = identityApi(active, baseUrl);
        const [nextProviders, nextPolicy] = await Promise.all([api.providers(), api.policy()]);
        setProviders(nextProviders);
        setPolicy(nextPolicy);
        setState('ready');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Unable to load identity settings');
        setState('error');
      }
    },
    [baseUrl],
  );

  function connect(event: FormSubmitEvent) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const active = {
      organizationId: formText(data, 'organizationId').trim(),
      accessToken: formText(data, 'accessToken').trim(),
    };
    setSession(active);
    void load(active);
    event.currentTarget.reset();
  }

  async function create(event: FormSubmitEvent) {
    event.preventDefault();
    if (session === undefined) return;
    const data = new FormData(event.currentTarget);
    setState('loading');
    try {
      await identityApi(session, baseUrl).createProvider({
        pluginId: 'generic-oidc',
        name: data.get('name'),
        slug: data.get('slug'),
        clientSecretReference: data.get('clientSecretReference'),
        jitEnabled: data.get('jitEnabled') === 'on',
        accountLinking: data.get('accountLinking') === 'on' ? 'VERIFIED_EMAIL' : 'DISABLED',
        configuration: {
          issuer: data.get('issuer'),
          clientId: data.get('clientId'),
          redirectUri: data.get('redirectUri'),
          scopes: formText(data, 'scopes').split(/\s+/).filter(Boolean),
        },
      });
      setShowCreate(false);
      await load(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create provider');
      setState('error');
    }
  }

  async function toggle(provider: PublicIdentityProvider) {
    if (session === undefined) return;
    if (
      provider.enabled &&
      !window.confirm(`Disable ${provider.name}? New SSO logins will stop.`)
    ) {
      return;
    }
    await identityApi(session, baseUrl).setProviderEnabled(provider.id, !provider.enabled);
    await load(session);
  }

  async function openMappings(provider: PublicIdentityProvider) {
    if (session === undefined) return;
    setState('loading');
    try {
      const mappings = await identityApi(session, baseUrl).mappings(provider.id);
      setMappingEditor({ provider, mappings });
      setState('ready');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load mappings');
      setState('error');
    }
  }

  async function testConnection(provider: PublicIdentityProvider) {
    if (session === undefined) return;
    setConnectionResult((current) => ({ ...current, [provider.id]: 'Testing…' }));
    try {
      const result = await identityApi(session, baseUrl).testConnection(provider.id);
      setConnectionResult((current) => ({
        ...current,
        [provider.id]: result.ok
          ? 'Connection verified'
          : `Failed at ${result.stage}: ${result.code}`,
      }));
    } catch (cause) {
      setConnectionResult((current) => ({
        ...current,
        [provider.id]: cause instanceof Error ? cause.message : 'Connection test failed',
      }));
    }
  }

  async function saveMappings(event: FormSubmitEvent) {
    event.preventDefault();
    if (session === undefined || mappingEditor === undefined) return;
    const lines = formText(new FormData(event.currentTarget), 'mappings')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const mappings = lines.map((line) => {
      const match = /^([A-Za-z_][A-Za-z0-9_-]{0,63})=([^|]+)\|(GROUP|ROLE)\|(.+)$/.exec(line);
      if (
        match?.[1] === undefined ||
        match[2] === undefined ||
        match[3] === undefined ||
        match[4] === undefined
      ) {
        throw new Error(`Invalid mapping line: ${line}`);
      }
      return {
        sourceClaim: match[1],
        sourceValue: match[2],
        targetType: match[3] as 'GROUP' | 'ROLE',
        targetId: match[4],
        enabled: true,
      };
    });
    await identityApi(session, baseUrl).setMappings(mappingEditor.provider.id, mappings);
    setMappingEditor(undefined);
    await load(session);
  }

  async function updatePolicy(event: FormSubmitEvent) {
    event.preventDefault();
    if (session === undefined) return;
    const data = new FormData(event.currentTarget);
    const mode = formText(data, 'mode');
    await identityApi(session, baseUrl).setPolicy({
      mode,
      ...(mode === 'SPECIFIC_IDP_REQUIRED'
        ? { requiredProviderId: data.get('requiredProviderId') }
        : {}),
      breakGlassEnabled: data.get('breakGlassEnabled') === 'on',
      maxBreakGlassAccounts: Number(data.get('maxBreakGlassAccounts')),
    });
    await load(session);
  }

  return (
    <div className="settings-stack" aria-live="polite">
      {state === 'signed-out' && (
        <section className="panel narrow-panel">
          <h2>Connect an administrative session</h2>
          <p className="muted">Credentials stay in memory and are cleared on page reload.</p>
          <form className="form-grid" onSubmit={connect}>
            <label>
              Organization ID
              <input name="organizationId" required />
            </label>
            <label>
              Bearer access token
              <input name="accessToken" type="password" required />
            </label>
            <button className="primary-button" type="submit">
              Load identity settings
            </button>
          </form>
        </section>
      )}
      {state === 'loading' && (
        <div className="panel" role="status">
          Loading identity providers…
        </div>
      )}
      {state === 'error' && (
        <div className="panel error-panel" role="alert">
          <strong>Identity settings could not be loaded.</strong>
          <p>{error}</p>
          {session !== undefined && <button onClick={() => void load(session)}>Try again</button>}
        </div>
      )}
      {state === 'ready' && (
        <>
          <div className="settings-actions">
            <div>
              <strong>
                {providers.length} configured provider{providers.length === 1 ? '' : 's'}
              </strong>
              <span className="muted"> · secrets remain in the server vault</span>
            </div>
            <button
              className="primary-button"
              onClick={() => {
                setShowCreate(!showCreate);
              }}
            >
              Add identity provider
            </button>
          </div>
          {showCreate && <ProviderForm onSubmit={(event) => void create(event)} />}
          {providers.length === 0 ? (
            <section className="panel empty-state">
              <h2>No identity providers yet</h2>
              <p>Add a generic OIDC provider to offer enterprise sign-in.</p>
            </section>
          ) : (
            <div className="provider-grid">
              {providers.map((provider) => (
                <article className="panel provider-card" key={provider.id}>
                  <div className="provider-heading">
                    <div>
                      <span className={`status-dot ${provider.enabled ? 'enabled' : ''}`} />
                      <strong>{provider.name}</strong>
                      <p className="muted">{provider.configuration.issuer}</p>
                    </div>
                    <span className="badge">{provider.enabled ? 'Enabled' : 'Disabled'}</span>
                  </div>
                  <dl>
                    <div>
                      <dt>Slug</dt>
                      <dd>{provider.slug}</dd>
                    </div>
                    <div>
                      <dt>Client</dt>
                      <dd>{provider.configuration.clientId}</dd>
                    </div>
                    <div>
                      <dt>Secret</dt>
                      <dd>{provider.hasClientSecret ? 'Configured' : 'Not configured'}</dd>
                    </div>
                  </dl>
                  <button
                    className={provider.enabled ? 'danger-button' : 'secondary-button'}
                    onClick={() => void toggle(provider)}
                  >
                    {provider.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="secondary-button" onClick={() => void openMappings(provider)}>
                    Configure group mapping
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => void testConnection(provider)}
                  >
                    Test connection
                  </button>
                  {connectionResult[provider.id] !== undefined && (
                    <p className="muted" role="status">
                      {connectionResult[provider.id]}
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}
          {policy !== undefined && (
            <PolicyForm
              policy={policy}
              providers={providers}
              onSubmit={(event) => void updatePolicy(event)}
            />
          )}
          {mappingEditor !== undefined && (
            <MappingForm editor={mappingEditor} onSubmit={(event) => void saveMappings(event)} />
          )}
        </>
      )}
      <Link className="context-help" href="/help/getting-started/authentication-sessions">
        ? Identity configuration guide
      </Link>
    </div>
  );
}

function MappingForm({
  editor,
  onSubmit,
}: {
  readonly editor: { provider: PublicIdentityProvider; mappings: IdentityMapping[] };
  readonly onSubmit: (event: FormSubmitEvent) => void;
}) {
  const value = editor.mappings
    .map(
      (mapping) =>
        `${mapping.sourceClaim}=${mapping.sourceValue}|${mapping.targetType}|${mapping.targetId}`,
    )
    .join('\n');
  return (
    <form className="panel form-grid" onSubmit={onSubmit}>
      <h2>Group and role mapping · {editor.provider.name}</h2>
      <label className="span-two">
        Allowlisted mappings, one per line
        <textarea
          name="mappings"
          rows={6}
          defaultValue={value}
          placeholder="groups=engineering|GROUP|group-id"
        />
      </label>
      <p className="muted span-two">
        Format: claim=value|GROUP or ROLE|target ID. Only exact claim values grant access.
      </p>
      <button className="primary-button" type="submit">
        Save mappings
      </button>
    </form>
  );
}

function ProviderForm({ onSubmit }: { readonly onSubmit: (event: FormSubmitEvent) => void }) {
  return (
    <form className="panel form-grid provider-form" onSubmit={onSubmit}>
      <h2>Add generic OIDC provider</h2>
      <label>
        Name
        <input name="name" required />
      </label>
      <label>
        Slug
        <input name="slug" pattern="[a-z0-9][a-z0-9-]{1,62}" required />
      </label>
      <label className="span-two">
        Issuer URL
        <input name="issuer" type="url" pattern="https://.*" required />
      </label>
      <label>
        Client ID
        <input name="clientId" required />
      </label>
      <label>
        Secret reference
        <input
          name="clientSecretReference"
          type="password"
          placeholder="secret://<id> or env://HANDSTACK_SECRET_NAME"
          required
        />
        <small className="muted">
          Enter a stored secret ID or an allowlisted HANDSTACK_SECRET_* environment reference; never
          enter the secret value here.
        </small>
      </label>
      <label className="span-two">
        Redirect URI
        <input name="redirectUri" type="url" pattern="https://.*" required />
      </label>
      <label className="span-two">
        Scopes
        <input name="scopes" defaultValue="openid profile email" required />
      </label>
      <label className="check">
        <input name="jitEnabled" type="checkbox" /> Enable JIT provisioning
      </label>
      <label className="check">
        <input name="accountLinking" type="checkbox" /> Link verified email accounts
      </label>
      <button className="primary-button" type="submit">
        Create provider
      </button>
    </form>
  );
}

function PolicyForm({
  policy,
  providers,
  onSubmit,
}: {
  readonly policy: LoginPolicy;
  readonly providers: PublicIdentityProvider[];
  readonly onSubmit: (event: FormSubmitEvent) => void;
}) {
  return (
    <form className="panel form-grid policy-form" onSubmit={onSubmit}>
      <h2>Login enforcement</h2>
      <label>
        Login mode
        <select name="mode" defaultValue={policy.mode}>
          <option value="LOCAL_ALLOWED">Local login allowed</option>
          <option value="LOCAL_DISABLED">Local login disabled</option>
          <option value="SSO_REQUIRED">SSO required</option>
          <option value="SPECIFIC_IDP_REQUIRED">Specific provider required</option>
        </select>
      </label>
      <label>
        Required provider
        <select name="requiredProviderId" defaultValue={policy.requiredProviderId ?? ''}>
          <option value="">Select a provider</option>
          {providers
            .filter(({ enabled }) => enabled)
            .map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
        </select>
      </label>
      <label className="check">
        <input name="breakGlassEnabled" type="checkbox" defaultChecked={policy.breakGlassEnabled} />{' '}
        Allow registered break-glass accounts
      </label>
      <label>
        Maximum break-glass accounts
        <input
          name="maxBreakGlassAccounts"
          type="number"
          min="1"
          max="10"
          defaultValue={policy.maxBreakGlassAccounts}
          required
        />
      </label>
      <button className="primary-button" type="submit">
        Save enforcement policy
      </button>
    </form>
  );
}
