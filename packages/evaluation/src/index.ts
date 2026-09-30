import { createHash } from 'node:crypto';
import type { DatabaseAdapter } from '@handstack/database';
import {
  repositoryName,
  uuidV7,
  type Repository,
  type TenantEntity,
  type TransactionContext,
} from '@handstack/domain';
import type {
  AiGovernanceTelemetry,
  DataClassification,
  EvaluationGateDecision,
  EvaluationGateInput,
  EvaluationProvider,
  EvaluationRunInput,
  EvaluationRunResult,
  ModelAuditEvent,
} from '@handstack/models';

export type CoreEvaluationMetric =
  | 'task_success'
  | 'schema_validity'
  | 'tool_selection_correctness'
  | 'tool_argument_correctness'
  | 'groundedness'
  | 'citation_validity'
  | 'recall'
  | 'precision'
  | 'freshness'
  | 'cross_tenant_isolation'
  | 'hallucination_rate'
  | 'safety_policy_compliance'
  | 'prompt_injection_resistance'
  | 'pii_secret_leakage'
  | 'latency_ms'
  | 'token_usage'
  | 'cost_usd'
  | 'human_rating';

export const minimumModelGateMetrics = [
  'task_success',
  'schema_validity',
  'tool_selection_correctness',
  'tool_argument_correctness',
  'safety_policy_compliance',
  'prompt_injection_resistance',
  'pii_secret_leakage',
  'latency_ms',
  'token_usage',
  'cost_usd',
] as const satisfies readonly CoreEvaluationMetric[];

export const minimumRagGateMetrics = [
  'recall',
  'precision',
  'groundedness',
  'citation_validity',
  'freshness',
  'cross_tenant_isolation',
] as const satisfies readonly CoreEvaluationMetric[];

export interface RagEvaluationEvidence {
  readonly expectedChunkIds: readonly string[];
  readonly retrievedChunkIds: readonly string[];
  readonly claimCount: number;
  readonly groundedClaimCount: number;
  readonly citationCount: number;
  readonly validCitationCount: number;
  readonly freshCitationCount: number;
  readonly crossTenantLeakCount: number;
}

export function scoreRagEvaluation(
  evidence: RagEvaluationEvidence,
): Readonly<Pick<Record<CoreEvaluationMetric, number>, (typeof minimumRagGateMetrics)[number]>> {
  const expected = new Set(evidence.expectedChunkIds);
  const retrieved = new Set(evidence.retrievedChunkIds);
  const relevant = [...retrieved].filter((id) => expected.has(id)).length;
  const finiteCounts = [
    evidence.claimCount,
    evidence.groundedClaimCount,
    evidence.citationCount,
    evidence.validCitationCount,
    evidence.freshCitationCount,
    evidence.crossTenantLeakCount,
  ];
  if (finiteCounts.some((value) => !Number.isInteger(value) || value < 0))
    throw new Error('RAG evaluation counts must be non-negative integers');
  if (
    evidence.groundedClaimCount > evidence.claimCount ||
    evidence.validCitationCount > evidence.citationCount ||
    evidence.freshCitationCount > evidence.citationCount
  )
    throw new Error('RAG evaluation evidence counts are inconsistent');
  return {
    recall: expected.size === 0 ? 1 : relevant / expected.size,
    precision: retrieved.size === 0 ? (expected.size === 0 ? 1 : 0) : relevant / retrieved.size,
    groundedness: evidence.claimCount === 0 ? 1 : evidence.groundedClaimCount / evidence.claimCount,
    citation_validity:
      evidence.citationCount === 0
        ? evidence.claimCount === 0
          ? 1
          : 0
        : evidence.validCitationCount / evidence.citationCount,
    freshness:
      evidence.citationCount === 0 ? 1 : evidence.freshCitationCount / evidence.citationCount,
    cross_tenant_isolation: evidence.crossTenantLeakCount === 0 ? 1 : 0,
  };
}

export function validateRagEvaluationCriteria(
  criteria: readonly EvaluationMetricCriterion[],
): void {
  const metrics = new Set(criteria.map(({ metric }) => metric));
  const missing = minimumRagGateMetrics.filter((metric) => !metrics.has(metric));
  if (missing.length > 0)
    throw new Error(`RAG evaluation suite is missing metrics: ${missing.join(', ')}`);
}

