import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import type { EvaluationGateInput } from '@handstack/models';
import { describe, expect, it } from 'vitest';
import {
  CoreEvaluationProvider,
  minimumRagGateMetrics,
  scoreRagEvaluation,
  validateRagEvaluationCriteria,
  type EvaluationCaseRunner,
  type EvaluationDataset,
  type EvaluationSuite,
} from '../src/index.js';

const organizationId = 'evaluation-organization';
const now = new Date('2026-09-01T16:00:00.000Z');
const base = (id: string) => ({
  id,
  tenantId: organizationId,
  organizationId,
  version: 1,
  createdAt: now,
  updatedAt: now,
});
const dataset: EvaluationDataset = {
  ...base('dataset'),
  name: 'Approved synthetic set',
  datasetVersion: 'dataset-v1',
  classification: 'INTERNAL',
  provenance: 'handstack synthetic generator v1',
  owner: 'ai-platform-team',
  retentionDays: 90,
  sourceKind: 'SYNTHETIC',
  approvedForEvaluation: true,
  sanitized: true,
  cases: [
    { id: 'case-b', input: { prompt: 'b' } },
    { id: 'case-a', input: { prompt: 'a' } },
  ],
};
const suite: EvaluationSuite = {
  ...base('suite'),
  name: 'M3 release gate',
  suiteVersion: 'suite-v1',
  datasetId: dataset.id,
  datasetVersion: dataset.datasetVersion,
  criteria: [
    { metric: 'task_success', direction: 'min', threshold: 0.8 },
    { metric: 'schema_validity', direction: 'min', threshold: 1 },
    { metric: 'tool_selection_correctness', direction: 'min', threshold: 0.9 },
    { metric: 'tool_argument_correctness', direction: 'min', threshold: 0.9 },
    { metric: 'safety_policy_compliance', direction: 'min', threshold: 1 },
    { metric: 'prompt_injection_resistance', direction: 'min', threshold: 1 },
    { metric: 'pii_secret_leakage', direction: 'max', threshold: 0 },
    { metric: 'latency_ms', direction: 'max', threshold: 500 },
    { metric: 'token_usage', direction: 'max', threshold: 100 },
    { metric: 'cost_usd', direction: 'max', threshold: 0.01 },
  ],
};

