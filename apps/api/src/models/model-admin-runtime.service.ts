import { createHash } from 'node:crypto';
import { CoreEvaluationProvider, RedTeamCampaignService } from '@handstack/evaluation';
import { createOfficialProviderFactories } from '@handstack/model-provider-bootstrap';
import { ModelRegistry } from '@handstack/model-registry';
import { ModelEvaluationCaseRunner, ModelExecutionRuntime } from '@handstack/model-runtime';
import { AiGovernanceOpenTelemetry } from '@handstack/telemetry';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { SecretRuntimeService } from '../secrets/secret-runtime.service.js';
import type { RedTeamCampaign, RedTeamScenario } from '@handstack/evaluation';

type AdditionalRedTeamTarget = 'AGENT' | 'WORKFLOW';
type AdditionalRedTeamExecutor = (input: {
  readonly organizationId: string;
  readonly campaign: RedTeamCampaign;
  readonly scenario: RedTeamScenario;
  readonly prompt: string;
}) => Promise<{ readonly output: string; readonly evidence: Readonly<Record<string, unknown>> }>;

@Injectable()
export class ModelAdminRuntimeService {
  readonly evaluation: CoreEvaluationProvider;
  readonly execution: ModelExecutionRuntime;
  readonly registry: ModelRegistry;
  readonly redTeam: RedTeamCampaignService;
  private readonly additionalRedTeamExecutors = new Map<
    AdditionalRedTeamTarget,
    AdditionalRedTeamExecutor
  >();

  constructor(
    @Inject(DatabaseService) database: DatabaseService,
    @Inject(SecretRuntimeService) secretsRuntime: SecretRuntimeService,
  ) {
    const telemetry = new AiGovernanceOpenTelemetry();
    const secrets = {
      resolve: async (organizationId: string, reference: string) => {
        if (organizationId === '') return Promise.reject(new Error('Invalid organization scope'));
        if (!reference.startsWith('secret://') && !reference.startsWith('env://'))
          return Promise.reject(new Error('Unsupported model secret reference'));
        const value = await secretsRuntime.resolve(reference, organizationId, 'model-provider');
        if (value === undefined || value === '') throw new Error('Model secret is unavailable');
        return value;
      },
    };
    const factories = createOfficialProviderFactories({
      timeoutMs: () => database.config.timeouts.provider,
    });
    const baseRegistry = new ModelRegistry(database.adapter, undefined, telemetry);
    const redTeam = new RedTeamCampaignService(database.adapter, {
      runScenario: async ({ organizationId, campaign, scenario }) => {
        const prompt = scenario.input.prompt;
        const expected = scenario.input.expected;
        if (typeof prompt !== 'string' || typeof expected !== 'object' || expected === null)
          throw new Error('Red-team scenario requires prompt and output assertions');
        const assertions = expected as Record<string, unknown>;
        const mustContain = stringAssertions(assertions.mustContain);
        const mustNotContain = stringAssertions(assertions.mustNotContain);
        if (mustContain.length === 0 && mustNotContain.length === 0)
          throw new Error('Red-team scenario requires at least one output assertion');

        let output: string;
        let executorEvidence: Readonly<Record<string, unknown>>;
        if (campaign.targetKind === 'AGENT' || campaign.targetKind === 'WORKFLOW') {
          const executor = this.additionalRedTeamExecutors.get(campaign.targetKind);
          if (executor === undefined)
            throw new Error(`Red-team executor is unavailable for ${campaign.targetKind} targets`);
          ({ output, evidence: executorEvidence } = await executor({
            organizationId,
            campaign,
            scenario,
            prompt,
          }));
        } else {
          let modelId = campaign.targetId;
          let systemPrompt: string | undefined;
          if (campaign.targetKind === 'PROMPT') {
            const promptVersion = await baseRegistry.getPromptVersion(
              organizationId,
              campaign.targetId,
            );
            if (promptVersion === undefined)
              throw new Error('Red-team prompt version was not found');
            modelId = promptVersion.modelDefinitionId;
            systemPrompt = promptVersion.content;
          }
          const model = await baseRegistry.getModel(organizationId, modelId);
          if (model === undefined || model.lifecycle === 'RETIRED')
            throw new Error('Red-team model is unavailable');
          const providerDefinition = await baseRegistry.getProvider(
            organizationId,
            model.providerId,
          );
          if (providerDefinition?.enabled !== true)
            throw new Error('Red-team provider is unavailable');
          if (!providerDefinition.dataClassificationAllowed.includes('INTERNAL'))
            throw new Error('Red-team provider does not allow INTERNAL data');
          const provider = factories.create(providerDefinition.adapter, {
            organizationId,
            definition: providerDefinition,
            modelDefinition: model,
            resolveSecret: () =>
              providerDefinition.secretReference === undefined
                ? Promise.resolve(undefined)
                : secrets.resolve(organizationId, providerDefinition.secretReference),
          });
          const health = await provider.health();
          if (health.status === 'unavailable')
            throw new Error('Red-team provider health check failed');
          const response = await provider.chat({
            model: model.providerModel,
            messages: [
              ...(systemPrompt === undefined
                ? []
                : [{ role: 'system' as const, content: systemPrompt }]),
              { role: 'user', content: prompt },
            ],
          });
          output = response.content;
          executorEvidence = {
            modelDefinitionId: model.id,
            providerId: providerDefinition.id,
            finishReason: response.finishReason,
            usage: response.usage,
          };
        }
        const normalizedResponse = output.toLocaleLowerCase();
        const contained = mustContain.map((value) =>
          normalizedResponse.includes(value.toLocaleLowerCase()),
        );
        const excluded = mustNotContain.map(
          (value) => !normalizedResponse.includes(value.toLocaleLowerCase()),
        );
        const passed = contained.every(Boolean) && excluded.every(Boolean);
        return {
          passed,
          severity: passed ? 'NONE' : 'HIGH',
          evidence: {
            ...executorEvidence,
            responseDigest: createHash('sha256').update(output).digest('hex'),
            containsChecksPassed: contained.every(Boolean),
            exclusionChecksPassed: excluded.every(Boolean),
          },
        };
      },
    });
    const runner = new ModelEvaluationCaseRunner(baseRegistry, factories, secrets);
    this.evaluation = new CoreEvaluationProvider(database.adapter, runner, undefined, telemetry);
    this.registry = new ModelRegistry(
      database.adapter,
      this.evaluation,
      telemetry,
      undefined,
      (organizationId, targetKind, targetId) =>
        redTeam.assertPublicationAllowed(organizationId, targetKind, targetId),
    );
    this.execution = new ModelExecutionRuntime(
      this.registry,
      factories,
      secrets,
      undefined,
      telemetry,
    );
    this.redTeam = redTeam;
  }

  registerRedTeamExecutor(
    target: AdditionalRedTeamTarget,
    executor: AdditionalRedTeamExecutor,
  ): void {
    if (this.additionalRedTeamExecutors.has(target))
      throw new Error(`Red-team executor already registered for ${target}`);
    this.additionalRedTeamExecutors.set(target, executor);
  }
}

function stringAssertions(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === ''))
    throw new Error('Red-team output assertions must be non-empty strings');
  return value as string[];
}
