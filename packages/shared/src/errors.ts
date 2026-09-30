export type HandStackErrorCode =
  | 'authentication_required'
  | 'authorization_denied'
  | 'validation_failed'
  | 'budget_exceeded'
  | 'rate_limit_exceeded'
  | 'capability_not_found'
  | 'provider_error'
  | 'mcp_error'
  | 'plugin_error'
  | 'agent_execution_error'
  | 'scim_not_found'
  | 'scim_conflict';

export abstract class HandStackError extends Error {
  abstract readonly code: HandStackErrorCode;
  abstract readonly status: number;
  readonly helpArticleId: string | undefined;

  constructor(message: string, options?: { cause?: unknown; helpArticleId?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.helpArticleId = options?.helpArticleId;
  }
}

export class AuthenticationError extends HandStackError {
  readonly code = 'authentication_required';
  readonly status = 401;
}

export class AuthorizationError extends HandStackError {
  readonly code = 'authorization_denied';
  readonly status = 403;
}

export class ValidationError extends HandStackError {
  readonly code = 'validation_failed';
  readonly status = 400;
}

export class BudgetExceededError extends HandStackError {
  readonly code = 'budget_exceeded';
  readonly status = 402;
}

export class RateLimitError extends HandStackError {
  readonly code = 'rate_limit_exceeded';
  readonly status = 429;

  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    if (
      retryAfterSeconds !== undefined &&
      (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 0)
    )
      throw new RangeError('retryAfterSeconds must be a non-negative integer');
  }
}

export class CapabilityNotFoundError extends HandStackError {
  readonly code = 'capability_not_found';
  readonly status = 404;
}

export class ProviderError extends HandStackError {
  readonly code = 'provider_error';
  readonly status = 502;
}

export class McpError extends HandStackError {
  readonly code = 'mcp_error';
  readonly status = 502;
}

export class PluginError extends HandStackError {
  readonly code = 'plugin_error';
  readonly status = 500;
}

export class AgentExecutionError extends HandStackError {
  readonly code = 'agent_execution_error';
  readonly status = 500;
}
