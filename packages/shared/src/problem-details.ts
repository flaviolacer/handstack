import { HandStackError } from './errors.js';

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly helpArticleId?: string;
}

export function toProblemDetails(
  error: unknown,
  context: { instance: string; requestId: string; traceId: string },
): ProblemDetails {
  if (error instanceof HandStackError) {
    return {
      type: `https://docs.handstack.dev/problems/${error.code}`,
      title: error.name,
      status: error.status,
      detail: error.message,
      instance: context.instance,
      code: error.code,
      requestId: context.requestId,
      traceId: context.traceId,
      ...(error.helpArticleId === undefined ? {} : { helpArticleId: error.helpArticleId }),
    };
  }

  return {
    type: 'https://docs.handstack.dev/problems/internal_error',
    title: 'Internal Server Error',
    status: 500,
    detail: 'An unexpected error occurred.',
    instance: context.instance,
    code: 'internal_error',
    requestId: context.requestId,
    traceId: context.traceId,
  };
}
