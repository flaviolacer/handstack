export type ExecutionSource = 'WEB' | 'API' | 'MCP' | 'AGENT' | 'SYSTEM';

export interface PrincipalRef {
  readonly id: string;
  readonly type: 'USER' | 'SERVICE_ACCOUNT' | 'APPLICATION' | 'AGENT' | 'API_KEY';
}

export interface OrganizationRef {
  readonly id: string;
}

export interface ExecutionContext {
  readonly requestId: string;
  readonly traceId: string;
  readonly principal: PrincipalRef;
  readonly organization: OrganizationRef;
  readonly permissions: ReadonlySet<string>;
  readonly source: ExecutionSource;
  readonly conversationId?: string;
  readonly agentRunId?: string;
}
