import { createHash } from 'node:crypto';
import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter, type DatabaseAdapter } from '@handstack/database';
import type {
  Repository,
  RepositoryName,
  TenantEntity,
  TransactionContext,
  TransactionOptions,
} from '@handstack/domain';
import type {
  EvaluationGate,
  EvaluationProvider,
  EvaluationRunResult,
  ModelDefinition,
  Prompt,
  PromptEvaluationGate,
  PromptVersion,
  ProviderDefinition,
} from '@handstack/models';
import { describe, expect, it, vi } from 'vitest';
import { ModelRegistry } from '../src/index.js';

const organizationId = 'models-organization';
const now = new Date('2026-09-01T12:00:00.000Z');
const base = (id: string) => ({
  id,
  tenantId: organizationId,
  organizationId,
  version: 1,
  createdAt: now,
  updatedAt: now,
});
const provider = (): ProviderDefinition => ({
  ...base('provider'),
  name: 'Primary',
  adapter: 'openai',
  enabled: true,
  secretReference: 'env://MODEL_SECRET',
  dataClassificationAllowed: ['PUBLIC', 'INTERNAL'],
});
const model = (): ModelDefinition => ({
  ...base('coding'),
  displayName: 'Coding',
  providerId: 'provider',
  providerModel: 'vendor-model',
  aliases: ['coding', 'smart'],
  capabilities: ['chat', 'tools'],
  contextWindow: 128000,
  pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' },
  lifecycle: 'DRAFT',
});
const prompt = (): Prompt => ({
  ...base('support-prompt'),
  name: 'Support answer',
  slug: 'support-answer',
  description: 'Answer a support request',
});
const promptVersion = (
  id = 'support-prompt-v1',
  content = 'Answer {{question}}',
): PromptVersion => ({
  ...base(id),
  promptId: 'support-prompt',
  versionLabel: id.endsWith('v1') ? '1.0.0' : '2.0.0',
  content,
  contentDigest: createHash('sha256').update(content).digest('hex'),
  variables: [{ name: 'question', required: true }],
  modelDefinitionId: 'coding',
  lifecycle: 'DRAFT',
});
const evaluationProvider: EvaluationProvider = {
  run: () => Promise.reject(new Error('not used by registry contract test')),
  validateGate: ({ result }) =>
    Promise.resolve({
      passed: result.runId === 'persisted-passing-run' && result.passed,
      reasons: result.passed ? [] : ['EVALUATION_CRITERIA_FAILED'],
    }),
};
const result = (runId: string, passed: boolean, scores: Readonly<Record<string, number>>) =>
  ({ runId, datasetVersion: 'dataset-v1', passed, scores }) satisfies EvaluationRunResult;

class FailingAuditAdapter implements DatabaseAdapter {
  constructor(private readonly delegate: DatabaseAdapter) {}

  initialize(): Promise<this> {
    return Promise.resolve(this);
  }

  repository<T extends TenantEntity>(name: RepositoryName): Repository<T> {
    return this.delegate.repository<T>(name);
  }

  close(): Promise<void> {
    return this.delegate.close();
  }

  run<T>(
    operation: (context: TransactionContext) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    return this.delegate.run(
      (context) =>
        operation({
          repository: <E extends TenantEntity>(name: RepositoryName): Repository<E> => {
            const repository = context.repository<E>(name);
            if (name !== 'model-audit-events') return repository;
            return {
              findById: (tenantId, id) => repository.findById(tenantId, id),
              list: (tenantId, page) => repository.list(tenantId, page),
              insert: () => Promise.reject(new Error('audit unavailable')),
              update: (entity, expectedVersion) => repository.update(entity, expectedVersion),
              delete: (tenantId, id, expectedVersion) =>
                repository.delete(tenantId, id, expectedVersion),
            };
          },
        }),
      options,
    );
  }
}

