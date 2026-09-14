import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { toProblemDetails } from '@handstack/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const response = http.getResponse<FastifyReply>();
    const requestId = String(request.headers['x-request-id'] ?? request.id);
    const traceId = String(request.headers['x-trace-id'] ?? requestId);
    const problem = toProblemDetails(exception, { instance: request.url, requestId, traceId });

    void response
      .header('content-type', 'application/problem+json')
      .header('x-request-id', requestId)
      .header('x-trace-id', traceId)
      .status(problem.status)
      .send(problem);
  }
}
