import { createHash } from 'node:crypto';
import { uuidV7 } from '@handstack/domain';
import type { EvaluationDataset, EvaluationSuite, RedTeamCampaign } from '@handstack/evaluation';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { ModelRuntimeError } from '@handstack/model-runtime';
import type {
  EvaluationGate,
  ModelDefinition,
  Prompt,
  PromptEvaluationGate,
  PromptVersion,
  ProviderDefinition,
} from '@handstack/models';
import { AuthorizationError, ValidationError } from '@handstack/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  type SchemaObject,
} from '@nestjs/swagger';
import { z } from 'zod';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import {
  requireAuthentication,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import {
  createModelSchema,
  modelApprovalOverrideSchema,
  createModelResponseSchema,
  createPromptSchema,
  createPromptVersionSchema,
  createProviderSchema,
  createEvaluationDatasetSchema,
  createEvaluationRunSchema,
  createEvaluationSuiteSchema,
  createRedTeamCampaignSchema,
  emptyOperationSchema,
  evaluationDatasetPageSchema,
  evaluationGateRecordResponseSchema,
  evaluationRunResultSchema,
  evaluationSuitePageSchema,
  redTeamCampaignPageSchema,
  publicRedTeamCampaignSchema,
  modelPageSchema,
  modelResponseSchema,
  promptEvaluationGateRecordResponseSchema,
  promptPageSchema,
  promptVersionPageSchema,
  providerPageSchema,
  publicModelSchema,
  publicPromptSchema,
  publicPromptVersionSchema,
  publicProviderSchema,
  publicEvaluationDatasetSchema,
  publicEvaluationSuiteSchema,
  recordEvaluationGateSchema,
  type CreateEvaluationDatasetInput,
  type CreateEvaluationRunInput,
  type CreateEvaluationSuiteInput,
  type CreateRedTeamCampaignInput,
  type CreateModelInput,
  type CreateModelResponseInput,
  type CreatePromptInput,
  type CreatePromptVersionInput,
  type CreateProviderInput,
} from './model-admin.schemas.js';
import { ModelAdminRuntimeService } from './model-admin-runtime.service.js';

function schema(value: z.ZodType): SchemaObject {
  return z.toJSONSchema(value, { target: 'draft-7' }) as SchemaObject;
}

function parse<T>(definition: z.ZodType<T>, value: unknown): T {
  const result = definition.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ValidationError(issue?.message ?? 'Request validation failed');
  }
  return result.data;
}

