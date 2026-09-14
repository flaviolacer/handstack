import { InMemoryCapabilityRegistry, CapabilityExecutionEngine } from '@handstack/capabilities';
import { describe, expect, it } from 'vitest';
import {
  AgentHarness,
  AgentOrchestrator,
  GuardrailPipeline,
  InMemoryMemoryStore,
  type AgentModel,
  type AgentVersion,
} from '../src/index.js';

const version: AgentVersion = {
  id: 'version',
  agentId: 'agent',
  organizationId: 'org',
  version: 1,
  status: 'PUBLISHED',
  model: 'test',
  systemPrompt: 'You are helpful',
  tools: ['echo'],
  maxIterations: 3,
  timeoutMs: 1000,
  createdAt: new Date(),
};

describe('AgentHarness', () => {
  it('calls a capability tool and then returns the model response', async () => {
    const registry = new InMemoryCapabilityRegistry();
    await registry.register({
      organizationId: 'org',
      slug: 'echo',
      name: 'Echo',
      description: 'Echo',
      type: 'CUSTOM',
      inputSchema: {},
      outputSchema: {},
      requiredPermissions: [],
      allowedChannels: ['AGENT'],
      timeoutMs: 1000,
      visibility: 'ORGANIZATION',
      ownerId: 'owner',
      metadata: {},
      handler: (input) => Promise.resolve(input),
    });
    const engine = new CapabilityExecutionEngine(registry, { authorize: () => Promise.resolve() });
    let calls = 0;
    const model: AgentModel = {
      complete: ({ messages }) => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? { kind: 'tool_call', call: { name: 'echo', arguments: { ok: true } } }
            : { kind: 'final', content: messages.at(-1)?.content ?? '' },
        );
      },
    };
    const events: string[] = [];
    const observations: string[] = [];
    const result = await new AgentHarness(model, engine).run({
      organizationId: 'org',
      principalId: 'user',
      agentVersion: version,
      prompt: 'hello',
      onEvent: (event) => {
        events.push(event.type);
      },
      observe: (observation) => {
        observations.push(observation.type);
      },
    });
    expect(result.content).toContain('ok');
    expect(events).toEqual([
      'agent.started',
      'agent.step.started',
      'agent.tool.called',
      'agent.step.started',
      'agent.completed',
    ]);
    expect(observations).toEqual(['agent.started', 'agent.tool.called', 'agent.completed']);
  });

  it('stops when a tool is not declared', async () => {
    const registry = new InMemoryCapabilityRegistry();
    const engine = new CapabilityExecutionEngine(registry, { authorize: () => Promise.resolve() });
    const model: AgentModel = {
      complete: () =>
        Promise.resolve({ kind: 'tool_call', call: { name: 'forbidden', arguments: {} } }),
    };
    const observations: string[] = [];
    await expect(
      new AgentHarness(model, engine).run({
        organizationId: 'org',
        principalId: 'user',
        agentVersion: version,
        prompt: 'hello',
        observe: (observation) => {
          observations.push(observation.type);
        },
      }),
    ).rejects.toThrow(/undeclared/);
    expect(observations).toEqual(['agent.started', 'agent.failed']);
  });
});

describe('Agent orchestration and governance contracts', () => {
  it('runs sequential and bounded parallel delegation', async () => {
    const calls: string[] = [];
    const runner = {
      run: (task: { agentId: string; prompt: string }) => {
        calls.push(task.agentId);
        return Promise.resolve({
          agentId: task.agentId,
          content: task.prompt,
          runId: task.agentId,
        });
      },
    };
    const orchestrator = new AgentOrchestrator(runner, 2);
    await expect(
      orchestrator.execute({
        mode: 'SEQUENTIAL',
        tasks: [
          { agentId: 'a', prompt: '1' },
          { agentId: 'b', prompt: '2' },
        ],
      }),
    ).resolves.toHaveLength(2);
    await expect(
      orchestrator.execute({
        mode: 'PARALLEL',
        tasks: [
          { agentId: 'c', prompt: '3' },
          { agentId: 'd', prompt: '4' },
          { agentId: 'e', prompt: '5' },
        ],
      }),
    ).resolves.toHaveLength(3);
    expect(calls).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('isolates memory by organization and applies guardrail stages', async () => {
    const memory = new InMemoryMemoryStore();
    await memory.put({
      id: 'm',
      organizationId: 'org',
      scope: 'USER',
      ownerId: 'u',
      content: 'safe',
      createdAt: new Date(),
    });
    await expect(memory.list('other', 'USER', 'u')).resolves.toHaveLength(0);
    const stages: string[] = [];
    const pipeline = new GuardrailPipeline([
      (value, stage) => {
        stages.push(stage);
        return Promise.resolve(value);
      },
    ]);
    await pipeline.input('x');
    await pipeline.tool('x');
    await pipeline.output('x');
    expect(stages).toEqual(['INPUT', 'TOOL', 'OUTPUT']);
  });
});
