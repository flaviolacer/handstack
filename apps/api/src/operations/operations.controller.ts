import { AuthorizationError, ValidationError } from '@handstack/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Put,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { JobQueueName } from '@handstack/jobs';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import {
  requireAuthentication,
  requestTraceContext,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { OperationsRuntimeService } from './operations-runtime.service.js';

const flagSchema = z.object({
  scope: z.enum(['global', 'organization', 'user']),
  enabled: z.boolean(),
  userId: z.string().trim().min(1).optional(),
});
const jobSchema = z.object({
  id: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1),
  payload: z.unknown(),
  priority: z.number().int().optional(),
});
const operationSchema = z
  .object({
    type: z.string().trim().min(1).max(128),
  })
  .strict();
const queues = [
  'agents',
  'embeddings',
  'documents',
  'plugins',
  'webhooks',
  'audit',
  'billing',
  'cleanup',
  'indexing',
] as const;

@ApiTags('Operations')
@ApiBearerAuth()
@Controller('api/v1/organizations/:organizationId')
@UseGuards(AccessTokenGuard)
export class OperationsController {
  private readonly administration: IdentityAdministrationService;
  constructor(
    @Inject(OperationsRuntimeService) private readonly runtime: OperationsRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get('feature-flags')
  @ApiOperation({ summary: 'List feature flags resolved for the authenticated user' })
  async listFlags(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const auth = await this.authorize(organizationId, request, 'feature-flags.read');
    return { items: await this.runtime.listFeatureFlags(organizationId, auth.subject) };
  }

  @Put('feature-flags/:key')
  @ApiOperation({ summary: 'Set an organization or user feature flag' })
  async setFlag(
    @Param('organizationId') organizationId: string,
    @Param('key') key: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const auth = await this.authorize(organizationId, request, 'feature-flags.manage');
    const parsed = flagSchema.safeParse(value);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid feature flag');
    const body = parsed.data;
    return this.runtime.setFeatureFlag({
      key,
      scope: body.scope,
      enabled: body.enabled,
      ...(body.scope === 'global'
        ? {}
        : body.scope === 'organization'
          ? { organizationId }
          : { organizationId, userId: body.userId ?? auth.subject }),
    });
  }

  @Get('audit')
  @ApiOperation({ summary: 'Query append-only audit events for the organization' })
  async audit(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const auth = await this.authorize(organizationId, request, 'audit.read');
    const items = await this.runtime.audit.query(organizationId);
    const trace = requestTraceContext(request);
    await this.runtime.audit.record({
      organizationId,
      actorId: auth.subject,
      action: 'AUDIT_QUERIED',
      resourceType: 'audit',
      decision: 'ALLOW',
      metadata: { returned: String(items.length) },
      context: {
        requestId: trace.requestId,
        traceId: trace.traceId,
        principalId: auth.subject,
        source: 'API',
      },
    });
    return { items };
  }

  @Get('audit/verify')
  @ApiOperation({ summary: 'Verify the organization audit hash chain' })
  async verifyAudit(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const auth = await this.authorize(organizationId, request, 'audit.read');
    const result = await this.runtime.audit.verify(organizationId);
    const trace = requestTraceContext(request);
    await this.runtime.audit.record({
      organizationId,
      actorId: auth.subject,
      action: 'AUDIT_VERIFIED',
      resourceType: 'audit',
      decision: result.valid ? 'ALLOW' : 'DENY',
      metadata: { checked: String(result.checked), valid: String(result.valid) },
      context: {
        requestId: trace.requestId,
        traceId: trace.traceId,
        principalId: auth.subject,
        source: 'API',
      },
    });
    return result;
  }

  @Post('jobs/:queue')
  @ApiOperation({ summary: 'Enqueue a bounded background job' })
  async enqueue(
    @Param('organizationId') organizationId: string,
    @Param('queue') queue: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const auth = await this.authorize(organizationId, request, 'jobs.manage');
    const trace = requestTraceContext(request);
    if (!(queues as readonly string[]).includes(queue))
      throw new ValidationError('Unknown job queue');
    const parsed = jobSchema.safeParse(value);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid job');
    return await this.runtime.queue(queue as JobQueueName, organizationId).enqueue({
      id: parsed.data.id,
      idempotencyKey: parsed.data.idempotencyKey,
      payload: parsed.data.payload,
      ...(parsed.data.priority === undefined ? {} : { priority: parsed.data.priority }),
      context: {
        requestId: trace.requestId,
        traceId: trace.traceId,
        principalId: auth.subject,
        source: 'API',
      },
    });
  }

  @Get('jobs/:queue/dead-letters')
  @ApiOperation({ summary: 'Inspect dead-lettered jobs for the organization' })
  async deadLetters(
    @Param('organizationId') organizationId: string,
    @Param('queue') queue: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'jobs.read');
    const jobQueue = this.parseQueue(queue);
    return { items: await this.runtime.queue(jobQueue, organizationId).listDeadLetters() };
  }

