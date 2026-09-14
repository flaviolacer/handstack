export type CanonicalMetricName = 'handstack_mcp_calls_total' | 'handstack_plugin_errors_total';

export type RuntimeMetricName =
  | CanonicalMetricName
  | 'handstack_agent_runs_total'
  | 'handstack_tool_calls_total'
  | 'handstack_policy_denied_total';

export interface CanonicalMetricRecorder {
  increment(name: RuntimeMetricName, amount?: number): void;
}

export interface CapabilityOperationalObservation {
  readonly operation: 'execute' | 'authorize' | 'policy-denied';
  readonly outcome: 'success' | 'error';
  readonly durationMs: number;
}

export interface AgentOperationalObservation {
  readonly type: 'agent.started' | 'agent.tool.called' | 'agent.completed' | 'agent.failed';
}

export interface McpOperationalObservation {
  readonly operation?: 'discover' | 'call';
  readonly method: string;
  readonly outcome: 'success' | 'error';
  readonly durationMs: number;
}

export interface JobOperationalObservation {
  readonly operation: 'enqueue' | 'dequeue' | 'completed' | 'retry' | 'requeue' | 'dead-letter';
  readonly outcome: 'success' | 'error';
  readonly durationMs: number;
}

export function createCapabilityMetricsObserver(
  recorder: CanonicalMetricRecorder,
): (observation: CapabilityOperationalObservation) => void {
  return (observation) => {
    if (observation.operation === 'execute') recorder.increment('handstack_tool_calls_total');
    if (observation.operation === 'policy-denied')
      recorder.increment('handstack_policy_denied_total');
    if (observation.outcome === 'error' && observation.operation === 'execute')
      recorder.increment('handstack_plugin_errors_total');
  };
}

export function createAgentMetricsObserver(
  recorder: CanonicalMetricRecorder,
): (observation: AgentOperationalObservation) => void {
  return (observation) => {
    if (observation.type === 'agent.started') recorder.increment('handstack_agent_runs_total');
    if (observation.type === 'agent.tool.called') recorder.increment('handstack_tool_calls_total');
    if (observation.type === 'agent.failed') recorder.increment('handstack_plugin_errors_total');
  };
}

/**
 * Adapts MCP runtime hooks to canonical counters without coupling telemetry to an MCP transport.
 * Only operation metadata is consumed; observations never contain request or credential data.
 */
export function createMcpMetricsObserver(
  recorder: CanonicalMetricRecorder,
): (observation: McpOperationalObservation) => void {
  return (observation) => {
    const isToolCall =
      observation.method === 'tools/call' &&
      (observation.operation === undefined || observation.operation === 'call');
    if (isToolCall) recorder.increment('handstack_mcp_calls_total');
    if (isToolCall && observation.outcome === 'error')
      recorder.increment('handstack_plugin_errors_total');
  };
}

/**
 * Adapts queue hooks for operational failures that represent a plugin execution failure.
 * Normal enqueue, retry and completion events intentionally do not inflate API counters.
 */
export function createJobMetricsObserver(
  recorder: CanonicalMetricRecorder,
): (observation: JobOperationalObservation) => void {
  return (observation) => {
    if (observation.outcome === 'error' || observation.operation === 'dead-letter')
      recorder.increment('handstack_plugin_errors_total');
  };
}
