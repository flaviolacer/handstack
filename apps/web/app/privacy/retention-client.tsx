'use client';

import { useState, type SyntheticEvent } from 'react';

interface PrivacySession {
  readonly organizationId: string;
  readonly accessToken: string;
}

interface RetentionPolicy {
  readonly id: string;
  readonly resourceType: string;
  readonly retentionDays: number;
}

interface LegalHold {
  readonly id: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly reason: string;
  readonly active: boolean;
}

interface RetentionRun {
  readonly runId: string;
  readonly retentionDays: number;
  readonly scanned: number;
  readonly deleted: number;
  readonly retained: number;
}

function formValue(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export function RetentionClient() {
  const [session, setSession] = useState<PrivacySession>();
  const [policies, setPolicies] = useState<readonly RetentionPolicy[]>([]);
  const [holds, setHolds] = useState<readonly LegalHold[]>([]);
  const [run, setRun] = useState<RetentionRun>();
  const [usageRun, setUsageRun] = useState<RetentionRun>();
  const [attachmentRun, setAttachmentRun] = useState<RetentionRun>();
  const [traceRun, setTraceRun] = useState<RetentionRun>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function request<T>(path: string, active = session, init?: RequestInit): Promise<T> {
    if (active === undefined) throw new Error('Connect an administrative session first');
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${active.accessToken}`);
    if (init?.body !== undefined) headers.set('content-type', 'application/json');
    const response = await fetch(
      `/api/v1/organizations/${encodeURIComponent(active.organizationId)}/privacy/${path}`,
      {
        ...init,
        headers,
        cache: 'no-store',
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      items?: unknown;
      detail?: unknown;
    };
    if (!response.ok)
      throw new Error(typeof body.detail === 'string' ? body.detail : 'Privacy request failed');
    return body as T;
  }

  async function refresh(active = session) {
    const [policyResult, holdResult] = await Promise.all([
      request<{ items?: RetentionPolicy[] }>('retention', active),
      request<{ items?: LegalHold[] }>('legal-holds', active),
    ]);
    setPolicies(policyResult.items ?? []);
    setHolds(holdResult.items ?? []);
  }

  async function connect(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const active = {
      organizationId: formValue(data, 'organizationId'),
      accessToken: formValue(data, 'accessToken'),
    };
    setBusy(true);
    try {
      await refresh(active);
      setSession(active);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load privacy settings');
    } finally {
      setBusy(false);
    }
  }

  async function savePolicy(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (session === undefined) return;
    const data = new FormData(event.currentTarget);
    const payload = {
      resourceType: formValue(data, 'resourceType'),
      retentionDays: Number(data.get('retentionDays')),
    };
    setBusy(true);
    try {
      await request('retention', session, { method: 'POST', body: JSON.stringify(payload) });
      await refresh();
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save retention policy');
    } finally {
      setBusy(false);
    }
  }

  async function createHold(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (session === undefined) return;
    const form = event.currentTarget;
    const data = new FormData(event.currentTarget);
    const resourceType = formValue(data, 'holdResourceType');
    const resourceId = formValue(data, 'resourceId');
    const payload = {
      reason: formValue(data, 'reason'),
      ...(resourceType === '' ? {} : { resourceType }),
      ...(resourceId === '' ? {} : { resourceId }),
    };
    setBusy(true);
    try {
      await request('legal-holds', session, { method: 'POST', body: JSON.stringify(payload) });
      await refresh();
      setError('');
      form.reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create legal hold');
    } finally {
      setBusy(false);
    }
  }

  async function releaseHold(holdId: string) {
    if (session === undefined) return;
    setBusy(true);
    try {
      await request(`legal-holds/${encodeURIComponent(holdId)}/release`, session, {
        method: 'PATCH',
      });
      await refresh();
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to release legal hold');
    } finally {
      setBusy(false);
    }
  }

  async function executeRetention() {
    if (session === undefined) return;
    if (
      !window.confirm(
        'Run conversation retention now? Expired conversations without legal holds will be deleted.',
      )
    )
      return;
    setBusy(true);
    try {
      const result = await request<RetentionRun>('retention/run', session, { method: 'POST' });
      setRun(result);
      await refresh();
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to run retention');
    } finally {
      setBusy(false);
    }
  }

  async function executeUsageRetention() {
    if (session === undefined) return;
    if (
      !window.confirm(
        'Run usage retention now? Expired usage records without legal holds will be deleted.',
      )
    )
      return;
    setBusy(true);
    try {
      const result = await request<RetentionRun>('retention/usage/run', session, {
        method: 'POST',
      });
      setUsageRun(result);
      await refresh();
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to run usage retention');
    } finally {
      setBusy(false);
    }
  }

  async function executeAttachmentRetention() {
    if (session === undefined) return;
    if (
      !window.confirm(
        'Run attachment retention now? Expired attachment blobs without legal holds will be deleted.',
      )
    )
      return;
    setBusy(true);
    try {
      const result = await request<RetentionRun>('retention/attachments/run', session, {
        method: 'POST',
      });
      setAttachmentRun(result);
      await refresh();
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to run attachment retention');
    } finally {
      setBusy(false);
    }
  }

  async function executeTraceRetention() {
    if (session === undefined) return;
    if (
      !window.confirm(
        'Run trace retention now? Expired trace correlation will be removed while message content is preserved.',
      )
    )
      return;
    setBusy(true);
    try {
      const result = await request<RetentionRun>('retention/traces/run', session, {
        method: 'POST',
      });
      setTraceRun(result);
      await refresh();
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to run trace retention');
    } finally {
      setBusy(false);
    }
  }

  if (session === undefined)
    return (
      <section className="panel narrow-panel" aria-labelledby="retention-heading">
        <h2 id="retention-heading">Retention and legal holds</h2>
        <form className="form-grid" onSubmit={(event) => void connect(event)}>
          <label>
            Organization ID
            <input name="organizationId" required />
          </label>
          <label>
            Bearer access token
            <input name="accessToken" type="password" required />
          </label>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? 'Loading…' : 'Connect privacy settings'}
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </section>
    );

  return (
    <section className="settings-stack" aria-labelledby="retention-heading">
      <div className="panel">
        <h2 id="retention-heading">Conversation retention</h2>
        <p>Organization policies override the global conversation retention period.</p>
        <form className="form-grid" onSubmit={(event) => void savePolicy(event)}>
          <label>
            Resource type
            <input name="resourceType" defaultValue="conversations" required />
          </label>
          <label>
            Retention days
            <input name="retentionDays" type="number" min="0" max="36500" required />
          </label>
          <button className="primary-button" type="submit" disabled={busy}>
            Save retention policy
          </button>
        </form>
        <ul aria-label="Retention policies">
          {policies.map((policy) => (
            <li key={policy.id}>
              {policy.resourceType}: {policy.retentionDays} days
            </li>
          ))}
        </ul>
        <button
          className="primary-button"
          type="button"
          onClick={() => void executeRetention()}
          disabled={busy}
        >
          Run conversation retention…
        </button>
        {run && (
          <p role="status">
            Retention run {run.runId}: scanned {run.scanned}, deleted {run.deleted}, retained{' '}
            {run.retained}.
          </p>
        )}
        <h3>Usage retention</h3>
        <p>Usage records use the organization policy or the global usage retention period.</p>
        <button
          className="primary-button"
          type="button"
          onClick={() => void executeUsageRetention()}
          disabled={busy}
        >
          Run usage retention…
        </button>
        {usageRun && (
          <p role="status">
            Usage retention {usageRun.runId}: scanned {usageRun.scanned}, deleted {usageRun.deleted}
            , retained {usageRun.retained}.
          </p>
        )}
        <h3>Attachment retention</h3>
        <p>Expired attachment blobs are deleted while metadata remains auditable.</p>
        <button
          className="primary-button"
          type="button"
          onClick={() => void executeAttachmentRetention()}
          disabled={busy}
        >
          Run attachment retention…
        </button>
        {attachmentRun && (
          <p role="status">
            Attachment retention {attachmentRun.runId}: scanned {attachmentRun.scanned}, deleted{' '}
            {attachmentRun.deleted}, retained {attachmentRun.retained}.
          </p>
        )}
        <h3>Trace retention</h3>
        <p>
          Expired trace correlation is removed from messages while message content is preserved.
        </p>
        <button
          className="primary-button"
          type="button"
          onClick={() => void executeTraceRetention()}
          disabled={busy}
        >
          Run trace retention…
        </button>
        {traceRun && (
          <p role="status">
            Trace retention {traceRun.runId}: scanned {traceRun.scanned}, deleted {traceRun.deleted}
            , retained {traceRun.retained}.
          </p>
        )}
      </div>

      <div className="panel">
        <h2>Legal holds</h2>
        <form className="form-grid" onSubmit={(event) => void createHold(event)}>
          <label>
            Resource type (blank for all)
            <input name="holdResourceType" />
          </label>
          <label>
            Resource ID (blank for all of the type)
            <input name="resourceId" />
          </label>
          <label>
            Reason
            <input name="reason" required />
          </label>
          <button className="primary-button" type="submit" disabled={busy}>
            Create legal hold
          </button>
        </form>
        <ul aria-label="Legal holds">
          {holds.map((hold) => (
            <li key={hold.id}>
              <span>
                {hold.active ? 'Active' : 'Released'} · {hold.resourceType ?? 'all resources'}
                {hold.resourceId === undefined ? '' : ` · ${hold.resourceId}`} · {hold.reason}
              </span>
              {hold.active && (
                <button type="button" disabled={busy} onClick={() => void releaseHold(hold.id)}>
                  Release hold
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
