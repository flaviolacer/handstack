import { randomUUID } from 'node:crypto';
import { AuthorizationError, ValidationError } from '@handstack/shared';
import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import {
  requireAuthentication,
  requestTraceContext,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { IncidentRuntimeService } from './incident-runtime.service.js';

const createSchema = z.object({
  id: z.string().trim().min(1).max(200).optional(),
  severity: z.enum(['SEV1', 'SEV2', 'SEV3', 'SEV4']),
  owner: z.string().trim().min(1).max(200),
  customerImpact: z.string().trim().min(1).max(10_000),
  affectedOrganizations: z.array(z.string().trim().min(1)).max(100).default([]),
  affectedCapabilities: z.array(z.string().trim().min(1)).max(100).default([]),
  rootCause: z.string().max(10_000).optional(),
});
const transitionSchema = z.object({
  status: z.enum([
    'DETECTED',
    'INVESTIGATING',
    'IDENTIFIED',
    'MITIGATING',
    'MONITORING',
    'RESOLVED',
    'POSTMORTEM',
  ]),
  message: z.string().max(10_000).optional(),
});
const timelineSchema = z.object({
  message: z.string().trim().min(1).max(10_000),
  customerSafe: z.boolean().default(false),
});
const actionSchema = z.object({
  description: z.string().trim().min(1).max(10_000).optional(),
  owner: z.string().trim().min(1).max(200).optional(),
  dueAt: z.coerce.date().optional(),
  completed: z.boolean().optional(),
});
const policySchema = z.object({
  capability: z.string().trim().min(1).max(200),
  levels: z
    .array(
      z.object({ afterMinutes: z.number().int().min(0), owner: z.string().trim().min(1).max(200) }),
    )
    .min(1)
    .max(20),
});

function eventContext(request: AuthenticatedRequest) {
  const auth = requireAuthentication(request);
  const trace = requestTraceContext(request);
  return {
    requestId: trace.requestId,
    traceId: trace.traceId,
    principalId: auth.subject,
    source: 'API' as const,
  };
}

@ApiTags('Incidents')
@ApiBearerAuth()
@Controller('api/v1/organizations/:organizationId/incidents')
@UseGuards(AccessTokenGuard)
export class IncidentController {
  private readonly administration: IdentityAdministrationService;
  constructor(
    @Inject(IncidentRuntimeService) private readonly runtime: IncidentRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }
  @Get()
  @ApiOperation({ summary: 'List tenant incidents' })
  async list(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'incidents.read');
    return { items: await this.runtime.list(organizationId) };
  }
  @Get(':id')
  async get(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'incidents.read');
    const incident = await this.runtime.get(organizationId, id);
    if (incident === undefined) throw new ValidationError('Incident not found');
    return incident;
  }
  @Post()
  @ApiOperation({ summary: 'Register an incident' })
  async create(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request, 'incidents.manage');
    const context = eventContext(request);
    const parsed = createSchema.safeParse(value);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid incident');
    const { id, rootCause, ...body } = parsed.data;
    return this.runtime.create(
      {
        id: id ?? randomUUID(),
        organizationId,
        status: 'DETECTED',
        startedAt: new Date(),
        detectedAt: new Date(),
        correctiveActions: [],
        ...body,
        ...(rootCause === undefined ? {} : { rootCause }),
      },
      context,
    );
  }
  @Patch(':id/status')
  async transition(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const auth = await this.authorize(organizationId, request, 'incidents.manage');
    const parsed = transitionSchema.safeParse(value);
    if (!parsed.success) throw new ValidationError('Invalid incident transition');
    return this.runtime.transition(
      {
        organizationId,
        id,
        status: parsed.data.status,
        actor: auth.subject,
        ...(parsed.data.message === undefined ? {} : { message: parsed.data.message }),
      },
      eventContext(request),
    );
  }
  @Post(':id/timeline')
  async timeline(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const auth = await this.authorize(organizationId, request, 'incidents.manage');
    const parsed = timelineSchema.safeParse(value);
    if (!parsed.success) throw new ValidationError('Invalid timeline entry');
    return this.runtime.addTimeline(
      { organizationId, id, actor: auth.subject, ...parsed.data },
      eventContext(request),
    );
  }
  @Patch(':id/actions/:actionId')
  async action(
    @Param('organizationId') organizationId: string,
    @Param('id') id: string,
    @Param('actionId') actionId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request, 'incidents.manage');
    const parsed = actionSchema.safeParse(value);
    if (!parsed.success) throw new ValidationError('Invalid corrective action');
    const { description, owner, dueAt, completed } = parsed.data;
    return this.runtime.updateAction(
      {
        organizationId,
        id,
        actionId,
        ...(description === undefined ? {} : { description }),
        ...(owner === undefined ? {} : { owner }),
        ...(dueAt === undefined ? {} : { dueAt }),
        ...(completed === undefined ? {} : { completed }),
      },
      eventContext(request),
    );
  }
  @Get('escalation-policies/:capability')
  async policy(
    @Param('organizationId') organizationId: string,
    @Param('capability') capability: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'incidents.read');
    return (
      (await this.runtime.getEscalationPolicy(organizationId, capability)) ?? {
        capability,
        levels: [],
      }
    );
  }
  @Post('escalation-policies')
  async setPolicy(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request, 'incidents.manage');
    const parsed = policySchema.safeParse(value);
    if (!parsed.success) throw new ValidationError('Invalid escalation policy');
    return this.runtime.setEscalationPolicy({ organizationId, ...parsed.data });
  }
  private async authorize(
    organizationId: string,
    request: AuthenticatedRequest,
    permission: string,
  ) {
    const auth = requireAuthentication(request);
    if (auth.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization incident access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: auth.subject,
      permission,
    });
    if (!decision.allowed) throw new AuthorizationError(`${permission} permission is required`);
    return auth;
  }
}

@ApiTags('Status')
@Controller('api/v1/status')
export class IncidentStatusController {
  constructor(@Inject(IncidentRuntimeService) private readonly runtime: IncidentRuntimeService) {}
  @Get('incidents')
  @ApiOperation({ summary: 'Customer-safe incident status' })
  async list() {
    return { items: await this.runtime.publicList() };
  }
}
