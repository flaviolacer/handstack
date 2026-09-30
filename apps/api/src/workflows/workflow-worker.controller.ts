import { ValidationError } from '@handstack/shared';
import { Body, Controller, Inject, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { WorkflowRuntimeService, type WorkflowExecutionJob } from './workflow-runtime.service.js';
import { isDomainEventContext, type DomainEventContext } from '@handstack/core';
import { DatabaseService } from '../database/database.service.js';
import { assertInternalServiceToken } from '../auth/internal-service-auth.js';

const triggers = ['manual', 'api', 'webhook', 'schedule', 'event'] as const;

@ApiExcludeController()
@Controller('internal/v1/workflows')
export class WorkflowWorkerController {
  constructor(
    @Inject(WorkflowRuntimeService) private readonly workflows: WorkflowRuntimeService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  @Post('execute')
  async execute(@Req() request: FastifyRequest, @Body() body: unknown) {
    this.authorize(request.headers.authorization);
    return this.workflows.executeQueued(parseJob(body));
  }

  private authorize(header: string | string[] | undefined): void {
    assertInternalServiceToken(header, this.database.config.security.internalServiceToken);
  }
}

function parseJob(value: unknown): WorkflowExecutionJob {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ValidationError('Workflow job payload must be an object');
  const candidate = value as Record<string, unknown>;
  const required = ['organizationId', 'operationId', 'workflowId', 'principalId', 'idempotencyKey'];
  const contextValid = candidate.context === undefined || isDomainEventContext(candidate.context);
  if (
    required.some((key) => typeof candidate[key] !== 'string' || candidate[key].trim() === '') ||
    typeof candidate.trigger !== 'string' ||
    !triggers.includes(candidate.trigger as (typeof triggers)[number]) ||
    !Object.hasOwn(candidate, 'payload') ||
    !contextValid
  )
    throw new ValidationError('Workflow job payload is invalid');
  return {
    organizationId: (candidate.organizationId as string).trim(),
    operationId: (candidate.operationId as string).trim(),
    workflowId: (candidate.workflowId as string).trim(),
    principalId: (candidate.principalId as string).trim(),
    ...(candidate.context === undefined
      ? {}
      : { context: candidate.context as DomainEventContext }),
    trigger: candidate.trigger as (typeof triggers)[number],
    payload: candidate.payload,
    idempotencyKey: (candidate.idempotencyKey as string).trim(),
  };
}
