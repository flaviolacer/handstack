'use client';

import Link from 'next/link';
import { useState, type SyntheticEvent } from 'react';
import { settingsApi, type OrganizationSettings } from './settings-api';

function text(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function applyVisualSettings(settings: OrganizationSettings): void {
  const root = document.documentElement;
  root.dataset.hsTheme = settings.theme;
  root.style.setProperty('--hs-primary', settings.branding.primaryColor);
  root.style.setProperty('--hs-secondary', settings.branding.secondaryColor);
  root.style.setProperty('--hs-accent', settings.branding.accentColor);
  root.style.setProperty('--hs-background', settings.branding.backgroundColor);
  root.style.setProperty(
    '--hs-font',
    settings.branding.font ?? 'Inter, ui-sans-serif, system-ui, sans-serif',
  );
  let custom = document.getElementById('handstack-custom-css');
  if (custom === null) {
    custom = document.createElement('style');
    custom.id = 'handstack-custom-css';
    document.head.appendChild(custom);
  }
  custom.textContent = settings.branding.customCss ?? '';
}

function parseOrganizationConfiguration(
  value: string,
): Readonly<Record<string, unknown>> | undefined {
  if (value.trim() === '') return undefined;
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Organization configuration must be a JSON object');
  }
  if (Object.prototype.hasOwnProperty.call(parsed, 'database')) {
    throw new Error('Organization configuration cannot select the primary database');
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export function SettingsClient() {
  const [session, setSession] = useState<{ organizationId: string; accessToken: string }>();
  const [settings, setSettings] = useState<OrganizationSettings>();
  const [globalDraft, setGlobalDraft] = useState('{}');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const baseUrl = process.env.NEXT_PUBLIC_HANDSTACK_API_URL ?? '';

  async function connect(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = {
      organizationId: text(data, 'organizationId'),
      accessToken: text(data, 'accessToken'),
    };
    try {
      const api = settingsApi(next.organizationId, next.accessToken, baseUrl);
      const [value, global] = await Promise.all([api.get(), api.global.get()]);
      setSession(next);
      setSettings(value);
      setGlobalDraft(JSON.stringify(global, null, 2));
      applyVisualSettings(value);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load settings');
    }
  }

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (session === undefined || settings === undefined) return;
    const data = new FormData(event.currentTarget);
    try {
      const configuration = parseOrganizationConfiguration(text(data, 'configuration'));
      const value = await settingsApi(session.organizationId, session.accessToken, baseUrl).update({
        locale: text(data, 'locale'),
        timezone: text(data, 'timezone'),
        theme: text(data, 'theme'),
        branding: {
          ...settings.branding,
          displayName: text(data, 'displayName'),
          productName: text(data, 'productName'),
          logo: text(data, 'logo'),
          favicon: text(data, 'favicon'),
          primaryColor: text(data, 'primaryColor'),
          secondaryColor: text(data, 'secondaryColor'),
          accentColor: text(data, 'accentColor'),
          backgroundColor: text(data, 'backgroundColor'),
          font: text(data, 'font'),
          loginBackground: text(data, 'loginBackground'),
          customCss: text(data, 'customCss'),
          customDomain: text(data, 'customDomain'),
          welcomeMessage: text(data, 'welcomeMessage'),
          supportUrl: text(data, 'supportUrl'),
          legalLinks: text(data, 'legalLinks')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const [label, url] = line.split('|', 2);
              return { label: label?.trim() ?? '', url: url?.trim() ?? '' };
            }),
        },
        ...(configuration === undefined ? {} : { configuration }),
      });
      setSettings(value);
      applyVisualSettings(value);
      setSaved(true);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save settings');
    }
  }

  async function saveGlobal(raw: string) {
    if (session === undefined) return;
    try {
      const value = JSON.parse(raw) as unknown;
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        Object.prototype.hasOwnProperty.call(value, 'database')
      ) {
        throw new Error(
          'Global configuration must be an object and cannot contain database settings',
        );
      }
      const next = await settingsApi(
        session.organizationId,
        session.accessToken,
        baseUrl,
      ).global.update(value);
      setGlobalDraft(JSON.stringify(next, null, 2));
      setSaved(true);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save global settings');
    }
  }

  if (session === undefined || settings === undefined) {
    return (
      <section className="panel narrow-panel">
        <h2>Connect an administrative session</h2>
        <p className="muted">The token remains in memory and is cleared on reload.</p>
        <form
          className="form-grid"
          onSubmit={(event) => {
            void connect(event);
          }}
        >
          <label>
            Organization ID
            <input name="organizationId" required />
          </label>
          <label>
            Bearer access token
            <input name="accessToken" type="password" required />
          </label>
          <button className="primary-button" type="submit">
            Load organization settings
          </button>
        </form>
        {error && (
          <p className="error-panel" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <form
      className="settings-stack"
      onSubmit={(event) => {
        void save(event);
      }}
    >
      <section className="panel form-grid">
        <h2>Global runtime configuration</h2>
        <p className="muted">
          Applies after environment and config-file values. The primary database adapter and URL
          remain startup-only.
        </p>
        <label>
          Global runtime configuration (JSON)
          <textarea
            name="globalConfiguration"
            value={globalDraft}
            onChange={(event) => {
              setGlobalDraft(event.target.value);
            }}
            rows={12}
          />
        </label>
        <button
          className="primary-button"
          type="button"
          onClick={() => {
            void saveGlobal(globalDraft);
          }}
        >
          Save global configuration
        </button>
      </section>
      <section className="panel form-grid">
        <h2>Organization</h2>
        <label>
          Display name
          <input name="displayName" defaultValue={settings.branding.displayName} required />
        </label>
        <label>
          Product name
          <input name="productName" defaultValue={settings.branding.productName} required />
        </label>
        <label>
          Logo URL or data URI
          <input name="logo" defaultValue={settings.branding.logo} />
        </label>
        <label>
          Favicon URL or data URI
          <input name="favicon" defaultValue={settings.branding.favicon} />
        </label>
        <label>
          Locale
          <input name="locale" defaultValue={settings.locale} required />
        </label>
        <label>
          Timezone
          <input name="timezone" defaultValue={settings.timezone} required />
        </label>
        <label>
          Theme
          <select name="theme" defaultValue={settings.theme}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label>
          Runtime configuration overrides (JSON, without `database`)
          <textarea
            name="configuration"
            defaultValue={JSON.stringify(settings.configuration ?? {}, null, 2)}
            rows={10}
          />
        </label>
      </section>
      <section className="panel form-grid">
        <h2>Branding</h2>
        <label>
          Primary color
          <input name="primaryColor" type="color" defaultValue={settings.branding.primaryColor} />
        </label>
        <label>
          Secondary color
          <input
            name="secondaryColor"
            type="color"
            defaultValue={settings.branding.secondaryColor}
          />
        </label>
        <label>
          Accent color
          <input name="accentColor" type="color" defaultValue={settings.branding.accentColor} />
        </label>
        <label>
          Background color
          <input
            name="backgroundColor"
            type="color"
            defaultValue={settings.branding.backgroundColor}
          />
        </label>
        <label>
          Font
          <input name="font" defaultValue={settings.branding.font} />
        </label>
        <label>
          Login background URL or data URI
          <input name="loginBackground" defaultValue={settings.branding.loginBackground} />
        </label>
        <label>
          Custom domain
          <input name="customDomain" defaultValue={settings.branding.customDomain} />
        </label>
        <label>
          Welcome message
          <textarea name="welcomeMessage" defaultValue={settings.branding.welcomeMessage} />
        </label>
        <label>
          Support URL
          <input name="supportUrl" type="url" defaultValue={settings.branding.supportUrl} />
        </label>
        <label>
          Legal links (uma linha por `label|https://...`)
          <textarea
            name="legalLinks"
            defaultValue={settings.branding.legalLinks
              .map((link) => `${link.label}|${link.url}`)
              .join('\n')}
          />
        </label>
        <label>
          Custom CSS
          <textarea name="customCss" defaultValue={settings.branding.customCss} />
        </label>
        <button className="primary-button" type="submit">
          Save settings
        </button>
        {saved && <p role="status">Settings saved.</p>}
        {error && (
          <p className="error-panel" role="alert">
            {error}
          </p>
        )}
      </section>
      <Link href="/settings/identity-providers">Configure identity providers →</Link>
    </form>
  );
}
