import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { toProblemDetails } from '@handstack/shared';
import { RateLimitError } from '@handstack/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requestTraceContext } from '../auth/authentication-context.js';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const response = http.getResponse<FastifyReply>();
    const { requestId, traceId } = requestTraceContext(request);
    const problem = toProblemDetails(exception, { instance: request.url, requestId, traceId });

    const reply = response
      .header('content-type', 'application/problem+json')
      .header('x-request-id', requestId)
      .header('x-trace-id', traceId);
    if (exception instanceof RateLimitError && exception.retryAfterSeconds !== undefined)
      reply.header('retry-after', String(exception.retryAfterSeconds));
    void reply.status(problem.status).send(problem);
  }
}
