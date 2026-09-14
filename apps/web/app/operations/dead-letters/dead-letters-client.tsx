'use client';

import { useCallback, useState, type SyntheticEvent } from 'react';
import {
  deadLetterApi,
  jobQueues,
  type AdminSession,
  type DeadLetterJob,
  type JobQueueName,
} from './dead-letter-api';

type ViewState = 'signed-out' | 'loading' | 'ready' | 'error';

function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
}

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function DeadLettersClient() {
  const [session, setSession] = useState<AdminSession>();
  const [state, setState] = useState<ViewState>('signed-out');
  const [queue, setQueue] = useState<JobQueueName>('agents');
  const [items, setItems] = useState<readonly DeadLetterJob[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const baseUrl = process.env.NEXT_PUBLIC_HANDSTACK_API_URL ?? '';

  const load = useCallback(
    async (active: AdminSession, selectedQueue: JobQueueName = queue) => {
      setState('loading');
      setError('');
      setMessage('');
      try {
        setItems((await deadLetterApi(active, baseUrl).deadLetters(selectedQueue)).items);
        setState('ready');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Unable to load dead letters');
        setState('error');
      }
    },
    [baseUrl, queue],
  );

  function connect(event: SyntheticEvent<HTMLFormElement>) {
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

  async function selectQueue(nextQueue: JobQueueName) {
    setQueue(nextQueue);
    if (session !== undefined) await load(session, nextQueue);
  }

  async function retry(item: DeadLetterJob) {
    if (session === undefined) return;
    setError('');
    setMessage('');
    try {
      await deadLetterApi(session, baseUrl).retryDeadLetter(queue, item.job.idempotencyKey);
      setMessage(`Job ${item.job.idempotencyKey} returned to ${queue}.`);
      await load(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to retry dead letter');
      setState('error');
    }
  }

  async function discard(item: DeadLetterJob) {
    if (session === undefined || !window.confirm(`Discard job ${item.job.idempotencyKey}?`)) return;
    setError('');
    setMessage('');
    try {
      await deadLetterApi(session, baseUrl).discardDeadLetter(queue, item.job.idempotencyKey);
      setMessage(`Job ${item.job.idempotencyKey} discarded and audited.`);
      await load(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to discard dead letter');
      setState('error');
    }
  }

  return (
    <div className="settings-stack" aria-live="polite">
      {state === 'signed-out' && (
        <section className="panel narrow-panel">
          <h2>Connect an administrative session</h2>
          <p className="muted">The bearer token stays in memory and is cleared on reload.</p>
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
              Inspect dead letters
            </button>
          </form>
        </section>
      )}
      {session !== undefined && (
        <section className="panel dlq-toolbar">
          <label>
            Queue
            <select
              value={queue}
              onChange={(event) => void selectQueue(event.target.value as JobQueueName)}
            >
              {jobQueues.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <button className="secondary-button" onClick={() => void load(session)}>
            Refresh
          </button>
        </section>
      )}
      {state === 'loading' && (
        <div className="panel" role="status">
          Loading dead letters…
        </div>
      )}
      {state === 'error' && (
        <div className="panel error-panel" role="alert">
          <strong>Dead-letter administration failed.</strong>
          <p>{error}</p>
          {(error.includes('403') || error.toLowerCase().includes('permission')) && (
            <p>Ask an administrator for jobs.read/jobs.manage.</p>
          )}
          {session !== undefined && <button onClick={() => void load(session)}>Try again</button>}
        </div>
      )}
      {message !== '' && (
        <div className="panel success-panel" role="status">
          {message}
        </div>
      )}
      {state === 'ready' && items.length === 0 && (
        <section className="panel empty-state">
          <h2>No dead letters in {queue}</h2>
          <p>Failed jobs retained by this queue will appear here without exposing their payload.</p>
        </section>
      )}
      {state === 'ready' && items.length > 0 && (
        <div className="dlq-list">
          {items.map((item) => (
            <article className="panel dlq-card" key={item.job.idempotencyKey}>
              <div>
                <strong>{item.job.idempotencyKey}</strong>
                <p className="muted">{item.error}</p>
              </div>
              <dl>
                <div>
                  <dt>Attempts</dt>
                  <dd>{item.job.attempts}</dd>
                </div>
                <div>
                  <dt>Dead-lettered</dt>
                  <dd>{displayDate(item.deadLetteredAt)}</dd>
                </div>
              </dl>
              <div className="dlq-actions">
                <button className="primary-button" onClick={() => void retry(item)}>
                  Retry
                </button>
                <button className="danger-button" onClick={() => void discard(item)}>
                  Discard
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