export interface EvaluationCaseDefinition {
  readonly id: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly expected?: Readonly<Record<string, unknown>>;
}

export interface EvaluationDataset extends TenantEntity {
  readonly organizationId: string;
  readonly name: string;
  readonly datasetVersion: string;
  readonly classification: DataClassification;
  readonly provenance: string;
  readonly owner: string;
  readonly retentionDays: number;
  readonly sourceKind: 'SYNTHETIC' | 'APPROVED' | 'PRODUCTION';
  readonly approvedForEvaluation: boolean;
  readonly sanitized: boolean;
  readonly legalBasis?: string;
  readonly cases: readonly EvaluationCaseDefinition[];
}

export interface EvaluationMetricCriterion {
  readonly metric: CoreEvaluationMetric;
  readonly direction: 'min' | 'max';
  readonly threshold: number;
}

export interface EvaluationSuite extends TenantEntity {
  readonly organizationId: string;
  readonly name: string;
  readonly suiteVersion: string;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly criteria: readonly EvaluationMetricCriterion[];
}

export interface EvaluationCaseResult {
  readonly caseId: string;
  readonly scores: Readonly<Record<string, number>>;
  readonly evidenceDigest: string;
}

export interface EvaluationResult extends TenantEntity {
  readonly organizationId: string;
  readonly runId: string;
  readonly caseId: string;
  readonly scores: Readonly<Record<string, number>>;
  readonly evidenceDigest: string;
}

export interface EvaluationRunRecord extends TenantEntity {
  readonly organizationId: string;
  readonly modelDefinitionId: string;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly passed: boolean;
  readonly scores: Readonly<Record<string, number>>;
  readonly caseResults: readonly EvaluationCaseResult[];
  readonly promptVersionId?: string;
  readonly promptContentDigest?: string;
}

export interface EvaluationCaseRunnerInput {
  readonly organizationId: string;
  readonly modelDefinitionId: string;
  readonly suite: EvaluationSuite;
  readonly dataset: EvaluationDataset;
  readonly evaluationCase: EvaluationCaseDefinition;
  readonly promptVersionId?: string;
  readonly promptContentDigest?: string;
}

export interface EvaluationCaseRunnerResult {
  readonly scores: Readonly<Record<string, number>>;
  readonly evidence: unknown;
}

export interface EvaluationCaseRunner {
  runCase(input: EvaluationCaseRunnerInput): Promise<EvaluationCaseRunnerResult>;
}

/** Required attack surfaces for a release red-team campaign. */
export const minimumRedTeamVectors = [
  'jailbreak',
  'indirect_prompt_injection',
  'data_exfiltration',
  'cross_tenant_access',
  'unsafe_tool_use',
  'excessive_agency',
  'denial_of_wallet',
  'rag_poisoning',
] as const;

export type RedTeamVector = (typeof minimumRedTeamVectors)[number];

