import { describe, expect, it } from 'vitest';
import {
  HandStack,
  HandStackApiError,
  HandStackSdkError,
  type ChatWorkspaceExecutionRequest,
  type FetchLike,
} from '../src/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HandStack SDK client', () => {
  it('publishes the typed Chat Workspace execution contract', () => {
    const request: ChatWorkspaceExecutionRequest = {
      model: 'model-1',
      dataClassification: 'INTERNAL',
      agentId: 'agent-1',
    };
    expect(request.agentId).toBe('agent-1');
  });
  it('rejects empty baseUrl or apiKey at construction', () => {
    expect(() => new HandStack({ baseUrl: '', apiKey: 'hs_live_x' })).toThrow(/baseUrl/);
    expect(() => new HandStack({ baseUrl: 'https://api.test', apiKey: '  ' })).toThrow(/apiKey/);
  });

  it('sends bearer authentication and parses a typed JSON body', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: FetchLike = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(
        jsonResponse({
          object: 'list',
          data: [{ id: 'fast', object: 'model', created: 1, owned_by: 'openai' }],
        }),
      );
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test/',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });
    const result = await client.openai.models.list();
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe('fast');
    expect(calls[0]?.url).toBe('https://api.example.test/v1/models');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer hs_live_x');
  });

  it('maps RFC 9457 problem details into a typed actionable error', async () => {
    const fakeFetch: FetchLike = () =>
      Promise.resolve(
        jsonResponse(
          {
            type: 'https://docs.handstack.dev/problems/rate_limit_exceeded',
            title: 'Rate limit exceeded',
            status: 429,
            detail: 'Too many requests',
            instance: '/v1/chat/completions',
            code: 'rate_limit_exceeded',
            requestId: 'req-1',
            traceId: 'trace-1',
            helpArticleId: 'developer/rate-limits',
          },
          429,
        ),
      );
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });
    const expectation = expect(
      client.openai.chat.completions.create({ model: 'fast', messages: [] }),
    ).rejects;
    await expectation.toBeInstanceOf(HandStackApiError);
    await expectation.toMatchObject({
      status: 429,
      code: 'rate_limit_exceeded',
      requestId: 'req-1',
      helpArticleId: 'developer/rate-limits',
    });
  });

  it('surfaces non-problem error responses as a generic API error', async () => {
    const fakeFetch: FetchLike = () =>
      Promise.resolve(
        new Response('gateway exploded', {
          status: 502,
          headers: { 'content-type': 'text/plain' },
        }),
      );
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });
    await expect(client.openai.models.list()).rejects.toMatchObject({
      status: 502,
      code: 'api_error',
    });
  });

  it('posts capabilities through the governed org-scoped endpoint', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: FetchLike = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(jsonResponse({ ok: true }));
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });
    await client.capabilities.run('acme corp', 'security.review', { repository: 'x/y' });
    expect(calls[0]?.url).toBe(
      'https://api.example.test/api/v1/organizations/acme%20corp/capabilities/security.review/run',
    );
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ repository: 'x/y' }));
  });

  it('covers identity administration and SCIM credential management', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: FetchLike = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(jsonResponse({ items: [] }));
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });

    await client.identity.providers('acme corp');
    await client.identity.createUser('acme corp', { username: 'alice' });
    await client.identity.setProviderEnabled('acme corp', 'idp/1', { enabled: true });
    await client.identity.setLoginPolicy('acme corp', { mode: 'SSO_REQUIRED' });
    await client.identity.deprovisionUser('acme corp', 'user/1');
    await client.scim.endpoint('acme corp');
    await client.scim.issueCredential('acme corp');
    await client.scim.revokeCredential('acme corp');

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.test/organizations/acme%20corp/identity/providers',
      'https://api.example.test/organizations/acme%20corp/identity/users',
      'https://api.example.test/organizations/acme%20corp/identity/providers/idp%2F1/enabled',
      'https://api.example.test/organizations/acme%20corp/identity/login-policy',
      'https://api.example.test/organizations/acme%20corp/identity/users/user%2F1/deprovision',
      'https://api.example.test/api/v1/organizations/acme%20corp/scim',
      'https://api.example.test/api/v1/organizations/acme%20corp/scim/credential',
      'https://api.example.test/api/v1/organizations/acme%20corp/scim/credential',
    ]);
    expect(calls.map((call) => call.init?.method)).toEqual([
      'GET',
      'POST',
      'PATCH',
      'PATCH',
      'PATCH',
      'GET',
      'POST',
      'DELETE',
    ]);
  });

  it('executes agents through REST and streaming endpoints', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const sse = 'data: {"type":"agent.result","content":"ok"}\n\ndata: [DONE]\n\n';
    const fakeFetch: FetchLike = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(
        new Response(
          calls.length <= 2
            ? JSON.stringify({
                runId: 'run-1',
                content: 'ok',
                iterations: 1,
                usage: { inputTokens: 1, outputTokens: 1 },
              })
            : sse,
          {
            status: 200,
            headers: {
              'content-type': calls.length <= 2 ? 'application/json' : 'text/event-stream',
            },
          },
        ),
      );
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });
    await expect(client.agents.run('agent/id', { prompt: 'hello' })).resolves.toMatchObject({
      runId: 'run-1',
    });
    await client.agents.run('security-review', { repository: 'acme/repository' });
    const events: Record<string, unknown>[] = [];
    for await (const event of client.agents.stream('agent/id', { prompt: 'hello' }))
      events.push(event);
    expect(calls[0]?.url).toBe('https://api.example.test/api/v1/agents/agent%2Fid/run');
    expect(calls[2]?.url).toBe('https://api.example.test/api/v1/agents/agent%2Fid/stream');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ prompt: 'hello' }));
    expect(new Headers(calls[2]?.init?.headers).get('authorization')).toBe('Bearer hs_live_x');
    expect(events).toEqual([{ type: 'agent.result', content: 'ok' }]);
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ repository: 'acme/repository' }));
  });

  it('exposes tenant-scoped Knowledge and Privacy operations', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: FetchLike = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(jsonResponse({ items: [] }));
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });

    await client.knowledge.search('acme corp', { query: 'retention' });
    await client.privacy.runRetention('acme corp');
    await client.privacy.runTraceRetention('acme corp');
    await client.privacy.legalHolds('acme corp');

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.test/api/v1/organizations/acme%20corp/knowledge/search',
      'https://api.example.test/api/v1/organizations/acme%20corp/privacy/retention/run',
      'https://api.example.test/api/v1/organizations/acme%20corp/privacy/retention/traces/run',
      'https://api.example.test/api/v1/organizations/acme%20corp/privacy/legal-holds',
    ]);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ query: 'retention' }));
    expect(new Headers(calls[2]?.init?.headers).get('authorization')).toBe('Bearer hs_live_x');
  });

  it('exposes the complete privacy governance lifecycle', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: FetchLike = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(jsonResponse({ items: [] }));
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });

    await client.privacy.createSubjectRequest('acme', { subjectId: 'user/1', type: 'EXPORT' });
    await client.privacy.updateSubjectRequest('acme', 'request/1', { status: 'COMPLETED' });
    await client.privacy.executeSubjectRequest('acme', 'request/1');
    await client.privacy.subjectRequestExport('acme', 'request/1');
    await client.privacy.createInventory('acme', { resourceType: 'CHAT', resourceId: 'chat/1' });
    await client.privacy.createPurpose('acme', {
      name: 'Support',
      description: 'Support',
      lawfulBasis: 'consent',
    });
    await client.privacy.createConsent('acme', { subjectId: 'user/1', purposeId: 'purpose/1' });
    await client.privacy.withdrawConsent('acme', 'consent/1');
    await client.privacy.createProcessor('acme', {
      name: 'Processor',
      purpose: 'Support',
      regions: ['BR'],
    });
    await client.privacy.createIncident('acme', {
      title: 'Leak',
      severity: 'HIGH',
      affectedResources: ['chat/1'],
    });
    await client.privacy.deletionEvidence('acme', 'job/1');
    await client.privacy.setResidency('acme', { region: 'BR', classification: 'CONFIDENTIAL' });

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.test/api/v1/organizations/acme/privacy/subject-requests',
      'https://api.example.test/api/v1/organizations/acme/privacy/subject-requests/request%2F1',
      'https://api.example.test/api/v1/organizations/acme/privacy/subject-requests/request%2F1/execute',
      'https://api.example.test/api/v1/organizations/acme/privacy/subject-requests/request%2F1/export',
      'https://api.example.test/api/v1/organizations/acme/privacy/inventory',
      'https://api.example.test/api/v1/organizations/acme/privacy/purposes',
      'https://api.example.test/api/v1/organizations/acme/privacy/consents',
      'https://api.example.test/api/v1/organizations/acme/privacy/consents/consent%2F1/withdraw',
      'https://api.example.test/api/v1/organizations/acme/privacy/processors',
      'https://api.example.test/api/v1/organizations/acme/privacy/incidents',
      'https://api.example.test/api/v1/organizations/acme/privacy/deletion-jobs/job%2F1/evidence',
      'https://api.example.test/api/v1/organizations/acme/privacy/residency',
    ]);
    expect(calls.map((call) => call.init?.method)).toEqual([
      'POST',
      'PATCH',
      'POST',
      'GET',
      'POST',
      'POST',
      'POST',
      'PATCH',
      'POST',
      'POST',
      'GET',
      'POST',
    ]);
  });

  it('exposes model provider, evaluation, red-team and approval operations', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: FetchLike = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(jsonResponse({ items: [] }));
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });

    await client.models.providers('acme');
    await client.models.createProvider('acme', { name: 'provider', adapter: 'test' });
    await client.models.createModel('acme', { displayName: 'model', providerId: 'provider/1' });
    await client.models.promptVersions('acme', 'prompt/1');
    await client.models.createEvaluationDataset('acme', { name: 'dataset' });
    await client.models.createEvaluationSuite('acme', { name: 'suite' });
    await client.models.createRedTeamCampaign('acme', { targetKind: 'MODEL', targetId: 'model/1' });
    await client.models.executeRedTeamCampaign('acme', 'campaign/1');
    await client.models.evaluationRun('acme', { modelDefinitionId: 'model/1', suiteId: 'suite/1' });
    await client.models.recordEvaluationGate('acme', 'model/1', { runId: 'run/1' });
    await client.models.approveModel('acme', 'model/1');
    await client.models.publishPromptVersion('acme', 'prompt-version/1');

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.test/api/v1/organizations/acme/providers',
      'https://api.example.test/api/v1/organizations/acme/providers',
      'https://api.example.test/api/v1/organizations/acme/models',
      'https://api.example.test/api/v1/organizations/acme/prompts/prompt%2F1/versions',
      'https://api.example.test/api/v1/organizations/acme/evaluation-datasets',
      'https://api.example.test/api/v1/organizations/acme/evaluation-suites',
      'https://api.example.test/api/v1/organizations/acme/red-team-campaigns',
      'https://api.example.test/api/v1/organizations/acme/red-team-campaigns/campaign%2F1/execute',
      'https://api.example.test/api/v1/organizations/acme/evaluation-runs',
      'https://api.example.test/api/v1/organizations/acme/models/model%2F1/evaluation-gates',
      'https://api.example.test/api/v1/organizations/acme/models/model%2F1/approve',
      'https://api.example.test/api/v1/organizations/acme/prompt-versions/prompt-version%2F1/publish',
    ]);
    expect(calls.map((call) => call.init?.method)).toEqual([
      'GET',
      'POST',
      'POST',
      'GET',
      'POST',
      'POST',
      'POST',
      'POST',
      'POST',
      'POST',
      'POST',
      'POST',
    ]);
  });

  it('exposes MCP, plugin, secret and workflow operations', async () => {
    const calls: string[] = [];
    const fakeFetch: FetchLike = (input) => {
      calls.push(String(input));
      return Promise.resolve(jsonResponse({ items: [] }));
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });

    await client.mcp.discover('acme', 'server/1');
    await client.mcp.reconnect('acme', 'server/1');
    await client.mcp.saveCredential('acme', 'server/1', { type: 'API_KEY', secret: 'ref' });
    await client.mcp.startOAuth('acme', 'server/1');
    await client.mcp.completeOAuth('acme', 'server/1', { state: 'state', code: 'code' });
    await client.plugins.enable('acme', 'my plugin');
    await client.secrets.rotate('acme', 'secret/1', { value: 'next' });
    await client.workflows.execute('acme', 'workflow/1', { input: 'hello' });

    expect(calls).toEqual([
      'https://api.example.test/mcp/servers/acme/server%2F1/discover',
      'https://api.example.test/mcp/servers/acme/server%2F1/reconnect',
      'https://api.example.test/mcp/servers/acme/server%2F1/credentials',
      'https://api.example.test/mcp/servers/acme/server%2F1/oauth/start',
      'https://api.example.test/mcp/servers/acme/server%2F1/oauth/callback',
      'https://api.example.test/api/v1/organizations/acme/plugins/my%20plugin/enable',
      'https://api.example.test/api/v1/organizations/acme/secrets/secret%2F1/rotate',
      'https://api.example.test/api/v1/organizations/acme/workflows/workflow%2F1/executions',
    ]);
  });

  it('exposes tenant-scoped notifications and incident lifecycle operations', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: FetchLike = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(jsonResponse({ items: [] }));
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });

    await client.notifications.send('acme', { id: 'n-1', recipientId: 'user-1' });
    await client.notifications.list('acme', 'user/1');
    await client.incidents.transition('acme', 'incident/1', { status: 'MITIGATING' });
    await client.incidents.escalationPolicy('acme', 'gateway/api');

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.test/api/v1/organizations/acme/notifications',
      'https://api.example.test/api/v1/organizations/acme/notifications/user%2F1',
      'https://api.example.test/api/v1/organizations/acme/incidents/incident%2F1/status',
      'https://api.example.test/api/v1/organizations/acme/incidents/escalation-policies/gateway%2Fapi',
    ]);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[2]?.init?.method).toBe('PATCH');
  });

  it('exposes operations, settings and gateway key administration', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: FetchLike = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(jsonResponse({ items: [] }));
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });

    await client.operations.create({ type: 'index' });
    await client.operations.cancel('operation/1');
    await client.settings.update('acme corp', { theme: 'dark' });
    await client.gateway.revoke('acme', 'key/1');

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.test/api/v1/operations',
      'https://api.example.test/api/v1/operations/operation%2F1/cancel',
      'https://api.example.test/api/v1/organizations/acme%20corp/settings',
      'https://api.example.test/api/v1/organizations/acme/gateway/keys/key%2F1/revoke',
    ]);
    expect(calls.map((call) => call.init?.method)).toEqual(['POST', 'POST', 'PATCH', 'POST']);
  });

  it('exposes access governance, directory, budgets and policies', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: FetchLike = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(jsonResponse({ items: [] }));
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });

    await client.access.submitRequest('acme corp', {
      resource: 'prod',
      reason: 'debug',
      duration: '1h',
    });
    await client.access.approve('acme corp', 'request/1', 'user/1');
    await client.access.revoke('acme corp', 'request/1', 'grant/1');
    await client.directory.users('acme corp');
    await client.directory.updateRole('acme corp', 'role/1', { name: 'operators' });
    await client.directory.grantPermission('acme corp', 'role/1', 'permission/1');
    await client.budgets.create('acme corp', {
      scopeType: 'ORGANIZATION',
      scopeKey: 'acme',
      period: 'MONTHLY',
    });
    await client.budgets.pricing('acme corp');
    await client.policies.evaluate('acme corp', {
      principalId: 'user/1',
      resource: 'chat',
      action: 'read',
      groupIds: [],
    });
    await client.serviceAccounts.rotate('acme corp', 'account/1');
    await client.routing.create('acme corp', {
      name: 'safe',
      strategy: 'fallback',
      candidates: [],
    });
    await client.settings.database();

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.test/api/v1/organizations/acme%20corp/access-requests',
      'https://api.example.test/api/v1/organizations/acme%20corp/access-requests/request%2F1/approve',
      'https://api.example.test/api/v1/organizations/acme%20corp/access-requests/request%2F1/grants/grant%2F1/revoke',
      'https://api.example.test/api/v1/organizations/acme%20corp/users',
      'https://api.example.test/api/v1/organizations/acme%20corp/roles/role%2F1',
      'https://api.example.test/api/v1/organizations/acme%20corp/role-permissions',
      'https://api.example.test/api/v1/organizations/acme%20corp/budgets',
      'https://api.example.test/api/v1/organizations/acme%20corp/pricing/models',
      'https://api.example.test/api/v1/organizations/acme%20corp/policies/evaluate',
      'https://api.example.test/api/v1/organizations/acme%20corp/service-accounts/account%2F1/rotate',
      'https://api.example.test/api/v1/organizations/acme%20corp/routing-policies',
      'https://api.example.test/api/v1/admin/settings/database',
    ]);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[2]?.init?.method).toBe('POST');
    expect(calls[5]?.init?.method).toBe('POST');
  });

  it('exposes webhook configuration, delivery and replay operations', async () => {
    const calls: string[] = [];
    const fakeFetch: FetchLike = (input) => {
      calls.push(String(input));
      return Promise.resolve(jsonResponse({ items: [] }));
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });

    await client.webhooks.configure('acme', {
      endpoint: 'https://hooks.test',
      secret: 's'.repeat(16),
    });
    await client.webhooks.deliveries('acme', 'DEAD_LETTERED');
    await client.webhooks.replay('acme', 'delivery/1');

    expect(calls).toEqual([
      'https://api.example.test/api/v1/organizations/acme/webhooks/configuration',
      'https://api.example.test/api/v1/organizations/acme/webhooks/deliveries?status=DEAD_LETTERED',
      'https://api.example.test/api/v1/organizations/acme/webhooks/dead-letters/delivery%2F1/replay',
    ]);
  });

  it('exposes Operations audit, feature flags, jobs and dead-letter administration', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: FetchLike = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(jsonResponse({ items: [], discarded: true }));
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });

    await client.operations.setFeatureFlag('acme corp', 'new/feature', {
      scope: 'organization',
      enabled: true,
    });
    await client.operations.audit('acme corp');
    await client.operations.verifyAudit('acme corp');
    await client.operations.enqueueJob('acme corp', 'workflow-executions', {
      id: 'job/1',
      idempotencyKey: 'job/1',
      payload: {},
    });
    await client.operations.deadLetters('acme corp', 'workflow-executions');
    await client.operations.retryDeadLetter('acme corp', 'workflow-executions', 'job/1');
    await client.operations.discardDeadLetter('acme corp', 'workflow-executions', 'job/1');

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.test/api/v1/organizations/acme%20corp/feature-flags/new%2Ffeature',
      'https://api.example.test/api/v1/organizations/acme%20corp/audit',
      'https://api.example.test/api/v1/organizations/acme%20corp/audit/verify',
      'https://api.example.test/api/v1/organizations/acme%20corp/jobs/workflow-executions',
      'https://api.example.test/api/v1/organizations/acme%20corp/jobs/workflow-executions/dead-letters',
      'https://api.example.test/api/v1/organizations/acme%20corp/jobs/workflow-executions/dead-letters/job%2F1/retry',
      'https://api.example.test/api/v1/organizations/acme%20corp/jobs/workflow-executions/dead-letters/job%2F1',
    ]);
    expect(calls.map((call) => call.init?.method)).toEqual([
      'PUT',
      'GET',
      'GET',
      'POST',
      'GET',
      'POST',
      'DELETE',
    ]);
  });

  it('exposes Chat Workspace conversation and execution operations', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: FetchLike = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(jsonResponse({ items: [] }));
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });

    await client.chat.conversations('acme corp', { cursor: 'next/1', limit: 10 });
    await client.chat.createConversation('acme corp', { title: 'Support' });
    await client.chat.execute('acme corp', 'conversation/1', 'branch/1', 'idem-1', {
      model: 'model-1',
      dataClassification: 'INTERNAL',
      agentId: 'agent/research',
      knowledgeBaseId: 'kb/1',
      parentMessageId: 'message/0',
      traceId: 'trace-1',
    });
    await client.chat.cancel('acme corp', 'message/1', 'cancel-1');

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.test/api/v1/organizations/acme%20corp/conversations?cursor=next%2F1&limit=10',
      'https://api.example.test/api/v1/organizations/acme%20corp/conversations',
      'https://api.example.test/api/v1/organizations/acme%20corp/conversations/conversation%2F1/branches/branch%2F1/executions',
      'https://api.example.test/api/v1/organizations/acme%20corp/messages/message%2F1/cancel',
    ]);
    expect(new Headers(calls[2]?.init?.headers).get('idempotency-key')).toBe('idem-1');
    const executionBody = calls[2]?.init?.body;
    if (typeof executionBody !== 'string') throw new Error('Expected JSON execution body');
    expect(JSON.parse(executionBody)).toMatchObject({
      agentId: 'agent/research',
      knowledgeBaseId: 'kb/1',
      parentMessageId: 'message/0',
      traceId: 'trace-1',
    });
    expect(new Headers(calls[3]?.init?.headers).get('idempotency-key')).toBe('cancel-1');
  });

  it('uploads, signs and deletes Chat Workspace attachments', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: FetchLike = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(jsonResponse({ ok: true }));
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });
    await client.chat.uploadAttachment(
      'acme corp',
      'conversation/1',
      new Blob(['hello'], { type: 'text/plain' }),
      'hello.txt',
      'CONFIDENTIAL',
    );
    await client.chat.attachmentUrl('acme corp', 'conversation/1', 'attachment/1', 60);
    await client.chat.deleteAttachment('acme corp', 'conversation/1', 'attachment/1');

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.test/api/v1/organizations/acme%20corp/conversations/conversation%2F1/attachments?dataClassification=CONFIDENTIAL',
      'https://api.example.test/api/v1/organizations/acme%20corp/conversations/conversation%2F1/attachments/attachment%2F1/url?expiresInSeconds=60',
      'https://api.example.test/api/v1/organizations/acme%20corp/conversations/conversation%2F1/attachments/attachment%2F1',
    ]);
    expect(calls[0]?.init?.body).toBeInstanceOf(FormData);
    expect(new Headers(calls[0]?.init?.headers).has('content-type')).toBe(false);
    expect(calls[2]?.init?.method).toBe('DELETE');
  });

  it('encodes identifiers for destructive and lifecycle operations', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: FetchLike = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(jsonResponse({ ok: true }));
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });

    await client.knowledge.cancelReindexJob('acme', 'job/1');
    await client.privacy.releaseLegalHold('acme', 'hold/1');
    await client.plugins.uninstall('acme', 'plugin/1');
    await client.secrets.remove('acme', 'secret/1');
    await client.workflows.execution('acme', 'workflow/1', 'execution/1');

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.test/api/v1/organizations/acme/knowledge/reindex-jobs/job%2F1/cancel',
      'https://api.example.test/api/v1/organizations/acme/privacy/legal-holds/hold%2F1/release',
      'https://api.example.test/api/v1/organizations/acme/plugins/plugin%2F1',
      'https://api.example.test/api/v1/organizations/acme/secrets/secret%2F1',
      'https://api.example.test/api/v1/organizations/acme/workflows/workflow%2F1/executions/execution%2F1',
    ]);
    expect(calls.map((call) => call.init?.method)).toEqual([
      'POST',
      'PATCH',
      'DELETE',
      'DELETE',
      'GET',
    ]);
  });

  it('streams SSE chunks and stops at the [DONE] sentinel', async () => {
    const stream = [
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"He"},"finish_reason":null}]}',
      '',
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":null}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');
    const fakeFetch: FetchLike = () =>
      Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });
    const parts: string[] = [];
    for await (const chunk of client.openai.chat.completions.stream({
      model: 'fast',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      parts.push(chunk.choices[0]?.delta.content ?? '');
    }
    expect(parts).toEqual(['He', 'llo']);
  });

  it('maps aborted transports to a typed SDK error', async () => {
    const fakeFetch: FetchLike = () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    };
    const client = new HandStack({
      baseUrl: 'https://api.example.test',
      apiKey: 'hs_live_x',
      fetch: fakeFetch,
    });
    await expect(client.openai.models.list()).rejects.toBeInstanceOf(HandStackSdkError);
  });
});
