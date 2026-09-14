import { describe, expect, it } from 'vitest';
import { AgentRuntimeService } from '../src/agents/agent-runtime.service.js';
import { ApiMetrics } from '../src/observability/api-metrics.js';
import { CapabilityExecutionEngine, InMemoryCapabilityRegistry } from '@handstack/capabilities';
import type { AgentModel } from '@handstack/agents';

describe('AgentRuntimeService', () => {
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
});