export interface RedTeamScenario {
  readonly id: string;
  readonly vector: RedTeamVector;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface RedTeamFinding {
  readonly scenarioId: string;
  readonly vector: RedTeamVector;
  readonly passed: boolean;
  readonly severity: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly evidenceDigest: string;
}

export interface RedTeamCampaign extends TenantEntity {
  readonly organizationId: string;
  readonly targetKind: 'MODEL' | 'PROMPT' | 'AGENT' | 'WORKFLOW';
  readonly targetId: string;
  readonly campaignVersion: string;
  readonly scenarios: readonly RedTeamScenario[];
  readonly status: 'DRAFT' | 'RUNNING' | 'PASSED' | 'FAILED';
  readonly findings: readonly RedTeamFinding[];
  readonly executedAt?: Date;
  readonly executionErrorDigest?: string;
}

export interface RedTeamScenarioRunner {
  runScenario(input: {
    readonly organizationId: string;
    readonly campaign: RedTeamCampaign;
    readonly scenario: RedTeamScenario;
  }): Promise<{
    readonly passed: boolean;
    readonly severity: RedTeamFinding['severity'];
    readonly evidence: unknown;
  }>;
}

export const redTeamSchema = {
  version: 1,
  repository: repositoryName('red-team-campaigns'),
} as const;

function validateRedTeamCampaign(campaign: RedTeamCampaign): void {
  if (campaign.organizationId === '' || campaign.targetId === '' || campaign.campaignVersion === '')
    throw new Error('Red-team campaign metadata is incomplete');
  const vectors = new Set(campaign.scenarios.map(({ vector }) => vector));
  const missing = minimumRedTeamVectors.filter((vector) => !vectors.has(vector));
  if (missing.length > 0)
    throw new Error(`Red-team campaign is missing vectors: ${missing.join(', ')}`);
  if (new Set(campaign.scenarios.map(({ id }) => id)).size !== campaign.scenarios.length)
    throw new Error('Red-team scenario IDs must be unique');
  if (campaign.status !== 'DRAFT' || campaign.findings.length !== 0)
    throw new Error('New red-team campaigns must start as DRAFT');
}

const suiteRepository = repositoryName('evaluation-suites');
const datasetRepository = repositoryName('evaluation-datasets');
const runRepository = repositoryName('evaluation-runs');
const resultRepository = repositoryName('evaluation-results');
const auditRepository = repositoryName('model-audit-events');

export const evaluationSchema = {
  version: 2,
  repositories: {
    suites: suiteRepository,
    datasets: datasetRepository,
    runs: runRepository,
    results: resultRepository,
    auditEvents: auditRepository,
  },
} as const;

const directTelemetry: AiGovernanceTelemetry = {
  measure: (_operation, work) => work(),
  measureStream: (_operation, work) => work(),
};

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertScope(organizationId: string, entity: { tenantId: string; organizationId: string }) {
  if (
    organizationId === '' ||
    entity.tenantId !== organizationId ||
    entity.organizationId !== organizationId
  )
    throw new Error('Invalid evaluation organization scope');
}

function validateDataset(dataset: EvaluationDataset): void {
  if (!dataset.approvedForEvaluation) throw new Error('Dataset is not approved for evaluation');
  if (
    dataset.datasetVersion === '' ||
    dataset.owner === '' ||
    dataset.provenance === '' ||
    dataset.retentionDays < 1
  )
    throw new Error('Dataset governance metadata is incomplete');
  if (
    dataset.cases.length === 0 ||
    new Set(dataset.cases.map(({ id }) => id)).size !== dataset.cases.length
  )
    throw new Error('Dataset cases must be non-empty and unique');
  if (
    dataset.sourceKind === 'PRODUCTION' &&
    (!dataset.sanitized || dataset.legalBasis === undefined || dataset.legalBasis === '')
  )
    throw new Error('Production evaluation data requires legal basis and sanitization');
}

function validateSuite(suite: EvaluationSuite): void {
  if (suite.suiteVersion === '' || suite.datasetVersion === '' || suite.criteria.length === 0)
    throw new Error('Evaluation suite is incomplete');
  const metrics = new Set<CoreEvaluationMetric>();
  for (const criterion of suite.criteria) {
    if (metrics.has(criterion.metric) || !Number.isFinite(criterion.threshold))
      throw new Error('Evaluation criteria must be unique and finite');
    metrics.add(criterion.metric);
  }
  const missing = minimumModelGateMetrics.filter((metric) => !metrics.has(metric));
  if (missing.length > 0)
    throw new Error(`Evaluation suite is missing product minimum metrics: ${missing.join(', ')}`);
}

export class CoreEvaluationProvider implements EvaluationProvider {
  private readonly suites: Repository<EvaluationSuite>;
  private readonly datasets: Repository<EvaluationDataset>;
  private readonly runs: Repository<EvaluationRunRecord>;

  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly runner: EvaluationCaseRunner,
    private readonly now: () => Date = () => new Date(),
    private readonly telemetry: AiGovernanceTelemetry = directTelemetry,
  ) {
    this.suites = adapter.repository(suiteRepository);
    this.datasets = adapter.repository(datasetRepository);
    this.runs = adapter.repository(runRepository);
  }

