import { AuthorizationError, ValidationError } from '@handstack/shared';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import {
  requireAuthentication,
  requestTraceContext,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { WorkflowRuntimeService } from './workflow-runtime.service.js';

const nodeSchema = z.object({
  id: z.string().trim().min(1).max(128),
  kind: z.enum([
    'Agent',
    'Capability',
    'LLM',
    'Tool',
    'MCP',
    'Condition',
    'Human Approval',
    'Loop',
  ]),
  config: z.record(z.string(), z.unknown()).default({}),
});
const edgeSchema = z.object({
  from: z.string().trim().min(1).max(128),
  to: z.string().trim().min(1).max(128),
  condition: z.string().max(2_000).optional(),
});
const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  trigger: z.enum(['manual', 'api', 'webhook', 'schedule', 'event']),
  nodes: z.array(nodeSchema).min(1).max(100),
  edges: z.array(edgeSchema).max(200),
  triggerConfig: z
    .object({
      eventName: z.string().trim().min(1).max(200).optional(),
      intervalSeconds: z.number().int().min(1).max(31_536_000).optional(),
    })
    .optional(),
});
const startSchema = z.object({
  trigger: z.enum(['manual', 'api', 'webhook', 'schedule', 'event']),
  payload: z.unknown(),
});
const approveSchema = z.object({ approverId: z.string().trim().min(1).max(200) });

@ApiTags('Workflows')
@ApiBearerAuth()
@Controller('api/v1/organizations/:organizationId/workflows')
@UseGuards(AccessTokenGuard)
export class WorkflowController {
  private readonly administration: IdentityAdministrationService;

  constructor(
    @Inject(WorkflowRuntimeService) private readonly runtime: WorkflowRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get()
  @ApiOperation({ summary: 'List workflows for an organization' })
  async list(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'workflows.read');
    return { items: await this.runtime.list(organizationId) };
  }

  @Post()
  @ApiOperation({ summary: 'Create a workflow draft' })
  async create(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request, 'workflows.manage');
    const parsed = createSchema.safeParse(value);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid workflow');
    return this.runtime.create({
      organizationId,
      name: parsed.data.name,
      trigger: parsed.data.trigger,
      nodes: parsed.data.nodes,
      edges: parsed.data.edges.map((edge) =>
        edge.condition === undefined
          ? { from: edge.from, to: edge.to }
          : { from: edge.from, to: edge.to, condition: edge.condition },
      ),
      ...(parsed.data.triggerConfig === undefined
        ? {}
        : {
            triggerConfig: {
              ...(parsed.data.triggerConfig.eventName === undefined
                ? {}
                : { eventName: parsed.data.triggerConfig.eventName }),
              ...(parsed.data.triggerConfig.intervalSeconds === undefined
                ? {}
                : { intervalSeconds: parsed.data.triggerConfig.intervalSeconds }),
            },
          }),
    });
  }

  @Post('events/:eventName')
  @ApiOperation({ summary: 'Dispatch an event-triggered workflow' })
  async dispatchEvent(
    @Param('organizationId') organizationId: string,
    @Param('eventName') eventName: string,
    @Req() request: AuthenticatedRequest,
    @Body() payload: unknown,
  ) {
    const authentication = await this.authorize(organizationId, request, 'workflows.run');
    return {
      items: await this.runtime.dispatchEvent({
        organizationId,
        eventName,
        principalId: authentication.subject,
        payload,
      }),
    };
  }

  @Post('schedules/tick')
  @ApiOperation({ summary: 'Dispatch due scheduled workflows' })
  async dispatchSchedules(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() payload: unknown,
  ) {
    const authentication = await this.authorize(organizationId, request, 'workflows.run');
    return {
      items: await this.runtime.dispatchDueSchedules({
        organizationId,
        principalId: authentication.subject,
        payload,
      }),
    };
  }

  @Post(':workflowId/publish')
  @ApiOperation({ summary: 'Publish a workflow' })
  async publish(
    @Param('organizationId') organizationId: string,
    @Param('workflowId') workflowId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'workflows.manage');
    return this.runtime.publish(organizationId, workflowId);
  }

  @Post(':workflowId/executions')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Start a workflow execution' })
  async start(
    @Param('organizationId') organizationId: string,
    @Param('workflowId') workflowId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const authentication = await this.authorize(organizationId, request, 'workflows.run');
    const parsed = startSchema.safeParse(value);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid execution');
    if (idempotencyKey === undefined || idempotencyKey.trim() === '')
      throw new ValidationError('Idempotency-Key is required');
    return this.runtime.startAsync({
      organizationId,
      workflowId,
      principalId: authentication.subject,
      ...parsed.data,
      idempotencyKey: idempotencyKey.trim(),
      context: {
        ...requestTraceContext(request),
        principalId: authentication.subject,
        source: 'API',
      },
    });
  }

  @Get(':workflowId/executions/:executionId')
  @ApiOperation({ summary: 'Get workflow execution' })
  async getExecution(
    @Param('organizationId') organizationId: string,
    @Param('workflowId') workflowId: string,
    @Param('executionId') executionId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'workflows.read');
    const execution = await this.runtime.getExecution(organizationId, executionId);
    if (execution.workflowId !== workflowId)
      throw new ValidationError('Workflow execution not found');
    return execution;
  }

  @Get(':workflowId/executions/:executionId/steps')
  @ApiOperation({ summary: 'List workflow step execution history' })
  async listSteps(
    @Param('organizationId') organizationId: string,
    @Param('workflowId') workflowId: string,
    @Param('executionId') executionId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'workflows.read');
    const execution = await this.runtime.getExecution(organizationId, executionId);
    if (execution.workflowId !== workflowId)
      throw new ValidationError('Workflow execution not found');
    return { items: await this.runtime.listSteps(organizationId, executionId) };
  }

  @Post(':workflowId/executions/:executionId/approve')
  @ApiOperation({ summary: 'Approve and resume a workflow execution' })
  async approve(
    @Param('organizationId') organizationId: string,
    @Param('workflowId') workflowId: string,
    @Param('executionId') executionId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const authentication = await this.authorize(organizationId, request, 'workflows.run');
    const current = await this.runtime.getExecution(organizationId, executionId);
    if (current.workflowId !== workflowId)
      throw new ValidationError('Workflow execution not found');
    const parsed = approveSchema.safeParse(value);
    if (!parsed.success || parsed.data.approverId !== authentication.subject)
      throw new AuthorizationError('Approver must match authenticated principal');
    return this.runtime.approve({
      organizationId,
      executionId,
      approverId: parsed.data.approverId,
    });
  }

  @Post(':workflowId/executions/:executionId/recover')
  @ApiOperation({ summary: 'Recover a workflow execution after a process failure' })
  async recover(
    @Param('organizationId') organizationId: string,
    @Param('workflowId') workflowId: string,
    @Param('executionId') executionId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'workflows.run');
    const current = await this.runtime.getExecution(organizationId, executionId);
    if (current.workflowId !== workflowId)
      throw new ValidationError('Workflow execution not found');
    return this.runtime.recover({ organizationId, executionId });
  }

  private async authorize(
    organizationId: string,
    request: AuthenticatedRequest,
    permission: string,
  ) {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization workflow access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission,
    });
    if (!decision.allowed) throw new AuthorizationError(`${permission} permission is required`);
    return authentication;
  }
}
