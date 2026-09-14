import { IdentityAdministrationService } from '@handstack/identity-service';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { createApplication } from '../src/main.js';
import { ModelAdminRuntimeService } from '../src/models/model-admin-runtime.service.js';

const organizationId = 'model-admin-organization';
const password = 'model admin password long enough';

describe('model administration HTTP contract', () => {
  let app: NestFastifyApplication;
  let runtime: ModelAdminRuntimeService;
  let adminToken: string;
  let readerToken: string;

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET = 'model-admin-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'model-admin-token-pepper-at-least-32-characters';
    process.env.HANDSTACK_SECRET_ANTHROPIC_TEST = 'anthropic-test-secret';
    process.env.HANDSTACK_SECRET_GEMINI_TEST = 'gemini-test-secret';
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const auth = app.get(AuthRuntimeService);
    runtime = app.get(ModelAdminRuntimeService);
    const administration = new IdentityAdministrationService(auth.storage);
    await administration.createUser(organizationId, {
      id: 'model-admin-user',
      username: 'model.admin',
      displayName: 'Model Admin',
    });
    await administration.createUser(organizationId, {
      id: 'model-reader-user',
      username: 'model.reader',
      displayName: 'Model Reader',
    });
    const role = await administration.createRole(organizationId, { name: 'Model admin' });
    const permission = await administration.createPermission(organizationId, 'models.manage');
    const executePermission = await administration.createPermission(
      organizationId,
      'models.execute',
    );
    const promptPermission = await administration.createPermission(
      organizationId,
      'prompts.manage',
    );
    await administration.grantPermission(organizationId, role.id, permission.id);
    await administration.grantPermission(organizationId, role.id, executePermission.id);
    await administration.grantPermission(organizationId, role.id, promptPermission.id);
    await administration.assignRole(organizationId, 'model-admin-user', role.id);
    await auth.authentication.setPassword(organizationId, 'model-admin-user', password);
    await auth.authentication.setPassword(organizationId, 'model-reader-user', password);
    adminToken = (await auth.authentication.login(organizationId, 'model.admin', password))
      .accessToken;
    readerToken = (await auth.authentication.login(organizationId, 'model.reader', password))
      .accessToken;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
    delete process.env.HANDSTACK_SECRET_ANTHROPIC_TEST;
    delete process.env.HANDSTACK_SECRET_GEMINI_TEST;
  });

  afterEach(() => vi.restoreAllMocks());

  it('publishes versioned OpenAPI with canonical provider and model operations', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(response.statusCode).toBe(200);
    const document = response.json<{ paths: Record<string, unknown> }>();
    expect(document.paths).toHaveProperty('/api/v1/organizations/{organizationId}/providers');
    expect(document.paths).toHaveProperty('/api/v1/organizations/{organizationId}/models');
    expect(document.paths).toHaveProperty(
      '/api/v1/organizations/{organizationId}/evaluation-datasets',
    );
    expect(document.paths).toHaveProperty(
      '/api/v1/organizations/{organizationId}/evaluation-suites',
    );
    expect(document.paths).toHaveProperty('/api/v1/organizations/{organizationId}/evaluation-runs');
    expect(document.paths).toHaveProperty(
      '/api/v1/organizations/{organizationId}/models/{modelId}/evaluation-gates',
    );
    expect(document.paths).toHaveProperty(
      '/api/v1/organizations/{organizationId}/models/{modelId}/publish',
    );
    expect(document.paths).toHaveProperty('/api/v1/organizations/{organizationId}/model-responses');
    expect(document.paths).toHaveProperty('/api/v1/organizations/{organizationId}/prompts');
    expect(document.paths).toHaveProperty(
      '/api/v1/organizations/{organizationId}/prompts/{promptId}/versions',
    );
    expect(document.paths).toHaveProperty(
      '/api/v1/organizations/{organizationId}/prompt-versions/{promptVersionId}/publish',
    );
    expect(JSON.stringify(document.paths)).toContain('dataClassificationAllowed');
    expect(JSON.stringify(document.paths)).toContain('hasSecret');
  });

  it('requires authentication, models.manage and exact organization scope', async () => {
    const url = `/api/v1/organizations/${organizationId}/providers`;
    await expect(app.inject({ method: 'GET', url })).resolves.toMatchObject({ statusCode: 401 });
    await expect(
      app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${readerToken}` },
      }),
    ).resolves.toMatchObject({ statusCode: 403 });
    await expect(
      app.inject({
        method: 'GET',
        url: '/api/v1/organizations/other-organization/providers',
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    ).resolves.toMatchObject({ statusCode: 403 });
  });

  it('registers and lists providers/models without exposing secret material', async () => {
    const headers = { authorization: `Bearer ${adminToken}` };
    const providerResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/providers`,
      headers,
      payload: {
        name: 'Primary OpenAI',
        adapter: 'openai',
        enabled: true,
        secretReference: 'env://HANDSTACK_OPENAI_SECRET',
        configuration: { region: 'us-east-1' },
        dataClassificationAllowed: ['PUBLIC', 'INTERNAL'],
      },
    });
    expect(providerResponse.statusCode).toBe(201);
    const provider = providerResponse.json<{ id: string; hasSecret: boolean }>();
    expect(provider.hasSecret).toBe(true);
    expect(JSON.stringify(providerResponse.json())).not.toContain('HANDSTACK_OPENAI_SECRET');
    expect(providerResponse.json()).not.toHaveProperty('secretReference');

    const modelResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/models`,
      headers,
      payload: {
        displayName: 'Coding model',
        providerId: provider.id,
        providerModel: 'vendor-coding-model',
        aliases: ['coding', 'smart'],
        capabilities: ['chat', 'tools'],
        contextWindow: 128000,
        pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' },
      },
    });
    expect(modelResponse.statusCode).toBe(201);
    expect(modelResponse.json()).toMatchObject({
      lifecycle: 'DRAFT',
      aliases: ['coding', 'smart'],
    });

    const providers = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/providers`,
      headers,
    });
    const models = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/models`,
      headers,
    });
    expect(providers.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(models.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(JSON.stringify(providers.json())).not.toContain('secretReference');

    const audit = await runtime.registry.listAuditEvents(organizationId);
    expect(audit.items.map(({ eventType }) => eventType)).toEqual([
      'PROVIDER_REGISTERED',
      'MODEL_REGISTERED',
    ]);
  });

  it('rejects unknown fields and secret-like public configuration', async () => {
    const headers = { authorization: `Bearer ${adminToken}` };
    const unknown = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/providers`,
      headers,
      payload: {
        name: 'Unknown field provider',
        adapter: 'openai',
        enabled: true,
        dataClassificationAllowed: ['PUBLIC'],
        unexpected: true,
      },
    });
    expect(unknown.statusCode).toBe(400);

    const sensitive = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/providers`,
      headers,
      payload: {
        name: 'Unsafe provider',
        adapter: 'openai',
        enabled: true,
        configuration: { apiKey: 'must-not-be-here' },
        dataClassificationAllowed: ['PUBLIC'],
      },
    });
    expect(sensitive.statusCode).toBe(400);
    expect(JSON.stringify(sensitive.json())).not.toContain('must-not-be-here');
  });

  it('runs a real candidate, records only its persisted gate, then approves and publishes', async () => {
    const headers = { authorization: `Bearer ${adminToken}` };
    const datasetResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/evaluation-datasets`,
      headers,
      payload: {
        name: 'Synthetic release set',
        datasetVersion: 'dataset-v1',
        classification: 'INTERNAL',
        provenance: 'handstack synthetic generator v1',
        owner: 'ai-platform',
        retentionDays: 90,
        sourceKind: 'SYNTHETIC',
        approvedForEvaluation: true,
        sanitized: true,
        cases: [
          {
            id: 'case-1',
            input: {
              messages: [{ role: 'user', content: 'private evaluation input' }],
            },
            expected: {
              content: '{"answer":"approved"}',
              contentIncludes: ['approved'],
              contentExcludes: ['sk-forbidden-secret-value'],
              jsonObject: true,
            },
          },
        ],
      },
    });
    expect(datasetResponse.statusCode).toBe(201);
    expect(datasetResponse.json()).toMatchObject({
      datasetVersion: 'dataset-v1',
      caseCount: 1,
      hasLegalBasis: false,
    });
    expect(JSON.stringify(datasetResponse.json())).not.toContain('private evaluation input');
    expect(JSON.stringify(datasetResponse.json())).not.toContain('expected private answer');
    const datasetId = datasetResponse.json<{ id: string }>().id;

    const criteria = [
      ['task_success', 'min', 0.8],
      ['schema_validity', 'min', 1],
      ['tool_selection_correctness', 'min', 0.9],
      ['tool_argument_correctness', 'min', 0.9],
      ['safety_policy_compliance', 'min', 1],
      ['prompt_injection_resistance', 'min', 1],
      ['pii_secret_leakage', 'max', 0],
      ['latency_ms', 'max', 5000],
      ['token_usage', 'max', 1000],
      ['cost_usd', 'max', 1],
    ].map(([metric, direction, threshold]) => ({ metric, direction, threshold }));
    const incompleteSuite = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/evaluation-suites`,
      headers,
      payload: {
        name: 'Incomplete gate',
        suiteVersion: 'incomplete-v1',
        datasetId,
        datasetVersion: 'dataset-v1',
        criteria: [criteria[0]],
      },
    });
    expect(incompleteSuite.statusCode).toBe(400);

    const suiteResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/evaluation-suites`,
      headers,
      payload: {
        name: 'Model release gate',
        suiteVersion: 'suite-v1',
        datasetId,
        datasetVersion: 'dataset-v1',
        criteria,
      },
    });
    expect(suiteResponse.statusCode).toBe(201);
    expect(suiteResponse.json()).toMatchObject({
      suiteVersion: 'suite-v1',
      datasetId,
      criteria,
    });

    const datasets = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/evaluation-datasets`,
      headers,
    });
    const suites = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/evaluation-suites`,
      headers,
    });
    expect(datasets.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(suites.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(JSON.stringify(datasets.json())).not.toContain('private evaluation input');

    const providerResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/providers`,
      headers,
      payload: {
        name: 'Evaluation compatible provider',
        adapter: 'openai-compatible',
        enabled: true,
        baseUrl: 'https://evaluation-provider.example.test/v1',
        dataClassificationAllowed: ['INTERNAL'],
      },
    });
    expect(providerResponse.statusCode).toBe(201);
    const modelResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/models`,
      headers,
      payload: {
        displayName: 'Evaluation candidate',
        providerId: providerResponse.json<{ id: string }>().id,
        providerModel: 'candidate-v1',
        aliases: ['evaluation-candidate'],
        capabilities: ['chat'],
        contextWindow: 4096,
        pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' },
      },
    });
    expect(modelResponse.statusCode).toBe(201);
    const modelId = modelResponse.json<{ id: string }>().id;
    const suiteId = suiteResponse.json<{ id: string }>().id;

    const unpublishedResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/model-responses`,
      headers,
      payload: {
        model: 'evaluation-candidate',
        dataClassification: 'INTERNAL',
        messages: [{ role: 'user', content: 'Return the approved answer.' }],
      },
    });
    expect(unpublishedResponse.statusCode).toBe(400);

    const prematureApproval = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/models/${modelId}/approve`,
      headers,
    });
    expect(prematureApproval.statusCode).toBe(400);

    const fabricated = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/evaluation-runs`,
      headers,
      payload: {
        modelDefinitionId: modelId,
        suiteId,
        suiteVersion: 'suite-v1',
        scores: { task_success: 1 },
      },
    });
    expect(fabricated.statusCode).toBe(400);

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/models')) {
        const body = url.includes('anthropic')
          ? { data: [{ id: 'candidate-anthropic' }] }
          : url.includes('googleapis')
            ? { models: [{ name: 'models/candidate-gemini' }] }
            : { data: [{ id: 'candidate-v1' }] };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.includes('anthropic')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              content: [{ type: 'text', text: '{"answer":"approved"}' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 20, output_tokens: 10 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (url.includes('googleapis')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: { parts: [{ text: '{"answer":"approved"}' }] },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"answer":"approved"}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 10 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    const runResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/evaluation-runs`,
      headers,
      payload: { modelDefinitionId: modelId, suiteId, suiteVersion: 'suite-v1' },
    });
    expect(runResponse.statusCode).toBe(201);
    const run = runResponse.json<{
      runId: string;
      passed: boolean;
      scores: Record<string, number>;
    }>();
    expect(run).toMatchObject({
      passed: true,
      scores: { task_success: 1, token_usage: 30, pii_secret_leakage: 0 },
    });

    const fakeGate = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/models/${modelId}/evaluation-gates`,
      headers,
      payload: { runId: '0'.repeat(64) },
    });
    expect(fakeGate.statusCode).toBe(400);
    const gateResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/models/${modelId}/evaluation-gates`,
      headers,
      payload: { runId: run.runId },
    });
    expect(gateResponse.statusCode).toBe(201);
    const gate = gateResponse.json<{ model: { lifecycle: string } }>();
    expect(gate).toMatchObject({ model: { lifecycle: 'EVALUATED' } });

    const approveResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/models/${modelId}/approve`,
      headers,
    });
    expect(approveResponse.statusCode).toBe(201);
    expect(approveResponse.json()).toMatchObject({ lifecycle: 'APPROVED' });
    const publishResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/models/${modelId}/publish`,
      headers,
    });
    expect(publishResponse.statusCode).toBe(201);
    expect(publishResponse.json()).toMatchObject({ lifecycle: 'PUBLISHED' });

    const promoteNative = async (
      adapter: 'anthropic' | 'gemini',
      providerModel: string,
      secretReference: string,
    ) => {
      const provider = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organizationId}/providers`,
        headers,
        payload: {
          name: `${adapter} evaluation provider`,
          adapter,
          enabled: true,
          secretReference,
          dataClassificationAllowed: ['INTERNAL'],
        },
      });
      expect(provider.statusCode).toBe(201);
      const alias = `evaluation-${adapter}`;
      const model = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organizationId}/models`,
        headers,
        payload: {
          displayName: `${adapter} evaluation candidate`,
          providerId: provider.json<{ id: string }>().id,
          providerModel,
          aliases: [alias],
          capabilities: ['chat'],
          contextWindow: 4096,
          pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' },
        },
      });
      expect(model.statusCode).toBe(201);
      const nativeModelId = model.json<{ id: string }>().id;
      const nativeRun = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organizationId}/evaluation-runs`,
        headers,
        payload: {
          modelDefinitionId: nativeModelId,
          suiteId,
          suiteVersion: 'suite-v1',
        },
      });
      expect(nativeRun.statusCode).toBe(201);
      const nativeGate = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organizationId}/models/${nativeModelId}/evaluation-gates`,
        headers,
        payload: { runId: nativeRun.json<{ runId: string }>().runId },
      });
      expect(nativeGate.statusCode).toBe(201);
      for (const action of ['approve', 'publish']) {
        const promotion = await app.inject({
          method: 'POST',
          url: `/api/v1/organizations/${organizationId}/models/${nativeModelId}/${action}`,
          headers,
        });
        expect(promotion.statusCode).toBe(201);
      }
      return alias;
    };

    const aliases = [
      'evaluation-candidate',
      await promoteNative(
        'anthropic',
        'candidate-anthropic',
        'env://HANDSTACK_SECRET_ANTHROPIC_TEST',
      ),
      await promoteNative('gemini', 'candidate-gemini', 'env://HANDSTACK_SECRET_GEMINI_TEST'),
    ];
    const contents: string[] = [];
    for (const model of aliases) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organizationId}/model-responses`,
        headers,
        payload: {
          model,
          dataClassification: 'INTERNAL',
          messages: [{ role: 'user', content: 'Return the approved answer.' }],
        },
      });
      expect(response.statusCode).toBe(200);
      contents.push(response.json<{ content: string }>().content);
    }
    expect(contents).toEqual([
      '{"answer":"approved"}',
      '{"answer":"approved"}',
      '{"answer":"approved"}',
    ]);
    const forbiddenExecution = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/model-responses`,
      headers: { authorization: `Bearer ${readerToken}` },
      payload: {
        model: aliases[0],
        dataClassification: 'INTERNAL',
        messages: [{ role: 'user', content: 'Return the approved answer.' }],
      },
    });
    expect(forbiddenExecution.statusCode).toBe(403);

    const promptResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/prompts`,
      headers,
      payload: { name: 'Support policy', slug: 'support-policy' },
    });
    expect(promptResponse.statusCode).toBe(201);
    const promptId = promptResponse.json<{ id: string }>().id;
    const promptVersionResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/prompts/${promptId}/versions`,
      headers,
      payload: {
        versionLabel: '1.0.0',
        content: 'Always return an approved JSON answer.',
        variables: [],
        modelDefinitionId: modelId,
      },
    });
    expect(promptVersionResponse.statusCode).toBe(201);
    const promptVersionId = promptVersionResponse.json<{ id: string }>().id;
    await expect(
      app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organizationId}/prompt-versions/${promptVersionId}/publish`,
        headers,
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    const promptRun = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/evaluation-runs`,
      headers,
      payload: {
        modelDefinitionId: modelId,
        promptVersionId,
        suiteId,
        suiteVersion: 'suite-v1',
      },
    });
    expect(promptRun.statusCode).toBe(201);
    const promptGate = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/prompt-versions/${promptVersionId}/evaluation-gates`,
      headers,
      payload: { runId: promptRun.json<{ runId: string }>().runId },
    });
    expect(promptGate.statusCode).toBe(201);
    expect(promptGate.json()).toMatchObject({ promptVersion: { lifecycle: 'EVALUATED' } });
    for (const action of ['approve', 'publish']) {
      const promotion = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organizationId}/prompt-versions/${promptVersionId}/${action}`,
        headers,
      });
      expect(promotion.statusCode).toBe(201);
    }
    const secondVersion = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/prompts/${promptId}/versions`,
      headers,
      payload: {
        versionLabel: '2.0.0',
        content: 'Return a revised approved JSON answer.',
        variables: [],
        modelDefinitionId: modelId,
      },
    });
    expect(secondVersion.statusCode).toBe(201);
    const secondVersionId = secondVersion.json<{ id: string }>().id;
    const staleGate = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/prompt-versions/${secondVersionId}/evaluation-gates`,
      headers,
      payload: { runId: promptRun.json<{ runId: string }>().runId },
    });
    expect(staleGate.statusCode).toBe(400);
    const promptVersions = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/prompts/${promptId}/versions`,
      headers,
    });
    expect(promptVersions.json<{ items: unknown[] }>().items).toHaveLength(2);
    await expect(
      app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}/prompts`,
        headers: { authorization: `Bearer ${readerToken}` },
      }),
    ).resolves.toMatchObject({ statusCode: 403 });
    expect(JSON.stringify({ run, gate })).not.toContain('private evaluation input');
  });

  it('rejects production data without explicit legal basis and sanitization', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/evaluation-datasets`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Unsafe production set',
        datasetVersion: 'production-v1',
        classification: 'RESTRICTED',
        provenance: 'production export',
        owner: 'ai-platform',
        retentionDays: 30,
        sourceKind: 'PRODUCTION',
        approvedForEvaluation: true,
        sanitized: false,
        cases: [{ id: 'case-1', input: { prompt: 'sensitive' } }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).not.toContain('sensitive');
  });
});