  async registerDataset(dataset: EvaluationDataset): Promise<EvaluationDataset> {
    return this.telemetry.measure('evaluation.dataset.register', () =>
      this.adapter.run(async (context) => {
        assertScope(dataset.organizationId, dataset);
        validateDataset(dataset);
        const saved = await context
          .repository<EvaluationDataset>(datasetRepository)
          .insert(dataset);
        await this.appendAudit(
          context,
          dataset.organizationId,
          'EVALUATION_DATASET_REGISTERED',
          'evaluation_dataset',
          dataset.id,
          {
            datasetVersion: dataset.datasetVersion,
            classification: dataset.classification,
            sourceKind: dataset.sourceKind,
            retentionDays: dataset.retentionDays,
            sanitized: dataset.sanitized,
          },
          dataset.createdAt,
        );
        return saved;
      }),
    );
  }

  async registerSuite(suite: EvaluationSuite): Promise<EvaluationSuite> {
    return this.telemetry.measure('evaluation.suite.register', () =>
      this.adapter.run(async (context) => {
        assertScope(suite.organizationId, suite);
        validateSuite(suite);
        const dataset = await context
          .repository<EvaluationDataset>(datasetRepository)
          .findById(suite.organizationId, suite.datasetId);
        if (dataset?.datasetVersion !== suite.datasetVersion)
          throw new Error('Evaluation dataset version not found');
        const saved = await context.repository<EvaluationSuite>(suiteRepository).insert(suite);
        await this.appendAudit(
          context,
          suite.organizationId,
          'EVALUATION_SUITE_REGISTERED',
          'evaluation_suite',
          suite.id,
          {
            suiteVersion: suite.suiteVersion,
            datasetId: suite.datasetId,
            datasetVersion: suite.datasetVersion,
            criteriaCount: suite.criteria.length,
          },
          suite.createdAt,
        );
        return saved;
      }),
    );
  }

  listDatasets(organizationId: string, limit = 100) {
    return this.datasets.list(organizationId, { limit });
  }

  listSuites(organizationId: string, limit = 100) {
    return this.suites.list(organizationId, { limit });
  }

  listRuns(organizationId: string, limit = 100) {
    return this.runs.list(organizationId, { limit });
  }

  getRun(organizationId: string, runId: string): Promise<EvaluationRunRecord | undefined> {
    return this.runs.findById(organizationId, runId);
  }

  listResults(organizationId: string, runId: string, limit = 200) {
    return this.adapter
      .repository<EvaluationResult>(resultRepository)
      .list(organizationId, { limit })
      .then((page) => ({
        ...page,
        items: page.items
          .filter((result) => result.runId === runId)
          .sort((left, right) => left.caseId.localeCompare(right.caseId)),
      }));
  }

  async run(input: EvaluationRunInput): Promise<EvaluationRunResult> {
    return this.telemetry.measure('evaluation.run', () => this.executeRun(input));
  }

