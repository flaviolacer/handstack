import { PrometheusRegistry } from '@handstack/telemetry';

export const API_METRIC_NAMES = [
  'handstack_requests_total',
  'handstack_llm_requests_total',
  'handstack_tokens_input_total',
  'handstack_tokens_output_total',
  'handstack_cost_total',
  'handstack_agent_runs_total',
  'handstack_tool_calls_total',
  'handstack_mcp_calls_total',
  'handstack_policy_denied_total',
  'handstack_plugin_errors_total',
  'handstack_http_requests_per_second',
  'handstack_http_request_p95_latency_seconds',
  'handstack_active_streams',
  'handstack_event_loop_lag_seconds',
  'handstack_memory_pressure_ratio',
  'handstack_in_flight_capability_executions',
  'handstack_queue_depth',
  'handstack_queue_oldest_age_seconds',
  'handstack_worker_concurrency',
  'handstack_worker_execution_duration_seconds',
  'handstack_redis_latency_seconds',
  'handstack_redis_stream_lag',
  'handstack_database_connections',
  'handstack_database_replication_lag_seconds',
  'handstack_provider_quota_ratio',
  'handstack_provider_rate_limited_total',
  'handstack_budget_reservation_latency_seconds',
  'handstack_budget_reservation_conflicts_total',
  'handstack_storage_latency_seconds',
  'handstack_storage_errors_total',
] as const;

export type ApiMetricName = (typeof API_METRIC_NAMES)[number];

const GAUGE_METRICS = new Set<ApiMetricName>([
  'handstack_http_requests_per_second',
  'handstack_http_request_p95_latency_seconds',
  'handstack_active_streams',
  'handstack_event_loop_lag_seconds',
  'handstack_memory_pressure_ratio',
  'handstack_in_flight_capability_executions',
  'handstack_queue_depth',
  'handstack_queue_oldest_age_seconds',
  'handstack_worker_concurrency',
  'handstack_worker_execution_duration_seconds',
  'handstack_redis_latency_seconds',
  'handstack_redis_stream_lag',
  'handstack_database_connections',
  'handstack_database_replication_lag_seconds',
  'handstack_provider_quota_ratio',
  'handstack_budget_reservation_latency_seconds',
  'handstack_storage_latency_seconds',
]);

const HELP: Record<(typeof API_METRIC_NAMES)[number], string> = {
  handstack_requests_total: 'HTTP requests handled by the HandStack API',
  handstack_llm_requests_total: 'LLM requests handled by HandStack',
  handstack_tokens_input_total: 'Input tokens processed by HandStack',
  handstack_tokens_output_total: 'Output tokens processed by HandStack',
  handstack_cost_total: 'Provider cost accounted by HandStack',
  handstack_agent_runs_total: 'Agent runs executed by HandStack',
  handstack_tool_calls_total: 'Tool calls executed by HandStack',
  handstack_mcp_calls_total: 'MCP calls executed by HandStack',
  handstack_policy_denied_total: 'Executions denied by HandStack policy',
  handstack_plugin_errors_total: 'Plugin errors observed by HandStack',
  handstack_http_requests_per_second: 'HTTP request rate observed by HandStack',
  handstack_http_request_p95_latency_seconds: 'P95 control-plane HTTP latency in seconds',
  handstack_active_streams: 'Active SSE, WebSocket and MCP streams',
  handstack_event_loop_lag_seconds: 'Node.js event-loop lag in seconds',
  handstack_memory_pressure_ratio: 'Process memory pressure ratio from zero to one',
  handstack_in_flight_capability_executions: 'Capability executions currently in flight',
  handstack_queue_depth: 'Ready jobs in the observed queue',
  handstack_queue_oldest_age_seconds: 'Age of the oldest ready job in seconds',
  handstack_worker_concurrency: 'Worker executions currently in progress',
  handstack_worker_execution_duration_seconds: 'Worker execution duration in seconds',
  handstack_redis_latency_seconds: 'Redis command latency in seconds',
  handstack_redis_stream_lag: 'Redis Stream consumer lag',
  handstack_database_connections: 'Database connections currently in use',
  handstack_database_replication_lag_seconds: 'Database replication lag in seconds',
  handstack_provider_quota_ratio: 'Provider concurrency quota utilization ratio',
  handstack_provider_rate_limited_total: 'Provider rate-limit responses observed',
  handstack_budget_reservation_latency_seconds: 'Budget reservation latency in seconds',
  handstack_budget_reservation_conflicts_total: 'Budget reservation conflicts observed',
  handstack_storage_latency_seconds: 'Object storage operation latency in seconds',
  handstack_storage_errors_total: 'Object storage errors observed',
};

export class ApiMetrics {
  private readonly registry = new PrometheusRegistry();

  constructor() {
    for (const name of API_METRIC_NAMES) {
      this.registry.set({
        name,
        help: HELP[name],
        type: GAUGE_METRICS.has(name) ? 'gauge' : 'counter',
        value: 0,
      });
    }
  }

  request(method: string, statusCode: number): void {
    this.registry.increment(
      {
        name: 'handstack_requests_total',
        help: HELP.handstack_requests_total,
        type: 'counter',
        labels: { method, status: String(statusCode) },
      },
      1,
    );
  }

  /** Record a canonical operational counter without tenant, user, model, or payload labels. */
  increment(name: ApiMetricName, amount = 1, labels?: Readonly<Record<string, string>>): void {
    this.registry.increment(
      { name, help: HELP[name], type: 'counter', ...(labels === undefined ? {} : { labels }) },
      amount,
    );
  }

  /** Set a bounded operational gauge without accepting payload or identity labels. */
  setGauge(name: ApiMetricName, value: number, labels?: Readonly<Record<string, string>>): void {
    if (!GAUGE_METRICS.has(name)) throw new Error(`Metric is not a gauge: ${name}`);
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`Gauge value must be non-negative: ${name}`);
    this.registry.set({
      name,
      help: HELP[name],
      type: 'gauge',
      value,
      ...(labels === undefined ? {} : { labels }),
    });
  }

  llmRequest(): void {
    this.increment('handstack_llm_requests_total');
  }

  tokens(input: { readonly input: number; readonly output: number }): void {
    if (Number.isFinite(input.input) && input.input >= 0)
      this.increment('handstack_tokens_input_total', input.input);
    if (Number.isFinite(input.output) && input.output >= 0)
      this.increment('handstack_tokens_output_total', input.output);
  }

  cost(amount: number): void {
    if (Number.isFinite(amount) && amount >= 0) this.increment('handstack_cost_total', amount);
  }

  agentRun(): void {
    this.increment('handstack_agent_runs_total');
  }

  toolCall(): void {
    this.increment('handstack_tool_calls_total');
  }

  mcpCall(): void {
    this.increment('handstack_mcp_calls_total');
  }

  policyDenied(): void {
    this.increment('handstack_policy_denied_total');
  }

  pluginError(): void {
    this.increment('handstack_plugin_errors_total');
  }

  render(): string {
    return this.registry.render();
  }
}
