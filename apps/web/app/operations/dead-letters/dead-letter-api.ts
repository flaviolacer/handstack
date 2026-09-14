export interface AdminSession {
  readonly organizationId: string;
  readonly accessToken: string;
}

export const jobQueues = [
  'agents',
  'embeddings',
  'documents',
  'plugins',
  'webhooks',
  'audit',
  'billing',
  'cleanup',
  'indexing',
] as const;
export type JobQueueName = (typeof jobQueues)[number];

export interface DeadLetterJob {
  readonly job: {
    readonly id: string;
    readonly idempotencyKey: string;
    readonly attempts: number;
    readonly priority: number;
    readonly createdAt: string;
  };
  readonly error: string;
  readonly deadLetteredAt: string;
}

export class OperationsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OperationsApiError';
  }
}

export function deadLetterApi(session: AdminSession, baseUrl = '') {
  const root = `${baseUrl}/organizations/${encodeURIComponent(session.organizationId)}/jobs`;
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
      throw new OperationsApiError(
        response.status,
        problem?.detail ?? problem?.title ?? 'Operations request failed',
      );
    }
    return (await response.json()) as T;
  }
  return {
    deadLetters: (queue: JobQueueName) =>
      request<{ items: readonly DeadLetterJob[] }>(`/${queue}/dead-letters`),
    retryDeadLetter: (queue: JobQueueName, idempotencyKey: string) =>
      request<{ job: DeadLetterJob['job'] }>(
        `/${queue}/dead-letters/${encodeURIComponent(idempotencyKey)}/retry`,
        { method: 'POST' },
      ),
    discardDeadLetter: (queue: JobQueueName, idempotencyKey: string) =>
      request<{ discarded: true }>(`/${queue}/dead-letters/${encodeURIComponent(idempotencyKey)}`, {
        method: 'DELETE',
      }),
  };
}