function publicProvider(provider: ProviderDefinition) {
  const configuration = Object.fromEntries(
    Object.entries(provider.configuration ?? {}).filter(
      ([key]) => !/(secret|password|token|credential|api.?key)/i.test(key),
    ),
  );
  return {
    id: provider.id,
    organizationId: provider.organizationId,
    name: provider.name,
    adapter: provider.adapter,
    enabled: provider.enabled,
    ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
    configuration,
    hasSecret: provider.secretReference !== undefined,
    dataClassificationAllowed: provider.dataClassificationAllowed,
    version: provider.version,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

function publicModel(model: ModelDefinition) {
  return {
    id: model.id,
    organizationId: model.organizationId,
    displayName: model.displayName,
    providerId: model.providerId,
    providerModel: model.providerModel,
    aliases: model.aliases,
    capabilities: model.capabilities,
    contextWindow: model.contextWindow,
    pricing: model.pricing,
    lifecycle: model.lifecycle,
    ...(model.evaluationSuiteVersion === undefined
      ? {}
      : { evaluationSuiteVersion: model.evaluationSuiteVersion }),
    version: model.version,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

function publicPrompt(prompt: Prompt) {
  return {
    id: prompt.id,
    organizationId: prompt.organizationId,
    name: prompt.name,
    slug: prompt.slug,
    ...(prompt.description === undefined ? {} : { description: prompt.description }),
    version: prompt.version,
    createdAt: prompt.createdAt,
    updatedAt: prompt.updatedAt,
  };
}

function publicPromptVersion(promptVersion: PromptVersion) {
  return {
    id: promptVersion.id,
    organizationId: promptVersion.organizationId,
    promptId: promptVersion.promptId,
    versionLabel: promptVersion.versionLabel,
    content: promptVersion.content,
    contentDigest: promptVersion.contentDigest,
    variables: promptVersion.variables,
    modelDefinitionId: promptVersion.modelDefinitionId,
    lifecycle: promptVersion.lifecycle,
    ...(promptVersion.evaluationSuiteVersion === undefined
      ? {}
      : { evaluationSuiteVersion: promptVersion.evaluationSuiteVersion }),
    version: promptVersion.version,
    createdAt: promptVersion.createdAt,
    updatedAt: promptVersion.updatedAt,
  };
}

function publicDataset(dataset: EvaluationDataset) {
  return {
    id: dataset.id,
    organizationId: dataset.organizationId,
    name: dataset.name,
    datasetVersion: dataset.datasetVersion,
    classification: dataset.classification,
    provenance: dataset.provenance,
    owner: dataset.owner,
    retentionDays: dataset.retentionDays,
    sourceKind: dataset.sourceKind,
    approvedForEvaluation: dataset.approvedForEvaluation,
    sanitized: dataset.sanitized,
    hasLegalBasis: dataset.legalBasis !== undefined,
    caseCount: dataset.cases.length,
    version: dataset.version,
    createdAt: dataset.createdAt,
    updatedAt: dataset.updatedAt,
  };
}

function publicSuite(suite: EvaluationSuite) {
  return {
    id: suite.id,
    organizationId: suite.organizationId,
    name: suite.name,
    suiteVersion: suite.suiteVersion,
    datasetId: suite.datasetId,
    datasetVersion: suite.datasetVersion,
    criteria: suite.criteria,
    version: suite.version,
    createdAt: suite.createdAt,
    updatedAt: suite.updatedAt,
  };
}

function publicRedTeamCampaign(campaign: RedTeamCampaign) {
  return {
    id: campaign.id,
    organizationId: campaign.organizationId,
    targetKind: campaign.targetKind,
    targetId: campaign.targetId,
    campaignVersion: campaign.campaignVersion,
    status: campaign.status,
    scenarioCount: campaign.scenarios.length,
    findings: campaign.findings,
    ...(campaign.executedAt === undefined ? {} : { executedAt: campaign.executedAt }),
    ...(campaign.executionErrorDigest === undefined
      ? {}
      : { executionErrorDigest: campaign.executionErrorDigest }),
    version: campaign.version,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  };
}

@ApiTags('Providers and models')
@ApiBearerAuth()
@ApiParam({ name: 'organizationId', description: 'Organization scope' })
@ApiUnauthorizedResponse({ description: 'Bearer access token is missing or invalid' })
@ApiForbiddenResponse({ description: 'Organization mismatch or models.manage is missing' })
@Controller('api/v1/organizations/:organizationId')
@UseGuards(AccessTokenGuard)
export class ModelAdminController {
  private readonly administration: IdentityAdministrationService;

  constructor(
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
    @Inject(ModelAdminRuntimeService) private readonly runtime: ModelAdminRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get('providers')
  @ApiOperation({ summary: 'List model providers in the organization' })
  @ApiOkResponse({ schema: schema(providerPageSchema) })
  async listProviders(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    const page = await this.runtime.registry.listProviders(organizationId);
    return { ...page, items: page.items.map(publicProvider) };
  }

  @Post('providers')
  @ApiOperation({ summary: 'Register a model provider' })
  @ApiBody({ schema: schema(createProviderSchema) })
  @ApiCreatedResponse({ schema: schema(publicProviderSchema) })
  async createProvider(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const input = parse(createProviderSchema, value);
    const timestamp = new Date();
    return this.execute(() =>
      this.runtime.registry
        .registerProvider(this.providerEntity(organizationId, input, timestamp))
        .then(publicProvider),
    );
  }

  @Get('models')
  @ApiOperation({ summary: 'List model definitions in the organization' })
  @ApiOkResponse({ schema: schema(modelPageSchema) })
  async listModels(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    const page = await this.runtime.registry.listModels(organizationId);
    return { ...page, items: page.items.map(publicModel) };
  }

  @Post('models')
  @ApiOperation({ summary: 'Register a draft model definition' })
  @ApiBody({ schema: schema(createModelSchema) })
  @ApiCreatedResponse({ schema: schema(publicModelSchema) })
  async createModel(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const input = parse(createModelSchema, value);
    const timestamp = new Date();
    return this.execute(() =>
      this.runtime.registry
        .registerModel(this.modelEntity(organizationId, input, timestamp))
        .then(publicModel),
    );
  }

  @Get('prompts')
  @ApiOperation({ summary: 'List prompts in the organization' })
  @ApiOkResponse({ schema: schema(promptPageSchema) })
  async listPrompts(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'prompts.manage');
    const page = await this.runtime.registry.listPrompts(organizationId);
    return { ...page, items: page.items.map(publicPrompt) };
  }

  @Post('prompts')
  @ApiOperation({ summary: 'Register a prompt' })
  @ApiBody({ schema: schema(createPromptSchema) })
  @ApiCreatedResponse({ schema: schema(publicPromptSchema) })
  async createPrompt(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request, 'prompts.manage');
    const input: CreatePromptInput = parse(createPromptSchema, value);
    const timestamp = new Date();
    return this.execute(() =>
      this.runtime.registry
        .registerPrompt(this.promptEntity(organizationId, input, timestamp))
        .then(publicPrompt),
    );
  }

  @Get('prompts/:promptId/versions')
  @ApiParam({ name: 'promptId', description: 'Internal prompt ID' })
  @ApiOperation({ summary: 'List immutable prompt versions' })
  @ApiOkResponse({ schema: schema(promptVersionPageSchema) })
  async listPromptVersions(
    @Param('organizationId') organizationId: string,
    @Param('promptId') promptId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'prompts.manage');
    const items = await this.runtime.registry.listPromptVersions(organizationId, promptId);
    return { items: items.map(publicPromptVersion) };
  }

  @Post('prompts/:promptId/versions')
  @ApiParam({ name: 'promptId', description: 'Internal prompt ID' })
  @ApiOperation({ summary: 'Register an immutable draft prompt version' })
  @ApiBody({ schema: schema(createPromptVersionSchema) })
  @ApiCreatedResponse({ schema: schema(publicPromptVersionSchema) })
  async createPromptVersion(
    @Param('organizationId') organizationId: string,
    @Param('promptId') promptId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request, 'prompts.manage');
    const input: CreatePromptVersionInput = parse(createPromptVersionSchema, value);
    const timestamp = new Date();
    return this.execute(() =>
      this.runtime.registry
        .registerPromptVersion(this.promptVersionEntity(organizationId, promptId, input, timestamp))
        .then(publicPromptVersion),
    );
  }

  @Get('evaluation-datasets')
  @ApiOperation({ summary: 'List governed evaluation dataset metadata' })
  @ApiOkResponse({ schema: schema(evaluationDatasetPageSchema) })
  async listEvaluationDatasets(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    const page = await this.runtime.evaluation.listDatasets(organizationId);
    return { ...page, items: page.items.map(publicDataset) };
  }

  @Post('evaluation-datasets')
  @ApiOperation({ summary: 'Register an approved, versioned evaluation dataset' })
  @ApiBody({ schema: schema(createEvaluationDatasetSchema) })
  @ApiCreatedResponse({ schema: schema(publicEvaluationDatasetSchema) })
  async createEvaluationDataset(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const input = parse(createEvaluationDatasetSchema, value);
    const timestamp = new Date();
    return this.execute(() =>
      this.runtime.evaluation
        .registerDataset(this.datasetEntity(organizationId, input, timestamp))
        .then(publicDataset),
    );
  }

  @Get('evaluation-suites')
  @ApiOperation({ summary: 'List versioned evaluation suites' })
  @ApiOkResponse({ schema: schema(evaluationSuitePageSchema) })
  async listEvaluationSuites(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    const page = await this.runtime.evaluation.listSuites(organizationId);
    return { ...page, items: page.items.map(publicSuite) };
  }

  @Post('evaluation-suites')
  @ApiOperation({ summary: 'Register a versioned evaluation suite and its release criteria' })
  @ApiBody({ schema: schema(createEvaluationSuiteSchema) })
  @ApiCreatedResponse({ schema: schema(publicEvaluationSuiteSchema) })
  async createEvaluationSuite(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const input = parse(createEvaluationSuiteSchema, value);
    const timestamp = new Date();
    return this.execute(() =>
      this.runtime.evaluation
        .registerSuite(this.suiteEntity(organizationId, input, timestamp))
        .then(publicSuite),
    );
  }

  @Get('red-team-campaigns')
  @ApiOperation({ summary: 'List versioned red-team campaigns' })
  @ApiOkResponse({ schema: schema(redTeamCampaignPageSchema) })
  async listRedTeamCampaigns(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'models.manage');
    const page = await this.runtime.redTeam.list(organizationId);
    return { ...page, items: page.items.map(publicRedTeamCampaign) };
  }

  @Post('red-team-campaigns')
  @ApiOperation({ summary: 'Register a governed red-team campaign' })
  @ApiBody({ schema: schema(createRedTeamCampaignSchema) })
  @ApiCreatedResponse({ schema: schema(publicRedTeamCampaignSchema) })
  async createRedTeamCampaign(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request, 'models.manage');
    const input: CreateRedTeamCampaignInput = parse(createRedTeamCampaignSchema, value);
    const timestamp = new Date();
    const campaign: RedTeamCampaign = {
      id: uuidV7(timestamp.getTime()),
      tenantId: organizationId,
      organizationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...input,
      status: 'DRAFT',
      findings: [],
    };
    return this.execute(() => this.runtime.redTeam.register(campaign).then(publicRedTeamCampaign));
  }

  @Post('red-team-campaigns/:campaignId/execute')
  @ApiParam({ name: 'campaignId', description: 'Red-team campaign ID' })
  @ApiOperation({ summary: 'Execute a governed red-team campaign' })
  @ApiCreatedResponse({ schema: schema(publicRedTeamCampaignSchema) })
  async executeRedTeamCampaign(
    @Param('organizationId') organizationId: string,
    @Param('campaignId') campaignId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'models.manage');
    return this.execute(() =>
      this.runtime.redTeam.execute(organizationId, campaignId).then(publicRedTeamCampaign),
    );
  }

  @Post('evaluation-runs')
  @ApiOperation({ summary: 'Execute a versioned suite against a model candidate' })
  @ApiBody({ schema: schema(createEvaluationRunSchema) })
  @ApiCreatedResponse({ schema: schema(evaluationRunResultSchema) })
  async createEvaluationRun(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const input: CreateEvaluationRunInput = parse(createEvaluationRunSchema, value);
    await this.authorize(
      organizationId,
      request,
      input.promptVersionId === undefined ? 'models.manage' : 'prompts.manage',
    );
    return this.execute(async () => {
      const promptVersionId = input.promptVersionId;
      if (promptVersionId === undefined)
        return this.runtime.evaluation.run({
          organizationId,
          modelDefinitionId: input.modelDefinitionId,
          suiteId: input.suiteId,
          suiteVersion: input.suiteVersion,
        });
      const promptVersion = await this.runtime.registry.getPromptVersion(
        organizationId,
        promptVersionId,
      );
      if (promptVersion === undefined) throw new Error('Prompt version not found');
      if (promptVersion.modelDefinitionId !== input.modelDefinitionId)
        throw new Error('Prompt model route does not match evaluation model');
      return this.runtime.evaluation.run({
        organizationId,
        modelDefinitionId: input.modelDefinitionId,
        suiteId: input.suiteId,
        suiteVersion: input.suiteVersion,
        promptVersionId,
        promptContentDigest: promptVersion.contentDigest,
      });
    });
  }

  @Post('models/:modelId/evaluation-gates')
  @ApiParam({ name: 'modelId', description: 'Internal model definition ID' })
  @ApiOperation({ summary: 'Record a gate from a persisted evaluation run' })
  @ApiBody({ schema: schema(recordEvaluationGateSchema) })
  @ApiCreatedResponse({ schema: schema(evaluationGateRecordResponseSchema) })
  async recordEvaluationGate(
    @Param('organizationId') organizationId: string,
    @Param('modelId') modelId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const { runId } = parse(recordEvaluationGateSchema, value);
    return this.execute(async () => {
      const run = await this.runtime.evaluation.getRun(organizationId, runId);
      if (run === undefined) throw new Error('Evaluation run not found');
      const result = {
        runId: run.id,
        datasetVersion: run.datasetVersion,
        passed: run.passed,
        scores: run.scores,
      };
      const timestamp = new Date();
      const gate: EvaluationGate = {
        id: uuidV7(timestamp.getTime()),
        tenantId: organizationId,
        organizationId,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        modelDefinitionId: modelId,
        suiteId: run.suiteId,
        suiteVersion: run.suiteVersion,
        datasetVersion: run.datasetVersion,
        runId: run.id,
        passed: run.passed,
        evaluatedAt: timestamp,
        scores: run.scores,
      };
      const model = await this.runtime.registry.recordGate(gate, result);
      return { run: result, model: publicModel(model) };
    });
  }

  @Post('models/:modelId/approve')
  @ApiParam({ name: 'modelId', description: 'Internal model definition ID' })
  @ApiOperation({ summary: 'Approve a model that passed its persisted evaluation gate' })
  @ApiBody({ required: false, schema: schema(emptyOperationSchema) })
  @ApiCreatedResponse({ schema: schema(publicModelSchema) })
  async approveModel(
    @Param('organizationId') organizationId: string,
    @Param('modelId') modelId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.execute(() =>
      this.runtime.registry.approve(organizationId, modelId).then(publicModel),
    );
  }

  @Post('models/:modelId/publish')
  @ApiParam({ name: 'modelId', description: 'Internal model definition ID' })
  @ApiOperation({ summary: 'Publish an approved model with a current persisted gate' })
  @ApiBody({ required: false, schema: schema(emptyOperationSchema) })
  @ApiCreatedResponse({ schema: schema(publicModelSchema) })
  async publishModel(
    @Param('organizationId') organizationId: string,
    @Param('modelId') modelId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.execute(() =>
      this.runtime.registry.publish(organizationId, modelId).then(publicModel),
    );
  }

  @Post('models/:modelId/approval-override')
  @ApiParam({ name: 'modelId', description: 'Internal model definition ID' })
  @ApiOperation({ summary: 'Override model evaluation approval with expiry and justification' })
  @ApiBody({ schema: schema(modelApprovalOverrideSchema) })
  @ApiCreatedResponse({ schema: schema(publicModelSchema) })
  async overrideModelApproval(
    @Param('organizationId') organizationId: string,
    @Param('modelId') modelId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request, 'models.override');
    const input = parse(modelApprovalOverrideSchema, value);
    const authentication = requireAuthentication(request);
    return this.execute(() =>
      this.runtime.registry
        .overrideApproval(organizationId, modelId, {
          approvedBy: authentication.subject,
          justification: input.justification,
          expiresAt: new Date(input.expiresAt),
        })
        .then(publicModel),
    );
  }

  @Post('prompt-versions/:promptVersionId/evaluation-gates')
  @ApiParam({ name: 'promptVersionId', description: 'Immutable prompt version ID' })
  @ApiOperation({ summary: 'Record a prompt-version gate from a persisted evaluation run' })
  @ApiBody({ schema: schema(recordEvaluationGateSchema) })
  @ApiCreatedResponse({ schema: schema(promptEvaluationGateRecordResponseSchema) })
  async recordPromptEvaluationGate(
    @Param('organizationId') organizationId: string,
    @Param('promptVersionId') promptVersionId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request, 'prompts.manage');
    const { runId } = parse(recordEvaluationGateSchema, value);
    return this.execute(async () => {
      const run = await this.runtime.evaluation.getRun(organizationId, runId);
      const promptVersion = await this.runtime.registry.getPromptVersion(
        organizationId,
        promptVersionId,
      );
      if (run === undefined) throw new Error('Evaluation run not found');
      if (promptVersion === undefined) throw new Error('Prompt version not found');
      if (
        run.promptVersionId !== promptVersion.id ||
        run.promptContentDigest !== promptVersion.contentDigest ||
        run.modelDefinitionId !== promptVersion.modelDefinitionId
      )
        throw new Error('Prompt evaluation run does not match version snapshot');
      const result = {
        runId: run.id,
        datasetVersion: run.datasetVersion,
        passed: run.passed,
        scores: run.scores,
      };
      const timestamp = new Date();
      const gate: PromptEvaluationGate = {
        id: uuidV7(timestamp.getTime()),
        tenantId: organizationId,
        organizationId,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        modelDefinitionId: promptVersion.modelDefinitionId,
        promptVersionId: promptVersion.id,
        promptContentDigest: promptVersion.contentDigest,
        suiteId: run.suiteId,
        suiteVersion: run.suiteVersion,
        datasetVersion: run.datasetVersion,
        runId: run.id,
        passed: run.passed,
        evaluatedAt: timestamp,
        scores: run.scores,
      };
      const updated = await this.runtime.registry.recordPromptGate(gate, result);
      return { run: result, promptVersion: publicPromptVersion(updated) };
    });
  }

  @Post('prompt-versions/:promptVersionId/approve')
  @ApiParam({ name: 'promptVersionId', description: 'Immutable prompt version ID' })
  @ApiOperation({ summary: 'Approve an evaluated prompt version' })
  @ApiBody({ required: false, schema: schema(emptyOperationSchema) })
  @ApiCreatedResponse({ schema: schema(publicPromptVersionSchema) })
  async approvePromptVersion(
    @Param('organizationId') organizationId: string,
    @Param('promptVersionId') promptVersionId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'prompts.manage');
    return this.execute(() =>
      this.runtime.registry
        .approvePromptVersion(organizationId, promptVersionId)
        .then(publicPromptVersion),
    );
  }

  @Post('prompt-versions/:promptVersionId/publish')
  @ApiParam({ name: 'promptVersionId', description: 'Immutable prompt version ID' })
  @ApiOperation({ summary: 'Publish an approved prompt version with a current gate' })
  @ApiBody({ required: false, schema: schema(emptyOperationSchema) })
  @ApiCreatedResponse({ schema: schema(publicPromptVersionSchema) })
  async publishPromptVersion(
    @Param('organizationId') organizationId: string,
    @Param('promptVersionId') promptVersionId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'prompts.manage');
    return this.execute(() =>
      this.runtime.registry
        .publishPromptVersion(organizationId, promptVersionId)
        .then(publicPromptVersion),
    );
  }

  @Post('prompt-versions/:promptVersionId/approval-override')
  @ApiParam({ name: 'promptVersionId', description: 'Immutable prompt version ID' })
  @ApiOperation({ summary: 'Override prompt evaluation approval with expiry and justification' })
  @ApiBody({ schema: schema(modelApprovalOverrideSchema) })
  @ApiCreatedResponse({ schema: schema(publicPromptVersionSchema) })
  async overridePromptApproval(
    @Param('organizationId') organizationId: string,
    @Param('promptVersionId') promptVersionId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request, 'prompts.override');
    const input = parse(modelApprovalOverrideSchema, value);
    const authentication = requireAuthentication(request);
    return this.execute(() =>
      this.runtime.registry
        .overridePromptApproval(organizationId, promptVersionId, {
          approvedBy: authentication.subject,
          justification: input.justification,
          expiresAt: new Date(input.expiresAt),
        })
        .then(publicPromptVersion),
    );
  }

  @Post('model-responses')
  @HttpCode(200)
  @ApiOperation({ summary: 'Generate a neutral response through a published model' })
  @ApiBody({ schema: schema(createModelResponseSchema) })
  @ApiOkResponse({ schema: schema(modelResponseSchema) })
  async createModelResponse(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request, 'models.execute');
    const input: CreateModelResponseInput = parse(createModelResponseSchema, value);
    return this.execute(() =>
      this.runtime.execution.chat({
        organizationId,
        model: input.model,
        dataClassification: input.dataClassification,
        messages: input.messages,
        ...(input.tools === undefined
          ? {}
          : {
              tools: input.tools.map((tool) => ({
                name: tool.name,
                inputSchema: tool.inputSchema,
                ...(tool.description === undefined ? {} : { description: tool.description }),
              })),
            }),
      }),
    );
  }

  private providerEntity(
    organizationId: string,
    input: CreateProviderInput,
    timestamp: Date,
  ): ProviderDefinition {
    return {
      id: uuidV7(timestamp.getTime()),
      tenantId: organizationId,
      organizationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      name: input.name,
      adapter: input.adapter,
      enabled: input.enabled,
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      ...(input.secretReference === undefined ? {} : { secretReference: input.secretReference }),
      configuration: input.configuration,
      dataClassificationAllowed: input.dataClassificationAllowed,
    };
  }

  private modelEntity(
    organizationId: string,
    input: CreateModelInput,
    timestamp: Date,
  ): ModelDefinition {
    return {
      id: uuidV7(timestamp.getTime()),
      tenantId: organizationId,
      organizationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...input,
      lifecycle: 'DRAFT',
    };
  }

  private promptEntity(organizationId: string, input: CreatePromptInput, timestamp: Date): Prompt {
    return {
      id: uuidV7(timestamp.getTime()),
      tenantId: organizationId,
      organizationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      name: input.name,
      slug: input.slug,
      ...(input.description === undefined ? {} : { description: input.description }),
    };
  }

  private promptVersionEntity(
    organizationId: string,
    promptId: string,
    input: CreatePromptVersionInput,
    timestamp: Date,
  ): PromptVersion {
    return {
      id: uuidV7(timestamp.getTime()),
      tenantId: organizationId,
      organizationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      promptId,
      versionLabel: input.versionLabel,
      content: input.content,
      contentDigest: createHash('sha256').update(input.content).digest('hex'),
      variables: input.variables.map((variable) => ({
        name: variable.name,
        required: variable.required,
        ...(variable.description === undefined ? {} : { description: variable.description }),
        ...(variable.defaultValue === undefined ? {} : { defaultValue: variable.defaultValue }),
      })),
      modelDefinitionId: input.modelDefinitionId,
      lifecycle: 'DRAFT',
    };
  }

  private datasetEntity(
    organizationId: string,
    input: CreateEvaluationDatasetInput,
    timestamp: Date,
  ): EvaluationDataset {
    return {
      id: uuidV7(timestamp.getTime()),
      tenantId: organizationId,
      organizationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      name: input.name,
      datasetVersion: input.datasetVersion,
      classification: input.classification,
      provenance: input.provenance,
      owner: input.owner,
      retentionDays: input.retentionDays,
      sourceKind: input.sourceKind,
      approvedForEvaluation: input.approvedForEvaluation,
      sanitized: input.sanitized,
      ...(input.legalBasis === undefined ? {} : { legalBasis: input.legalBasis }),
      cases: input.cases.map((evaluationCase) => ({
        id: evaluationCase.id,
        input: evaluationCase.input,
        ...(evaluationCase.expected === undefined ? {} : { expected: evaluationCase.expected }),
      })),
    };
  }

  private suiteEntity(
    organizationId: string,
    input: CreateEvaluationSuiteInput,
    timestamp: Date,
  ): EvaluationSuite {
    return {
      id: uuidV7(timestamp.getTime()),
      tenantId: organizationId,
      organizationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...input,
    };
  }

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const publicMessages = new Set([
        'Provider name already exists',
        'Enabled provider not found',
        'Model alias already exists',
        'New models must start as DRAFT',
        'Invalid organization scope',
        'Dataset is not approved for evaluation',
        'Dataset governance metadata is incomplete',
        'Dataset cases must be non-empty and unique',
        'Production evaluation data requires legal basis and sanitization',
        'Evaluation suite is incomplete',
        'Evaluation criteria must be unique and finite',
        'Evaluation dataset version not found',
        'Evaluation model not found',
        'Retired models cannot be evaluated',
        'Evaluation provider unavailable',
        'Evaluation data classification is invalid',
        'Evaluation data classification is not allowed by provider',
        'Evaluation case input must be an object',
        'Evaluation case input.messages must be a non-empty array',
        'Evaluation run not found',
        'Model not found',
        'Evaluation gate does not match its run result',
        'Evaluation provider decision does not match the gate',
        'Red-team campaign metadata is incomplete',
        'Red-team campaign is missing vectors: jailbreak, indirect_prompt_injection, data_exfiltration, cross_tenant_access, unsafe_tool_use, excessive_agency, denial_of_wallet, rag_poisoning',
        'Red-team scenario IDs must be unique',
        'Red-team campaign not found',
        'Red-team campaign is already running',
        'Passing evaluation gate is required',
        'Approved evaluation gate is required for publication',
        'Evaluation gate is stale or failed',
        'Evaluation gate is stale or failed (model approval missing or expired)',
        'Prompt slug already exists',
        'Prompt not found',
        'Prompt version not found',
        'Prompt model route not found',
        'Prompt model route does not match evaluation model',
        'New prompt versions must start as DRAFT',
        'Prompt content digest mismatch',
        'Prompt variables must be unique',
        'Prompt variables must exactly match content placeholders',
        'Prompt version label already exists',
        'Prompt evaluation run does not match version snapshot',
        'Prompt evaluation gate does not match its run result',
        'Prompt evaluation subject does not match the current version',
        'Evaluation provider decision does not match the prompt gate',
        'Prompt version changed after evaluation',
        'Passing prompt evaluation gate is required',
        'Approved prompt evaluation gate is required for publication',
        'Prompt evaluation gate is stale or failed',
        'Override approver and justification are required',
        'Override expiration must be in the future',
        'Published or retired models cannot receive an override',
        'Published or retired prompt versions cannot receive an override',
      ]);
      if (error instanceof Error && error.message.startsWith('Evaluation suite is missing')) {
        throw new ValidationError(error.message);
      }
      if (
        error instanceof ModelRuntimeError &&
        ['MODEL_NOT_FOUND', 'MODEL_NOT_PUBLISHED', 'CLASSIFICATION_DENIED'].includes(error.code)
      ) {
        throw new ValidationError(error.message);
      }
      if (error instanceof Error && publicMessages.has(error.message)) {
        throw new ValidationError(error.message);
      }
      throw error;
    }
  }

  private async authorize(
    organizationId: string,
    request: AuthenticatedRequest,
    permission = 'models.manage',
  ): Promise<void> {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId) {
      throw new AuthorizationError('Cross-organization model administration is forbidden');
    }
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission,
    });
    if (!decision.allowed) throw new AuthorizationError(`${permission} permission is required`);
  }
}
