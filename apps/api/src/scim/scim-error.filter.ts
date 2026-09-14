import {
  AuthenticationError,
  AuthorizationError,
  HandStackError,
  RateLimitError,
  ValidationError,
} from '@handstack/shared';
import { ScimConflictError, ScimNotFoundError } from '@handstack/scim';
import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

const errorSchema = 'urn:ietf:params:scim:api:messages:2.0:Error';

function scimError(status: number, detail: string, scimType?: string): Record<string, unknown> {
  return {
    schemas: [errorSchema],
    status: String(status),
    ...(scimType === undefined ? {} : { scimType }),
    detail,
  };
}

/** Translates typed HandStack failures into RFC 7644 SCIM error responses. */
@Catch()
export class ScimErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const response = http.getResponse<FastifyReply>();

    if (exception instanceof ScimNotFoundError) {
      void response.status(404).send(scimError(404, exception.message, 'noTarget'));
      return;
    }
    if (exception instanceof ScimConflictError) {
      void response.status(409).send(scimError(409, exception.message, 'uniqueness'));
      return;
    }
    if (exception instanceof RateLimitError) {
      void response
        .header('Retry-After', '1')
        .status(429)
        .send(scimError(429, 'SCIM rate limit exceeded'));
      return;
    }
    if (exception instanceof AuthenticationError) {
      void response.status(401).send(scimError(401, 'Authentication required'));
      return;
    }
    if (exception instanceof AuthorizationError) {
      void response.status(403).send(scimError(403, 'Access forbidden'));
      return;
    }
    if (exception instanceof ValidationError) {
      void response.status(400).send(scimError(400, exception.message, 'invalidValue'));
      return;
    }
    if (exception instanceof HandStackError) {
      void response.status(500).send(scimError(500, 'SCIM request failed'));
      return;
    }

    void response
      .header('x-request-id', String(request.headers['x-request-id'] ?? request.id))
      .status(500)
      .send(scimError(500, 'SCIM request failed'));
  }
}