describe('core evaluation provider', () => {
  it('scores governed RAG evidence and requires the complete RAG gate', () => {
    expect(
      scoreRagEvaluation({
        expectedChunkIds: ['a', 'b'],
        retrievedChunkIds: ['b', 'c'],
        claimCount: 4,
        groundedClaimCount: 3,
        citationCount: 4,
        validCitationCount: 3,
        freshCitationCount: 2,
        crossTenantLeakCount: 0,
      }),
    ).toEqual({
      recall: 0.5,
      precision: 0.5,
      groundedness: 0.75,
      citation_validity: 0.75,
      freshness: 0.5,
      cross_tenant_isolation: 1,
    });
    expect(() => {
      validateRagEvaluationCriteria([]);
    }).toThrow(/RAG evaluation suite/);
    expect(() => {
      validateRagEvaluationCriteria(
        minimumRagGateMetrics.map((metric) => ({ metric, direction: 'min', threshold: 0 })),
      );
    }).not.toThrow();
    expect(() =>
      scoreRagEvaluation({
        expectedChunkIds: [],
        retrievedChunkIds: [],
        claimCount: 1,
        groundedClaimCount: 2,
        citationCount: 0,
        validCitationCount: 0,
        freshCitationCount: 0,
        crossTenantLeakCount: 0,
      }),
    ).toThrow(/inconsistent/);
  });

  it('runs versioned cases deterministically, persists provenance and validates only that run', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const order: string[] = [];
      const runner: EvaluationCaseRunner = {
        runCase: ({ evaluationCase }) => {
          order.push(evaluationCase.id);
          return Promise.resolve({
            scores: {
              task_success: 0.9,
              schema_validity: 1,
              tool_selection_correctness: 1,
              tool_argument_correctness: 1,
              safety_policy_compliance: 1,
              prompt_injection_resistance: 1,
              pii_secret_leakage: 0,
              latency_ms: evaluationCase.id === 'case-a' ? 300 : 400,
              token_usage: 50,
              cost_usd: 0.005,
            },
            evidence: { caseId: evaluationCase.id, output: 'approved synthetic result' },
          });
        },
      };
      const provider = new CoreEvaluationProvider(adapter, runner, () => now);
      await provider.registerDataset(dataset);
      await provider.registerSuite(suite);
      const input = {
        organizationId,
        modelDefinitionId: 'model',
        suiteId: suite.id,
        suiteVersion: suite.suiteVersion,
      };
      const result = await provider.run(input);
      expect(order).toEqual(['case-a', 'case-b']);
      expect(result).toMatchObject({
        datasetVersion: 'dataset-v1',
        passed: true,
        scores: { task_success: 0.9, latency_ms: 350 },
      });
      await expect(provider.run(input)).resolves.toEqual(result);
      const gate: EvaluationGateInput = { ...input, result };
      await expect(provider.validateGate(gate)).resolves.toEqual({ passed: true, reasons: [] });
      await expect(
        provider.validateGate({
          ...gate,
          result: { ...result, scores: { ...result.scores, task_success: 1 } },
        }),
      ).resolves.toEqual({ passed: false, reasons: ['PERSISTED_RUN_MISMATCH'] });
      const promptInput = {
        ...input,
        promptVersionId: 'prompt-v1',
        promptContentDigest: 'a'.repeat(64),
      };
      const promptResult = await provider.run(promptInput);
      await expect(
        provider.validateGate({ ...promptInput, result: promptResult }),
      ).resolves.toEqual({ passed: true, reasons: [] });
      await expect(
        provider.validateGate({
          ...promptInput,
          promptContentDigest: 'b'.repeat(64),
          result: promptResult,
        }),
      ).resolves.toEqual({ passed: false, reasons: ['PERSISTED_RUN_MISMATCH'] });
      const audit = await provider.listAuditEvents(organizationId);
      expect(audit.items.map(({ eventType }) => eventType)).toEqual([
        'EVALUATION_DATASET_REGISTERED',
        'EVALUATION_SUITE_REGISTERED',
        'EVALUATION_RUN_COMPLETED',
        'EVALUATION_RUN_COMPLETED',
      ]);
      expect(JSON.stringify(audit.items)).not.toContain('approved synthetic result');
      await expect(provider.listAuditEvents('other-organization')).resolves.toMatchObject({
        items: [],
      });
    } finally {
      await adapter.close();
    }
  });

  it('rejects ungoverned production data and missing/non-finite required metrics', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const provider = new CoreEvaluationProvider(adapter, {
        runCase: () => Promise.resolve({ scores: { task_success: Number.NaN }, evidence: {} }),
      });
      await expect(
        provider.registerDataset({
          ...dataset,
          id: 'unsafe',
          sourceKind: 'PRODUCTION',
          sanitized: false,
        }),
      ).rejects.toThrow(/legal basis and sanitization/);
      await provider.registerDataset(dataset);
      await provider.registerSuite(suite);
      await expect(
        provider.run({
          organizationId,
          modelDefinitionId: 'model',
          suiteId: suite.id,
          suiteVersion: suite.suiteVersion,
        }),
      ).rejects.toThrow(/missing or invalid/);
    } finally {
      await adapter.close();
    }
  });

  it('requires the product minimum quality, tool, security and efficiency metrics', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const provider = new CoreEvaluationProvider(adapter, {
        runCase: () => Promise.resolve({ scores: {}, evidence: {} }),
      });
      await provider.registerDataset(dataset);
      await expect(
        provider.registerSuite({
          ...suite,
          id: 'incomplete-suite',
          criteria: [{ metric: 'task_success', direction: 'min', threshold: 0.8 }],
        }),
      ).rejects.toThrow(/product minimum metrics/);
    } finally {
      await adapter.close();
    }
  });
});
