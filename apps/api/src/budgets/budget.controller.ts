import { BudgetRuntimeService } from './budget-runtime.service.js';
import { AuthorizationError, ValidationError } from '@handstack/shared';
import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import {
  requireAuthentication,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { IdentityAdministrationService } from '@handstack/identity-service';

const createSchema = z.object({
  scopeType: z.enum([
    'ORGANIZATION',
    'GROUP',
    'USER',
    'API_KEY',
    'APPLICATION',
    'AGENT',
    'MODEL',
    'PROVIDER',
    'CAPABILITY',
  ]),
  scopeKey: z.string().trim().min(1),
  period: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM']),
  strategy: z.enum(['HARD_LIMIT', 'SOFT_LIMIT', 'ALERT_ONLY']),
  limitUsd: z.number().nonnegative(),
  customStart: z.coerce.date().optional(),
  customEnd: z.coerce.date().optional(),
});
const pricingSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  inputUsdPerMillionTokens: z.number().nonnegative(),
  outputUsdPerMillionTokens: z.number().nonnegative(),
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().optional(),
});

@ApiTags('Budgets and usage')
@ApiBearerAuth()
@Controller('api/v1/organizations/:organizationId')
@UseGuards(AccessTokenGuard)
export class BudgetController {
  private readonly administration: IdentityAdministrationService;

  constructor(
    @Inject(BudgetRuntimeService) private readonly runtime: BudgetRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get('budgets')
  @ApiOperation({ summary: 'List organization budgets' })
  async listBudgets(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.runtime.engine.listBudgets(organizationId);
  }

  @Post('budgets')
  @ApiOperation({ summary: 'Create an organization budget' })
  async createBudget(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const parsed = createSchema.safeParse(value);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid budget');
    const body = parsed.data;
    return this.runtime.engine.createBudget({
      organizationId,
      scope: { type: body.scopeType, key: body.scopeKey },
      period: body.period,
      strategy: body.strategy,
      limitUsd: body.limitUsd,
      ...(body.customStart === undefined ? {} : { customStart: body.customStart }),
      ...(body.customEnd === undefined ? {} : { customEnd: body.customEnd }),
    });
  }

  @Get('usage')
  @ApiOperation({ summary: 'List usage records for the organization' })
  async usage(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.runtime.engine.listUsage(organizationId);
  }

  @Post('pricing/models')
  @ApiOperation({ summary: 'Create a versioned model pricing record' })
  async createPricing(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const parsed = pricingSchema.safeParse(value);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid pricing');
    return this.runtime.pricing.setModelPricing({
      organizationId,
      currency: 'USD',
      provider: parsed.data.provider,
      model: parsed.data.model,
      inputUsdPerMillionTokens: parsed.data.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: parsed.data.outputUsdPerMillionTokens,
      effectiveFrom: parsed.data.effectiveFrom,
      ...(parsed.data.effectiveTo === undefined ? {} : { effectiveTo: parsed.data.effectiveTo }),
    });
  }

  private async authorize(organizationId: string, request: AuthenticatedRequest) {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization budget access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission: 'budget.manage',
    });
    if (!decision.allowed) throw new AuthorizationError('budget.manage permission is required');
  }
}
