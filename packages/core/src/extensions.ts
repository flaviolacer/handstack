export type ExtensionType =
  | 'policy'
  | 'guardrail'
  | 'evaluation'
  | 'privacy-policy'
  | 'data-subject-request'
  | 'data-lifecycle'
  | 'data-residency'
  | 'compliance-control'
  | 'sandbox'
  | 'audit-sink'
  | 'siem-exporter'
  | 'knowledge-connector'
  | 'rag-policy'
  | 'vector-store'
  | 'workflow-node'
  | 'compensation'
  | 'webhook-transport'
  | 'incident-management'
  | 'status-page'
  | 'notification';

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ExtensionHealthContext {
  readonly organizationId?: string;
  readonly signal: AbortSignal;
}

export interface ExtensionHealth {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly message?: string;
}

export interface ExtensionProvider {
  readonly id: string;
  readonly type: ExtensionType;
  readonly apiVersion: string;
  readonly capabilities: readonly string[];
  readonly configurationSchema: JsonSchema;
  readonly requiredPermissions: readonly string[];
  health(context: ExtensionHealthContext): Promise<ExtensionHealth>;
}

export interface ExtensionRegistration {
  readonly provider: ExtensionProvider;
  readonly organizationId?: string;
  readonly priority: number;
  readonly mandatory: boolean;
  readonly enabled: boolean;
}

export class ExtensionRegistry {
  private readonly registrations = new Map<string, ExtensionRegistration>();

  register(registration: ExtensionRegistration): void {
    const key = this.key(registration.provider.id, registration.organizationId);
    if (this.registrations.has(key)) {
      throw new Error(`Extension provider already registered: ${registration.provider.id}`);
    }
    this.registrations.set(key, registration);
  }

  resolve(type: ExtensionType, organizationId?: string): readonly ExtensionRegistration[] {
    return [...this.registrations.values()]
      .filter(
        (registration) =>
          registration.enabled &&
          registration.provider.type === type &&
          (registration.organizationId === undefined ||
            registration.organizationId === organizationId),
      )
      .sort((left, right) => {
        const scopeOrder =
          Number(right.organizationId !== undefined) - Number(left.organizationId !== undefined);
        return scopeOrder === 0 ? right.priority - left.priority : scopeOrder;
      });
  }

  private key(providerId: string, organizationId?: string): string {
    return `${organizationId ?? 'global'}:${providerId}`;
  }
}
