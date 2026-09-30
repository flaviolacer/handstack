import { ValidationError } from '@handstack/shared';
import { Body, Controller, Inject, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { KnowledgeRuntimeService } from './knowledge-runtime.service.js';
import { DatabaseService } from '../database/database.service.js';
import { assertInternalServiceToken } from '../auth/internal-service-auth.js';

@ApiExcludeController()
@Controller('internal/v1/knowledge')
export class KnowledgeWorkerController {
  constructor(
    @Inject(KnowledgeRuntimeService) private readonly knowledge: KnowledgeRuntimeService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  @Post('reindex-jobs/run')
  async runReindexJob(@Req() request: FastifyRequest, @Body() value: unknown) {
    this.authorize(request.headers.authorization);
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new ValidationError('Knowledge reindex job payload must be an object');
    const body = value as Record<string, unknown>;
    const organizationId = requiredString(body, 'organizationId');
    const jobId = requiredString(body, 'jobId');
    const result = await this.knowledge.runReindexJob(organizationId, jobId);
    if (result.status === 'FAILED') throw new Error(result.error ?? 'Knowledge reindex failed');
    return result;
  }

  private authorize(header: string | string[] | undefined): void {
    assertInternalServiceToken(header, this.database.config.security.internalServiceToken);
  }
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.trim() === '')
    throw new ValidationError(`Knowledge reindex ${key} is required`);
  return field.trim();
}
