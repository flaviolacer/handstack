import type { AccessTokenClaims } from '@handstack/auth';
import type { FastifyRequest } from 'fastify';

export interface AuthenticatedRequest extends FastifyRequest {
  authentication?: AccessTokenClaims;
}

export function requireAuthentication(request: AuthenticatedRequest): AccessTokenClaims {
  if (request.authentication === undefined) {
    throw new TypeError('Authentication context is unavailable');
  }
  return request.authentication;
}
