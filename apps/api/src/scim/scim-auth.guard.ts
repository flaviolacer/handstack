import { AuthenticationError } from '@handstack/shared';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ScimRuntimeService } from './scim-runtime.service.js';

export interface ScimRequest extends FastifyRequest {
  scimOrganizationId?: string;
}

@Injectable()
export class ScimAuthGuard implements CanActivate {
  constructor(@Inject(ScimRuntimeService) private readonly runtime: ScimRuntimeService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ScimRequest>();
    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ') !== true) {
      throw new AuthenticationError('SCIM bearer token is required');
    }
    const token = authorization.slice('Bearer '.length).trim();
    if (token.length === 0) throw new AuthenticationError('SCIM bearer token is required');
    const organizationId = await this.runtime.credentials.authenticate(token);
    if (organizationId === undefined) {
      throw new AuthenticationError('Invalid SCIM bearer token');
    }
    request.scimOrganizationId = organizationId;
    return true;
  }
}

export function requireScimOrganization(request: ScimRequest): string {
  if (request.scimOrganizationId === undefined) {
    throw new AuthenticationError('SCIM organization context is unavailable');
  }
  return request.scimOrganizationId;
}
