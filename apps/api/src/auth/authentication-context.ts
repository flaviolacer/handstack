import type { AccessTokenClaims } from '@handstack/auth';
import type { FastifyRequest } from 'fastify';

export interface AuthenticatedRequest extends FastifyRequest {
  authentication?: AccessTokenClaims;
}

export interface RequestTraceContext {
  readonly requestId: string;
  readonly traceId: string;
}

const safeContextIdentifier = /^[A-Za-z0-9._:-]{1,128}$/u;

/** Extracts bounded diagnostic identifiers without trusting arbitrary header contents. */
export function requestTraceContext(request: FastifyRequest): RequestTraceContext {
  const requestIdHeader = request.headers['x-request-id'];
  const traceIdHeader = request.headers['x-trace-id'];
  const requestId = safeHeader(requestIdHeader) ?? request.id;
  return { requestId, traceId: safeHeader(traceIdHeader) ?? requestId };
}

function safeHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && safeContextIdentifier.test(value) ? value : undefined;
}

export function requireAuthentication(request: AuthenticatedRequest): AccessTokenClaims {
  if (request.authentication === undefined) {
    throw new TypeError('Authentication context is unavailable');
  }
  return request.authentication;
}