  private async executeRun(input: EvaluationRunInput): Promise<EvaluationRunResult> {
    if ((input.promptVersionId === undefined) !== (input.promptContentDigest === undefined))
      throw new Error('Prompt evaluation subject is incomplete');
    const suite = await this.suites.findById(input.organizationId, input.suiteId);
    if (suite?.suiteVersion !== input.suiteVersion)
      throw new Error('Evaluation suite version not found');
    const dataset = await this.datasets.findById(input.organizationId, suite.datasetId);
    if (dataset?.datasetVersion !== suite.datasetVersion)
      throw new Error('Evaluation dataset version not found');
    validateDataset(dataset);
    const caseResults: EvaluationCaseResult[] = [];
    for (const evaluationCase of [...dataset.cases].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      const result = await this.runner.runCase({
        ...input,
        suite,
        dataset,
        evaluationCase,
      });
      for (const criterion of suite.criteria) {
        const score = result.scores[criterion.metric];
        if (score === undefined || !Number.isFinite(score))
          throw new Error(`Evaluation metric missing or invalid: ${criterion.metric}`);
      }
      caseResults.push({
        caseId: evaluationCase.id,
        scores: result.scores,
        evidenceDigest: digest(result.evidence),
      });
    }
    const scores = Object.fromEntries(
      suite.criteria.map(({ metric }) => [
        metric,
        caseResults.reduce((total, result) => total + (result.scores[metric] ?? 0), 0) /
          caseResults.length,
      ]),
    );
    const passed = suite.criteria.every(({ metric, direction, threshold }) =>
      direction === 'min'
        ? (scores[metric] ?? Number.NEGATIVE_INFINITY) >= threshold
        : (scores[metric] ?? Number.POSITIVE_INFINITY) <= threshold,
    );
    const runId = digest({
      input,
      datasetVersion: dataset.datasetVersion,
      caseResults,
      scores,
      passed,
    });
    await this.adapter.run(async (context) => {
      const runs = context.repository<EvaluationRunRecord>(runRepository);
      const existing = await runs.findById(input.organizationId, runId);
      if (existing !== undefined) return;
      const timestamp = this.now();
      await runs.insert({
        id: runId,
        tenantId: input.organizationId,
        organizationId: input.organizationId,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        modelDefinitionId: input.modelDefinitionId,
        suiteId: input.suiteId,
        suiteVersion: input.suiteVersion,
        datasetId: dataset.id,
        datasetVersion: dataset.datasetVersion,
        passed,
        scores,
        caseResults,
        ...(input.promptVersionId === undefined
          ? {}
          : {
              promptVersionId: input.promptVersionId,
              promptContentDigest: input.promptContentDigest,
            }),
      });
      const results = context.repository<EvaluationResult>(resultRepository);
      for (const caseResult of caseResults) {
        await results.insert({
          id: digest({ runId, caseId: caseResult.caseId }),
          tenantId: input.organizationId,
          organizationId: input.organizationId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          runId,
          caseId: caseResult.caseId,
          scores: caseResult.scores,
          evidenceDigest: caseResult.evidenceDigest,
        });
      }
      await this.appendAudit(
        context,
        input.organizationId,
        'EVALUATION_RUN_COMPLETED',
        'evaluation_run',
        runId,
        {
          modelDefinitionId: input.modelDefinitionId,
          suiteId: input.suiteId,
          suiteVersion: input.suiteVersion,
          datasetVersion: dataset.datasetVersion,
          passed,
          caseCount: caseResults.length,
        },
        timestamp,
      );
    });
    return { runId, datasetVersion: dataset.datasetVersion, passed, scores };
  }

  async validateGate(input: EvaluationGateInput): Promise<EvaluationGateDecision> {
    return this.telemetry.measure('evaluation.gate.validate', () =>
      this.validatePersistedGate(input),
    );
  }

  private async validatePersistedGate(input: EvaluationGateInput): Promise<EvaluationGateDecision> {
    const run = await this.runs.findById(input.organizationId, input.result.runId);
    const suite = await this.suites.findById(input.organizationId, input.suiteId);
    const dataset =
      suite === undefined
        ? undefined
        : await this.datasets.findById(input.organizationId, suite.datasetId);
    const valid =
      run?.modelDefinitionId === input.modelDefinitionId &&
      run.promptVersionId === input.promptVersionId &&
      run.promptContentDigest === input.promptContentDigest &&
      run.suiteId === input.suiteId &&
      run.suiteVersion === input.suiteVersion &&
      suite?.suiteVersion === input.suiteVersion &&
      dataset?.datasetVersion === run.datasetVersion &&
      suite.datasetVersion === run.datasetVersion &&
      run.datasetVersion === input.result.datasetVersion &&
      run.passed === input.result.passed &&
      digest(run.scores) === digest(input.result.scores);
    if (!valid) return { passed: false, reasons: ['PERSISTED_RUN_MISMATCH'] };
    if (!run.passed) return { passed: false, reasons: ['EVALUATION_CRITERIA_FAILED'] };
    return { passed: true, reasons: [] };
  }

  listAuditEvents(organizationId: string, limit = 100) {
    return this.adapter
      .repository<ModelAuditEvent>(auditRepository)
      .list(organizationId, { limit });
  }

  private async appendAudit(
    context: TransactionContext,
    organizationId: string,
    eventType: ModelAuditEvent['eventType'],
    resourceType: ModelAuditEvent['resourceType'],
    resourceId: string,
    metadata: ModelAuditEvent['metadata'],
    timestamp: Date,
  ): Promise<void> {
    await context.repository<ModelAuditEvent>(auditRepository).insert({
      id: uuidV7(timestamp.getTime()),
      tenantId: organizationId,
      organizationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      eventType,
      resourceType,
      resourceId,
      outcome: 'SUCCESS',
      metadata,
    });
  }
}

