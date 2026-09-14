/** RFC 9457 Problem Details as returned by the HandStack API. */
export interface HandStackProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance?: string;
  readonly code?: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly helpArticleId?: string;
}

/** A typed, actionable error raised for every non-2xx HandStack API response. */
export class HandStackApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly requestId: string | undefined;
  readonly traceId: string | undefined;
  readonly helpArticleId: string | undefined;
  readonly problem: HandStackProblemDetails;

  constructor(problem: HandStackProblemDetails) {
    super(problem.detail === '' ? problem.title : problem.detail);
    this.name = 'HandStackApiError';
    this.status = problem.status;
    this.code = problem.code ?? 'api_error';
    this.detail = problem.detail;
    this.requestId = problem.requestId;
    this.traceId = problem.traceId;
    this.helpArticleId = problem.helpArticleId;
    this.problem = problem;
  }
}

/** A transport-level failure (network error, timeout, aborted request). */
export class HandStackSdkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HandStackSdkError';
  }
}

export function isProblemDetails(value: unknown): value is HandStackProblemDetails {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.status === 'number' &&
    (typeof record.title === 'string' || typeof record.detail === 'string')
  );
}
