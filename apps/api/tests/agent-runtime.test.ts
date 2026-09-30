import { describe, expect, it, vi } from 'vitest';
import { AgentRuntimeService } from '../src/agents/agent-runtime.service.js';
import { ApiMetrics } from '../src/observability/api-metrics.js';
import { CapabilityExecutionEngine, InMemoryCapabilityRegistry } from '@handstack/capabilities';
import type { AgentModel } from '@handstack/agents';
import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';

describe('AgentRuntimeService', () => {
  it('installs a first-party template as a published tenant-scoped agent', async () => {
    const runtime = new AgentRuntimeService();
    expect(runtime.listTemplates().map((template) => template.id)).toContain(
      'security-review-agent',
    );
    const installed = await runtime.installTemplate('org-templates', 'security-review-agent');
    expect(installed.agent.organizationId).toBe('org-templates');
    expect(installed.version.status).toBe('PUBLISHED');
    expect(await runtime.list('other-org')).toHaveLength(0);
  });

  it('keeps agents tenant-scoped and publishes one version at a time', async () => {
    const runtime = new AgentRuntimeService();
    const agent = await runtime.create({
      organizationId: 'org-1',
      slug: 'support-agent',
      name: 'Support',
    });
    const first = await runtime.createVersion({
      organizationId: 'org-1',
      agentId: agent.id,
      model: 'model-a',
      systemPrompt: 'A',
    });
    const second = await runtime.createVersion({
      organizationId: 'org-1',
      agentId: agent.id,
      model: 'model-b',
      systemPrompt: 'B',
    });
    await expect(runtime.list('org-2')).resolves.toHaveLength(0);
    await expect(runtime.versionsFor('org-2', agent.id)).rejects.toThrow('Agent not found');
    await runtime.publish('org-1', agent.id, first.id);
    await runtime.publish('org-1', agent.id, second.id);
    expect((await runtime.versionsFor('org-1', agent.id)).map((version) => version.status)).toEqual(
      ['DEPRECATED', 'PUBLISHED'],
    );
  });

  it('connects agent lifecycle observations to canonical API metrics', async () => {
    const registry = new InMemoryCapabilityRegistry();
    const engine = new CapabilityExecutionEngine(registry, { authorize: () => Promise.resolve() });
    const metrics = new ApiMetrics();
    const runtime = new AgentRuntimeService(undefined, { engine } as never, metrics);
    const agent = await runtime.create({
      organizationId: 'org',
      slug: 'metrics-agent',
      name: 'Metrics',
    });
    const version = await runtime.createVersion({
      organizationId: 'org',
      agentId: agent.id,
      model: 'test',
      systemPrompt: 'system',
    });
    await runtime.publish('org', agent.id, version.id);
    let calls = 0;
    const model: AgentModel = {
      complete: () => {
        calls += 1;
        return Promise.resolve({ kind: 'final', content: 'done' });
      },
    };
    const published = (await runtime.versionsFor('org', agent.id))[0];
    if (published === undefined) throw new Error('Published agent version is missing');
    await runtime.run(model, {
      organizationId: 'org',
      principalId: 'user',
      agentVersion: published,
      prompt: 'private prompt',
    });
    expect(calls).toBe(1);
    const exposition = metrics.render();
    expect(exposition).toContain('handstack_agent_runs_total 1');
    expect(exposition).not.toContain('private prompt');
  });

  it('rolls back to the previous persisted version and restores its full configuration', async () => {
    const runtime = new AgentRuntimeService();
    const agent = await runtime.create({
      organizationId: 'org-rollback',
      slug: 'rollback-agent',
      name: 'Rollback',
    });
    const first = await runtime.createVersion({
      organizationId: 'org-rollback',
      agentId: agent.id,
      model: 'model-approved',
      systemPrompt: 'approved prompt',
      configuration: { mcpServers: ['safe-server'], guardrails: ['secret-detection'] },
    });
    const second = await runtime.createVersion({
      organizationId: 'org-rollback',
      agentId: agent.id,
      model: 'model-new',
      systemPrompt: 'new prompt',
    });
    await runtime.publish('org-rollback', agent.id, first.id);
    await runtime.publish('org-rollback', agent.id, second.id);
    const rolledBack = await runtime.rollback('org-rollback', agent.id);
    expect(rolledBack.id).toBe(first.id);
    expect(rolledBack.status).toBe('PUBLISHED');
    expect(rolledBack.model).toBe('model-approved');
    expect(rolledBack.configuration).toEqual({
      mcpServers: ['safe-server'],
      guardrails: ['secret-detection'],
    });
  });

  it('executes a published Agent Tool with tenant and recursion guards', async () => {
    const engine = new CapabilityExecutionEngine(new InMemoryCapabilityRegistry(), {
      authorize: () => Promise.resolve(),
    });
    let callerCalls = 0;
    const chat = vi.fn().mockImplementation(({ model }: { model: string }) => {
      if (model === 'caller-model' && callerCalls++ === 0)
        return Promise.resolve({
          content: '',
          finishReason: 'tool_call',
          toolCalls: [{ name: 'tool-agent', arguments: { prompt: 'delegated prompt' } }],
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      return Promise.resolve({
        content: model === 'tool-model' ? 'delegated result' : 'caller result',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    });
    const runtime = new AgentRuntimeService(undefined, { engine } as never, undefined, {
      execution: { chat },
    } as never);
    const target = await runtime.create({
      organizationId: 'org-agent-tools',
      slug: 'tool-agent',
      name: 'Tool Agent',
    });
    const targetVersion = await runtime.createVersion({
      organizationId: 'org-agent-tools',
      agentId: target.id,
      model: 'tool-model',
      systemPrompt: 'Tool system',
      configuration: { publishChannels: ['AGENT_TOOL'] },
    });
    await runtime.publish('org-agent-tools', target.id, targetVersion.id);
    const caller = await runtime.create({
      organizationId: 'org-agent-tools',
      slug: 'caller-agent',
      name: 'Caller Agent',
    });
    const callerVersion = await runtime.createVersion({
      organizationId: 'org-agent-tools',
      agentId: caller.id,
      model: 'caller-model',
      systemPrompt: 'Caller system',
      tools: ['tool-agent'],
    });
    await runtime.publish('org-agent-tools', caller.id, callerVersion.id);
    await expect(
      runtime.runPublished({
        organizationId: 'org-agent-tools',
        agentId: caller.id,
        principalId: 'user-1',
        prompt: 'delegate',
        permissions: ['agents.execute'],
      }),
    ).resolves.toMatchObject({ content: 'caller result' });
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ model: 'tool-model' }));
  });

  it('resolves published guardrails for input and output and fails closed for unknown IDs', async () => {
    const engine = new CapabilityExecutionEngine(new InMemoryCapabilityRegistry(), {
      authorize: () => Promise.resolve(),
    });
    const chat = vi.fn().mockResolvedValue({
      content: 'safe result',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const runtime = new AgentRuntimeService(undefined, { engine } as never, undefined, {
      execution: { chat },
    } as never);
    const guardedAgent = await runtime.create({
      organizationId: 'org-guardrails',
      slug: 'guarded-agent',
      name: 'Guarded',
    });
    const guardedVersion = await runtime.createVersion({
      organizationId: 'org-guardrails',
      agentId: guardedAgent.id,
      model: 'guarded-model',
      systemPrompt: 'system',
      configuration: { guardrails: ['secret-detection'] },
    });
    await runtime.publish('org-guardrails', guardedAgent.id, guardedVersion.id);
    await expect(
      runtime.runPublished({
        organizationId: 'org-guardrails',
        agentId: guardedAgent.id,
        principalId: 'user',
        prompt: 'api_key=1234567890',
      }),
    ).rejects.toThrow(/secret-like value/);
    expect(chat).not.toHaveBeenCalled();

    chat.mockResolvedValueOnce({
      content: 'api_key=1234567890',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await expect(
      runtime.runPublished({
        organizationId: 'org-guardrails',
        agentId: guardedAgent.id,
        principalId: 'user',
        prompt: 'safe input',
      }),
    ).rejects.toThrow(/secret-like value/);

    const invalidAgent = await runtime.create({
      organizationId: 'org-guardrails',
      slug: 'invalid-guardrail-agent',
      name: 'Invalid guardrail',
    });
    const invalidVersion = await runtime.createVersion({
      organizationId: 'org-guardrails',
      agentId: invalidAgent.id,
      model: 'guarded-model',
      systemPrompt: 'system',
      configuration: { guardrails: ['not-registered'] },
    });
    await runtime.publish('org-guardrails', invalidAgent.id, invalidVersion.id);
    await expect(
      runtime.runPublished({
        organizationId: 'org-guardrails',
        agentId: invalidAgent.id,
        principalId: 'user',
        prompt: 'safe input',
      }),
    ).rejects.toThrow(/Unknown agent guardrail/);
  });

  it('resolves configured MCP tools from the named server and enforces their permissions', async () => {
    const engine = new CapabilityExecutionEngine(new InMemoryCapabilityRegistry(), {
      authorize: () => Promise.resolve(),
    });
    let calls = 0;
    const chat = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1)
        return Promise.resolve({
          content: '',
          finishReason: 'tool_call',
          toolCalls: [{ name: 'lookup', arguments: { query: 'status' } }],
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      if (calls === 2)
        return Promise.resolve({
          content: '',
          finishReason: 'tool_call',
          toolCalls: [{ name: 'lookup', arguments: { query: 'status' } }],
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      return Promise.resolve({
        content: 'healthy',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    });
    const mcp = {
      listTools: vi
        .fn()
        .mockResolvedValue([{ name: 'lookup', requiredPermissions: ['status.read'] }]),
      execute: vi.fn().mockResolvedValue({ content: 'tool result' }),
    };
    const runtime = new AgentRuntimeService(
      undefined,
      { engine } as never,
      undefined,
      { execution: { chat } } as never,
      undefined,
      mcp as never,
    );
    const agent = await runtime.create({
      organizationId: 'org-agent-mcp',
      slug: 'mcp-agent',
      name: 'MCP Agent',
    });
    const version = await runtime.createVersion({
      organizationId: 'org-agent-mcp',
      agentId: agent.id,
      model: 'mcp-model',
      systemPrompt: 'system',
      tools: ['lookup'],
      configuration: { mcpServers: ['status-server'] },
    });
    await runtime.publish('org-agent-mcp', agent.id, version.id);

    await expect(
      runtime.runPublished({
        organizationId: 'org-agent-mcp',
        agentId: agent.id,
        principalId: 'user',
        prompt: 'check status',
        permissions: [],
      }),
    ).rejects.toThrow(/permission is not granted/);
    expect(mcp.execute).not.toHaveBeenCalled();

    await expect(
      runtime.runPublished({
        organizationId: 'org-agent-mcp',
        agentId: agent.id,
        principalId: 'user',
        prompt: 'check status',
        permissions: ['status.read'],
      }),
    ).resolves.toMatchObject({ content: 'healthy' });
    expect(mcp.listTools).toHaveBeenCalledWith('org-agent-mcp', 'status-server');
    expect(mcp.execute).toHaveBeenCalledWith(
      'org-agent-mcp',
      'status-server',
      'lookup',
      { query: 'status' },
      expect.objectContaining({ permissions: ['status.read'] }),
    );
  });

  it('persists agent runs, steps and tool executions for durable API runs', async () => {
    const config = defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } });
    const adapter = createDatabaseAdapter(config);
    await adapter.initialize();
    try {
      const engine = new CapabilityExecutionEngine(new InMemoryCapabilityRegistry(), {
        authorize: () => Promise.resolve(),
      });
      const models = {
        execution: {
          chat: () =>
            Promise.resolve({
              content: 'done',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1 },
            }),
        },
      };
      const runtime = new AgentRuntimeService(
        { adapter, config } as never,
        { engine } as never,
        undefined,
        models as never,
      );
      const agent = await runtime.create({
        organizationId: 'org-runs',
        slug: 'durable-agent',
        name: 'Durable',
      });
      const version = await runtime.createVersion({
        organizationId: 'org-runs',
        agentId: agent.id,
        model: 'model',
        systemPrompt: 'system',
      });
      await runtime.publish('org-runs', agent.id, version.id);
      await runtime.runPublished({
        organizationId: 'org-runs',
        agentId: agent.id,
        principalId: 'user',
        prompt: 'hello',
      });
      expect(await runtime.listRuns('org-runs', agent.id)).toHaveLength(1);
    } finally {
      await adapter.close();
    }
  });
});
