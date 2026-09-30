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
  it('applies input and output guardrail stages around the model', async () => {
    const stages: string[] = [];
    const pipeline = new GuardrailPipeline([
      (value, stage) => {
        stages.push(stage);
        return Promise.resolve(typeof value === 'string' ? value.trim() : value);
      },
    ]);
    const model: AgentModel = {
      complete: ({ messages }) =>
        Promise.resolve({ kind: 'final', content: `${messages[1]?.content ?? ''} done` }),
    };
    await expect(
      new AgentHarness(
        model,
        new CapabilityExecutionEngine(new InMemoryCapabilityRegistry(), {
          authorize: () => Promise.resolve(),
        }),
      ).run({
        organizationId: 'org',
        principalId: 'user',
        prompt: ' hello ',
        agentVersion: { ...version, tools: [] },
        guardrails: pipeline,
      }),
    ).resolves.toMatchObject({ content: 'hello done' });
    expect(stages).toEqual(['INPUT', 'OUTPUT']);
  });

  it('routes declared MCP tools through the injected MCP executor', async () => {
    let receivedPrincipal = '';
    const model: AgentModel = {
      complete: ({ messages }) =>
        Promise.resolve(
          messages.length === 2
            ? { kind: 'tool_call', call: { name: 'echo', arguments: { value: 'x' } } }
            : { kind: 'final', content: 'done' },
        ),
    };
    const mcpExecutor = {
      execute: (_name: string, _argumentsValue: unknown, context: { principalId: string }) => {
        receivedPrincipal = context.principalId;
        return Promise.resolve({ ok: true });
      },
    };
    await expect(
      new AgentHarness(
        model,
        new CapabilityExecutionEngine(new InMemoryCapabilityRegistry(), {
          authorize: () => Promise.resolve(),
        }),
      ).run({
        organizationId: 'org',
        principalId: 'user',
        prompt: 'hello',
        agentVersion: { ...version, configuration: { mcpServers: ['server'] } },
        mcpExecutor,
      }),
    ).resolves.toMatchObject({ content: 'done' });
    expect(receivedPrincipal).toBe('user');
  });

  it('loads and persists user memory when memory is enabled', async () => {
    const stored: {
      organizationId: string;
      scope: 'USER';
      ownerId: string;
      content: string;
      id: string;
      createdAt: Date;
    }[] = [
      {
        id: 'old',
        organizationId: 'org',
        scope: 'USER',
        ownerId: 'user',
        content: 'Known preference',
        createdAt: new Date(),
      },
    ];
    const memoryStore = {
      list: (organizationId: string, scope: string, ownerId: string) =>
        Promise.resolve(
          stored.filter(
            (entry) =>
              entry.organizationId === organizationId &&
              entry.scope === scope &&
              entry.ownerId === ownerId,
          ),
        ),
      put: (entry: (typeof stored)[number]) => {
        stored.push(entry);
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
    };
    const model: AgentModel = {
      complete: ({ messages }) =>
        Promise.resolve({
          kind: 'final',
          content: messages[0]?.content.includes('Known preference') ? 'remembered' : 'missing',
        }),
    };
    await expect(
      new AgentHarness(
        model,
        new CapabilityExecutionEngine(new InMemoryCapabilityRegistry(), {
          authorize: () => Promise.resolve(),
        }),
      ).run({
        organizationId: 'org',
        principalId: 'user',
        prompt: 'hello',
        agentVersion: { ...version, tools: [], configuration: { memoryEnabled: true } },
        memoryStore,
      }),
    ).resolves.toMatchObject({ content: 'remembered' });
    expect(stored).toHaveLength(2);
    expect(stored[1]?.content).toContain('remembered');
  });

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

  it('restricts execution permissions to the published version configuration', async () => {
    const registry = new InMemoryCapabilityRegistry();
    let received: readonly string[] | undefined;
    await registry.register({
      organizationId: 'org',
      slug: 'echo',
      name: 'Echo',
      description: 'Echo',
      type: 'CUSTOM',
      inputSchema: {},
      outputSchema: {},
      requiredPermissions: ['safe.read'],
      allowedChannels: ['AGENT'],
      timeoutMs: 1000,
      visibility: 'ORGANIZATION',
      ownerId: 'owner',
      metadata: {},
      handler: (_input, context) => {
        received = context.permissions;
        return Promise.resolve({ ok: true });
      },
    });
    const model: AgentModel = {
      complete: ({ messages }) =>
        Promise.resolve(
          messages.length === 2
            ? { kind: 'tool_call', call: { name: 'echo', arguments: {} } }
            : { kind: 'final', content: 'done' },
        ),
    };
    await new AgentHarness(
      model,
      new CapabilityExecutionEngine(registry, { authorize: () => Promise.resolve() }),
    ).run({
      organizationId: 'org',
      principalId: 'user',
      prompt: 'hello',
      agentVersion: { ...version, configuration: { permissions: ['safe.read'] } },
      permissions: ['safe.read', 'admin.write'],
    });
    expect(received).toEqual(['safe.read']);
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

  it('rejects execution on a channel that the published version did not authorize', async () => {
    const model: AgentModel = {
      complete: () => Promise.resolve({ kind: 'final', content: 'done' }),
    };
    const restrictedVersion = {
      ...version,
      configuration: { publishChannels: ['WEB' as const] },
    };
    await expect(
      new AgentHarness(
        model,
        new CapabilityExecutionEngine(new InMemoryCapabilityRegistry(), {
          authorize: () => Promise.resolve(),
        }),
      ).run({
        organizationId: 'org',
        principalId: 'user',
        prompt: 'hello',
        channel: 'REST_API',
        agentVersion: restrictedVersion,
      }),
    ).rejects.toThrow('not published to this channel');
  });
});