export class RedTeamCampaignService {
  private readonly campaigns: Repository<RedTeamCampaign>;

  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly runner: RedTeamScenarioRunner,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.campaigns = adapter.repository(redTeamSchema.repository);
  }

  async register(campaign: RedTeamCampaign): Promise<RedTeamCampaign> {
    assertScope(campaign.organizationId, campaign);
    validateRedTeamCampaign(campaign);
    return this.adapter.run(async (context) => {
      const saved = await context
        .repository<RedTeamCampaign>(redTeamSchema.repository)
        .insert(campaign);
      await context.repository<ModelAuditEvent>(auditRepository).insert({
        id: uuidV7(campaign.createdAt.getTime()),
        tenantId: campaign.organizationId,
        organizationId: campaign.organizationId,
        version: 1,
        createdAt: campaign.createdAt,
        updatedAt: campaign.createdAt,
        eventType: 'RED_TEAM_CAMPAIGN_REGISTERED',
        resourceType: 'red_team_campaign',
        resourceId: campaign.id,
        outcome: 'SUCCESS',
        metadata: {
          targetKind: campaign.targetKind,
          targetId: campaign.targetId,
          campaignVersion: campaign.campaignVersion,
        },
      });
      return saved;
    });
  }

  list(organizationId: string, limit = 100) {
    return this.campaigns.list(organizationId, { limit });
  }

  get(organizationId: string, campaignId: string) {
    return this.campaigns.findById(organizationId, campaignId);
  }

  /** Fails publication when a configured model campaign is not passing. */
  async assertPublicationAllowed(
    organizationId: string,
    targetKind: 'MODEL' | 'PROMPT',
    targetId: string,
  ): Promise<void> {
    const campaigns = (await this.list(organizationId, 100)).items.filter(
      (campaign) => campaign.targetKind === targetKind && campaign.targetId === targetId,
    );
    if (campaigns.some((campaign) => campaign.status !== 'PASSED'))
      throw new Error('Passing red-team campaign is required for model publication');
  }

  async execute(organizationId: string, campaignId: string): Promise<RedTeamCampaign> {
    const current = await this.campaigns.findById(organizationId, campaignId);
    if (current === undefined) throw new Error('Red-team campaign not found');
    assertScope(organizationId, current);
    if (current.status === 'RUNNING') throw new Error('Red-team campaign is already running');
    const startedAt = this.now();
    const running: RedTeamCampaign = {
      ...current,
      version: current.version + 1,
      updatedAt: startedAt,
      status: 'RUNNING',
    };
    await this.campaigns.update(running, current.version);
    const findings: RedTeamFinding[] = [];
    let executionErrorDigest: string | undefined;
    try {
      for (const scenario of current.scenarios) {
        const result = await this.runner.runScenario({
          organizationId,
          campaign: current,
          scenario,
        });
        findings.push({
          scenarioId: scenario.id,
          vector: scenario.vector,
          passed: result.passed,
          severity: result.severity,
          evidenceDigest: digest(result.evidence),
        });
      }
    } catch (error) {
      executionErrorDigest = digest(
        error instanceof Error ? error.message : 'red-team executor failed',
      );
    }
    const completedAt = this.now();
    const completed: RedTeamCampaign = {
      ...running,
      version: running.version + 1,
      updatedAt: completedAt,
      status:
        executionErrorDigest === undefined &&
        findings.every(({ passed, severity }) => passed && severity === 'NONE')
          ? 'PASSED'
          : 'FAILED',
      findings,
      executedAt: completedAt,
      ...(executionErrorDigest === undefined ? {} : { executionErrorDigest }),
    };
    return this.adapter.run(async (context) => {
      const updated = await context
        .repository<RedTeamCampaign>(redTeamSchema.repository)
        .update(completed, running.version);
      await context.repository<ModelAuditEvent>(auditRepository).insert({
        id: uuidV7(completedAt.getTime()),
        tenantId: organizationId,
        organizationId,
        version: 1,
        createdAt: completedAt,
        updatedAt: completedAt,
        eventType: 'RED_TEAM_CAMPAIGN_COMPLETED',
        resourceType: 'red_team_campaign',
        resourceId: completed.id,
        outcome: completed.status === 'PASSED' ? 'SUCCESS' : 'FAILURE',
        metadata: { status: completed.status, findingCount: findings.length },
      });
      return updated;
    });
  }
}
