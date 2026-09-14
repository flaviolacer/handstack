import { describe, expect, it } from 'vitest';
import {
  createAgentMetricsObserver,
  createCapabilityMetricsObserver,
  createJobMetricsObserver,
  createMcpMetricsObserver,
} from '../src/index.js';

describe('observation bridges', () => {
  it('maps MCP tool calls and failures to canonical counters', () => {
    const counts = new Map<string, number>();
    const observe = createMcpMetricsObserver({
      increment: (name) => counts.set(name, (counts.get(name) ?? 0) + 1),
    });

    observe({ operation: 'discover', method: 'tools/list', outcome: 'success', durationMs: 1 });
    observe({ operation: 'call', method: 'tools/call', outcome: 'success', durationMs: 2 });
    observe({ operation: 'call', method: 'tools/call', outcome: 'error', durationMs: 3 });

    expect(Object.fromEntries(counts)).toEqual({
      handstack_mcp_calls_total: 2,
      handstack_plugin_errors_total: 1,
    });
  });

  it('maps queue transport failures and dead letters without reading payloads', () => {
    const counts = new Map<string, number>();
    const observe = createJobMetricsObserver({
      increment: (name) => counts.set(name, (counts.get(name) ?? 0) + 1),
    });

    observe({ operation: 'enqueue', outcome: 'success', durationMs: 1 });
    observe({ operation: 'dequeue', outcome: 'error', durationMs: 2 });
    observe({ operation: 'dead-letter', outcome: 'success', durationMs: 3 });

    expect(Object.fromEntries(counts)).toEqual({ handstack_plugin_errors_total: 2 });
  });

  it('maps capability execution outcomes to canonical counters', () => {
    const counts = new Map<string, number>();
    const observe = createCapabilityMetricsObserver({
      increment: (name) => counts.set(name, (counts.get(name) ?? 0) + 1),
    });

    observe({ operation: 'execute', outcome: 'success', durationMs: 1 });
    observe({ operation: 'policy-denied', outcome: 'error', durationMs: 2 });
    observe({ operation: 'execute', outcome: 'error', durationMs: 3 });

    expect(Object.fromEntries(counts)).toEqual({
      handstack_tool_calls_total: 2,
      handstack_policy_denied_total: 1,
      handstack_plugin_errors_total: 1,
    });
  });

  it('maps agent lifecycle events without consuming event payloads', () => {
    const counts = new Map<string, number>();
    const observe = createAgentMetricsObserver({
      increment: (name) => counts.set(name, (counts.get(name) ?? 0) + 1),
    });

    observe({ type: 'agent.started' });
    observe({ type: 'agent.tool.called' });
    observe({ type: 'agent.completed' });
    observe({ type: 'agent.failed' });

    expect(Object.fromEntries(counts)).toEqual({
      handstack_agent_runs_total: 1,
      handstack_tool_calls_total: 1,
      handstack_plugin_errors_total: 1,
    });
  });
});