describe('model registry', () => {
  it('requires the configured red-team publication gate', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      let redTeamPassed = false;
      const gate = vi.fn(() => {
        if (!redTeamPassed)
          return Promise.reject(
            new Error('Passing red-team campaign is required for model publication'),
          );
        return Promise.resolve();
      });
      const registry = new ModelRegistry(adapter, evaluationProvider, undefined, () => now, gate);
      await registry.registerProvider(provider());
      await registry.registerModel(model());
      const passed: EvaluationGate = {
        ...base('gate-for-red-team'),
        modelDefinitionId: 'coding',
        suiteId: 'model-quality',
        suiteVersion: '1',
        datasetVersion: 'dataset-v1',
        runId: 'persisted-passing-run',
        passed: true,
        evaluatedAt: now,
        scores: { taskSuccess: 1 },
      };
      await registry.recordGate(passed, result(passed.runId, true, passed.scores));
      await registry.approve(organizationId, 'coding');
      await expect(registry.publish(organizationId, 'coding')).rejects.toThrow(/red-team/);
      redTeamPassed = true;
      await expect(registry.publish(organizationId, 'coding')).resolves.toMatchObject({
        lifecycle: 'PUBLISHED',
      });
      expect(gate).toHaveBeenCalledTimes(2);
    } finally {
      await adapter.close();
    }
  });

  it('is tenant-aware and fails closed until a versioned gate passes', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const registry = new ModelRegistry(adapter, evaluationProvider, undefined, () => now);
      await registry.registerProvider(provider());
      await registry.registerModel(model());
      await expect(registry.publish(organizationId, 'coding')).rejects.toThrow(/evaluation gate/);
      const failed: EvaluationGate = {
        ...base('failed-gate'),
        modelDefinitionId: 'coding',
        suiteId: 'model-quality',
        suiteVersion: '1',
        datasetVersion: 'dataset-v1',
        runId: 'persisted-failed-run',
        passed: false,
        evaluatedAt: now,
        scores: { taskSuccess: 0.4 },
      };
      await registry.recordGate(failed, result(failed.runId, false, failed.scores));
      await expect(registry.approve(organizationId, 'coding')).rejects.toThrow(/evaluation gate/);
      const passed: EvaluationGate = {
        ...base('passed-gate'),
        modelDefinitionId: 'coding',
        suiteId: 'model-quality',
        suiteVersion: '2',
        datasetVersion: 'dataset-v1',
        runId: 'persisted-passing-run',
        passed: true,
        evaluatedAt: new Date(now.getTime() + 1),
        scores: { taskSuccess: 0.95 },
      };
      await registry.recordGate(passed, result(passed.runId, true, passed.scores));
      await registry.approve(organizationId, 'coding');
      await expect(registry.publish(organizationId, 'coding')).resolves.toMatchObject({
        lifecycle: 'PUBLISHED',
        evaluationSuiteVersion: '2',
      });
      await expect(registry.resolve(organizationId, 'smart')).resolves.toMatchObject({
        id: 'coding',
      });
      await expect(registry.resolve('other-organization', 'smart')).resolves.toBeUndefined();
      const audit = await registry.listAuditEvents(organizationId);
      expect(audit.items.map(({ eventType }) => eventType)).toEqual([
        'PROVIDER_REGISTERED',
        'MODEL_REGISTERED',
        'MODEL_GATE_RECORDED',
        'MODEL_GATE_RECORDED',
        'MODEL_APPROVED',
        'MODEL_PUBLISHED',
      ]);
      expect(JSON.stringify(audit.items)).not.toContain('env://MODEL_SECRET');
      expect(JSON.stringify(audit.items)).not.toContain('vendor-model');
      await expect(registry.listAuditEvents('other-organization')).resolves.toMatchObject({
        items: [],
      });
    } finally {
      await adapter.close();
    }
  });

  it('rejects alias collisions and cross-tenant providers', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const registry = new ModelRegistry(adapter, evaluationProvider);
      await registry.registerProvider(provider());
      await registry.registerModel(model());
      await expect(
        registry.registerModel({ ...model(), id: 'other-model', aliases: ['smart'] }),
      ).rejects.toThrow(/alias/);
      await expect(
        registry.registerProvider({ ...provider(), id: 'bad', organizationId: 'other' }),
      ).rejects.toThrow(/scope/);
    } finally {
      await adapter.close();
    }
  });

  it('supports an expiring, auditable approval override without a passing gate', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    const clock = now;
    try {
      const registry = new ModelRegistry(adapter, evaluationProvider, undefined, () => clock);
      await registry.registerProvider(provider());
      await registry.registerModel(model());
      await registry.overrideApproval(organizationId, 'coding', {
        approvedBy: 'security-admin',
        justification: 'Emergency controlled release for incident response',
        expiresAt: new Date(now.getTime() + 60_000),
      });
      await expect(registry.publish(organizationId, 'coding')).resolves.toMatchObject({
        lifecycle: 'PUBLISHED',
      });
      const audits = await registry.listAuditEvents(organizationId);
      expect(audits.items.map(({ eventType }) => eventType)).toContain('MODEL_APPROVAL_OVERRIDDEN');
    } finally {
      await adapter.close();
    }
  });

  it('rejects fabricated results and requires a provider-backed persisted decision', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const registry = new ModelRegistry(adapter, evaluationProvider);
      await registry.registerProvider(provider());
      await registry.registerModel(model());
      const gate: EvaluationGate = {
        ...base('fabricated-gate'),
        modelDefinitionId: 'coding',
        suiteId: 'model-quality',
        suiteVersion: '2',
        datasetVersion: 'dataset-v1',
        runId: 'not-persisted',
        passed: true,
        evaluatedAt: now,
        scores: { taskSuccess: 1 },
      };
      await expect(
        registry.recordGate(gate, result(gate.runId, true, gate.scores)),
      ).rejects.toThrow(/decision does not match/);
      await expect(
        new ModelRegistry(adapter).recordGate(gate, result(gate.runId, true, gate.scores)),
      ).rejects.toThrow(/provider is required/);
    } finally {
      await adapter.close();
    }
  });

  it('rolls back an administrative mutation when mandatory audit persistence fails', async () => {
    const baseAdapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await baseAdapter.initialize();
    try {
      const registry = new ModelRegistry(new FailingAuditAdapter(baseAdapter), evaluationProvider);
      await expect(registry.registerProvider(provider())).rejects.toThrow('audit unavailable');
      await expect(registry.getProvider(organizationId, provider().id)).resolves.toBeUndefined();
    } finally {
      await baseAdapter.close();
    }
  });

  it('publishes only the exact immutable prompt version that passed its persisted gate', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      let redTeamPassed = false;
      const publicationGate = vi.fn(
        (_organizationId: string, targetKind: 'MODEL' | 'PROMPT', targetId: string) => {
          if (!redTeamPassed)
            return Promise.reject(
              new Error(`red-team campaign required for ${targetKind}:${targetId}`),
            );
          return Promise.resolve();
        },
      );
      const registry = new ModelRegistry(
        adapter,
        evaluationProvider,
        undefined,
        () => now,
        publicationGate,
      );
      await registry.registerProvider(provider());
      await registry.registerModel(model());
      await registry.registerPrompt(prompt());
      const first = await registry.registerPromptVersion(promptVersion());
      await expect(registry.publishPromptVersion(organizationId, first.id)).rejects.toThrow(
        /evaluation gate/,
      );
      const run = result('persisted-passing-run', true, { taskSuccess: 1 });
      const gate: PromptEvaluationGate = {
        ...base('prompt-gate-v1'),
        modelDefinitionId: first.modelDefinitionId,
        promptVersionId: first.id,
        promptContentDigest: first.contentDigest,
        suiteId: 'prompt-quality',
        suiteVersion: '1',
        datasetVersion: run.datasetVersion,
        runId: run.runId,
        passed: true,
        evaluatedAt: now,
        scores: run.scores,
      };
      await registry.recordPromptGate(gate, run);
      await registry.approvePromptVersion(organizationId, first.id);
      await expect(registry.publishPromptVersion(organizationId, first.id)).rejects.toThrow(
        /red-team campaign/,
      );
      expect(publicationGate).toHaveBeenLastCalledWith(organizationId, 'PROMPT', first.id);
      redTeamPassed = true;
      await expect(registry.publishPromptVersion(organizationId, first.id)).resolves.toMatchObject({
        lifecycle: 'PUBLISHED',
        versionLabel: '1.0.0',
      });

      const second = await registry.registerPromptVersion(
        promptVersion('support-prompt-v2', 'Safely answer {{question}}'),
      );
      expect(second).toMatchObject({ lifecycle: 'DRAFT', versionLabel: '2.0.0' });
      await expect(registry.publishPromptVersion(organizationId, second.id)).rejects.toThrow(
        /evaluation gate/,
      );
      await expect(
        registry.recordPromptGate({ ...gate, id: 'stale-gate', promptVersionId: second.id }, run),
      ).rejects.toThrow(/subject does not match/);
      await expect(registry.listPromptVersions(organizationId, prompt().id)).resolves.toHaveLength(
        2,
      );
      await expect(registry.listPromptVersions('other-organization', prompt().id)).resolves.toEqual(
        [],
      );
      const audit = await registry.listAuditEvents(organizationId);
      expect(audit.items.map(({ eventType }) => eventType)).toContain('PROMPT_PUBLISHED');
      expect(JSON.stringify(audit.items)).not.toContain('Answer {{question}}');
    } finally {
      await adapter.close();
    }
  });

  it('supports an expiring, auditable prompt approval override', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const registry = new ModelRegistry(adapter, evaluationProvider, undefined, () => now);
      await registry.registerProvider(provider());
      await registry.registerModel(model());
      await registry.registerPrompt(prompt());
      const version = await registry.registerPromptVersion(promptVersion());
      await registry.overridePromptApproval(organizationId, version.id, {
        approvedBy: 'security-admin',
        justification: 'Emergency controlled prompt release',
        expiresAt: new Date(now.getTime() + 60_000),
      });
      await expect(
        registry.publishPromptVersion(organizationId, version.id),
      ).resolves.toMatchObject({
        lifecycle: 'PUBLISHED',
      });
      const audits = await registry.listAuditEvents(organizationId);
      expect(audits.items.map(({ eventType }) => eventType)).toContain(
        'PROMPT_APPROVAL_OVERRIDDEN',
      );
    } finally {
      await adapter.close();
    }
  });

  it('rejects invalid prompt variables, duplicate versions, slugs and cross-tenant scope', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const registry = new ModelRegistry(adapter, evaluationProvider);
      await registry.registerProvider(provider());
      await registry.registerModel(model());
      await registry.registerPrompt(prompt());
      await expect(registry.registerPrompt({ ...prompt(), id: 'duplicate' })).rejects.toThrow(
        /slug/,
      );
      await expect(
        registry.registerPrompt({ ...prompt(), id: 'cross', organizationId: 'other' }),
      ).rejects.toThrow(/scope/);
      await registry.registerPromptVersion(promptVersion());
      await expect(
        registry.registerPromptVersion({ ...promptVersion(), id: 'duplicate-version' }),
      ).rejects.toThrow(/version label/);
      await expect(
        registry.registerPromptVersion({
          ...promptVersion('invalid-version'),
          variables: [{ name: 'missing', required: true }],
        }),
      ).rejects.toThrow(/placeholders/);
      await expect(
        registry.registerPromptVersion({
          ...promptVersion('bad-digest'),
          contentDigest: '0'.repeat(64),
        }),
      ).rejects.toThrow(/digest/);
    } finally {
      await adapter.close();
    }
  });
});