  @Post('jobs/:queue/dead-letters/:idempotencyKey/retry')
  @ApiOperation({ summary: 'Retry one dead-lettered job' })
  async retryDeadLetter(
    @Param('organizationId') organizationId: string,
    @Param('queue') queue: string,
    @Param('idempotencyKey') idempotencyKey: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const auth = await this.authorize(organizationId, request, 'jobs.manage');
    const trace = requestTraceContext(request);
    const jobQueue = this.parseQueue(queue);
    const job = await this.runtime.queue(jobQueue, organizationId).retryDeadLetter(idempotencyKey);
    if (job === undefined) throw new ValidationError('Dead-letter job was not found');
    await this.runtime.audit.record({
      organizationId,
      actorId: auth.subject,
      action: 'JOB_DEAD_LETTER_RETRIED',
      resourceType: 'job',
      resourceId: job.id,
      context: {
        requestId: trace.requestId,
        traceId: trace.traceId,
        principalId: auth.subject,
        source: 'API',
      },
      metadata: { queue: jobQueue, idempotencyKey },
    });
    return { job };
  }

  @Delete('jobs/:queue/dead-letters/:idempotencyKey')
  @ApiOperation({ summary: 'Discard one dead-lettered job with audit' })
  async discardDeadLetter(
    @Param('organizationId') organizationId: string,
    @Param('queue') queue: string,
    @Param('idempotencyKey') idempotencyKey: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const auth = await this.authorize(organizationId, request, 'jobs.manage');
    const trace = requestTraceContext(request);
    const jobQueue = this.parseQueue(queue);
    const discarded = await this.runtime
      .queue(jobQueue, organizationId)
      .discardDeadLetter(idempotencyKey);
    if (!discarded) throw new ValidationError('Dead-letter job was not found');
    await this.runtime.audit.record({
      organizationId,
      actorId: auth.subject,
      action: 'JOB_DEAD_LETTER_DISCARDED',
      resourceType: 'job',
      resourceId: idempotencyKey,
      context: {
        requestId: trace.requestId,
        traceId: trace.traceId,
        principalId: auth.subject,
        source: 'API',
      },
      metadata: { queue: jobQueue, idempotencyKey },
    });
    return { discarded: true };
  }

  private parseQueue(queue: string): JobQueueName {
    if (!(queues as readonly string[]).includes(queue))
      throw new ValidationError('Unknown job queue');
    return queue as JobQueueName;
  }

  private async authorize(
    organizationId: string,
    request: AuthenticatedRequest,
    permission: string,
  ) {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization operations access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission,
    });
    if (!decision.allowed) throw new AuthorizationError(`${permission} permission is required`);
    return authentication;
  }
}

@ApiTags('Operations')
@ApiBearerAuth()
@Controller('api/v1/operations')
@UseGuards(AccessTokenGuard)
export class AsyncOperationsController {
  private readonly administration: IdentityAdministrationService;

  constructor(
    @Inject(OperationsRuntimeService) private readonly runtime: OperationsRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Create an organization-scoped asynchronous operation' })
  async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: FastifyReply,
    @Body() value: unknown,
  ) {
    const auth = await this.authorize(request, 'operations.manage');
    if (idempotencyKey === undefined || idempotencyKey.trim() === '')
      throw new ValidationError('Idempotency-Key is required');
    const parsed = operationSchema.safeParse(value);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid operation');
    const operation = await this.runtime.createOperation({
      organizationId: auth.organizationId,
      type: parsed.data.type,
      idempotencyKey: idempotencyKey.trim(),
      context: {
        ...requestTraceContext(request),
        principalId: auth.subject,
        source: 'API',
      },
    });
    response.header('etag', operationEtag(operation.version));
    return operation;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read an organization-scoped asynchronous operation' })
  async get(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ) {
    const auth = await this.authorize(request, 'operations.read');
    const operation = await this.runtime.getOperation(auth.organizationId, id);
    if (operation === undefined) throw new ValidationError('Operation was not found');
    response.header('etag', operationEtag(operation.version));
    return operation;
  }

  @Post(':id/cancel')
  @ApiHeader({ name: 'If-Match', required: false })
  @ApiOperation({ summary: 'Cancel an organization-scoped asynchronous operation' })
  async cancel(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ) {
    const auth = await this.authorize(request, 'operations.manage');
    const operation = await this.runtime.getOperation(auth.organizationId, id);
    if (operation === undefined) throw new ValidationError('Operation was not found');
    if (ifMatch !== undefined && ifMatch !== operationEtag(operation.version))
      throw new ValidationError('If-Match does not match the operation version');
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(operation.status)) {
      response.header('etag', operationEtag(operation.version));
      return operation;
    }
    const cancelled = await this.runtime.operations.update(
      { ...operation, status: 'CANCELLED', cancelRequested: true },
      operation.version,
    );
    await this.runtime.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.subject,
      action: 'OPERATION_CANCELLED',
      resourceType: 'operation',
      resourceId: operation.id,
      metadata: { type: operation.type },
    });
    response.header('etag', operationEtag(cancelled.version));
    return cancelled;
  }

  private async authorize(request: AuthenticatedRequest, permission: string) {
    const authentication = requireAuthentication(request);
    const decision = await this.administration.authorize({
      organizationId: authentication.organizationId,
      principalId: authentication.subject,
      permission,
    });
    if (!decision.allowed) throw new AuthorizationError(`${permission} permission is required`);
    return authentication;
  }
}

function operationEtag(version: number): string {
  return `"${String(version)}"`;
}
