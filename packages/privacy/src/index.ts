import { ValidationError } from '@handstack/shared';

export type DataClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
export type DataSubjectRequestType =
  'ACCESS' | 'EXPORT' | 'CORRECTION' | 'DELETION' | 'RESTRICTION' | 'OBJECTION';
export type DataSubjectRequestStatus =
  | 'RECEIVED'
  | 'IDENTITY_VERIFICATION'
  | 'APPROVED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'PARTIALLY_COMPLETED'
  | 'DENIED_WITH_REASON';

export interface PrivacySettings {
  readonly storePrompts: boolean;
  readonly storeResponses: boolean;
  readonly storeToolPayloads: boolean;
  readonly redactPii: boolean;
  readonly sendTelemetry: boolean;
}

export interface PrivacyDecisionInput {
  readonly organizationId: string;
  readonly classification: DataClassification;
  readonly providerId: string;
  readonly externalProvider: boolean;
}
export interface PrivacyDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}
export interface PrivacyPolicyProvider {
  evaluate(input: PrivacyDecisionInput): Promise<PrivacyDecision>;
}

export interface RetentionPolicy {
  readonly organizationId: string;
  readonly resourceType: string;
  readonly retentionDays: number;
}
export interface DataResource {
  readonly organizationId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly createdAt: Date;
}
export interface LegalHold {
  readonly id: string;
  readonly organizationId: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly reason: string;
  readonly active: boolean;
}
export interface LifecyclePlan {
  readonly id: string;
  readonly resource: DataResource;
  readonly action: 'DELETE' | 'RETAIN';
  readonly executeAfter: Date;
}
export interface LifecycleResult {
  readonly planId: string;
  readonly deleted: boolean;
  readonly reason?: string;
}
export interface DataLifecycleProvider {
  plan(resource: DataResource, policy: RetentionPolicy): Promise<LifecyclePlan>;
  execute(plan: LifecyclePlan): Promise<LifecycleResult>;
}

export class InMemoryDataLifecycleProvider implements DataLifecycleProvider {
  private readonly holds = new Map<string, LegalHold>();
  addLegalHold(hold: LegalHold): void {
    if (hold.organizationId === '' || hold.reason.trim() === '')
      throw new ValidationError('Legal hold is invalid');
    this.holds.set(hold.id, hold);
  }
  removeLegalHold(id: string): void {
    const hold = this.holds.get(id);
    if (hold !== undefined) this.holds.set(id, { ...hold, active: false });
  }
  plan(resource: DataResource, policy: RetentionPolicy): Promise<LifecyclePlan> {
    if (resource.organizationId === '' || policy.organizationId !== resource.organizationId)
      throw new ValidationError('Retention policy organization mismatch');
    if (!Number.isInteger(policy.retentionDays) || policy.retentionDays < 0)
      throw new ValidationError('Retention days must be a non-negative integer');
    return Promise.resolve({
      id: `${resource.organizationId}:${resource.resourceType}:${resource.resourceId}`,
      resource,
      action: policy.resourceType === resource.resourceType ? 'DELETE' : 'RETAIN',
      executeAfter: new Date(resource.createdAt.getTime() + policy.retentionDays * 86_400_000),
    });
  }
  execute(plan: LifecyclePlan): Promise<LifecycleResult> {
    const hold = [...this.holds.values()].find(
      (item) =>
        item.active &&
        item.organizationId === plan.resource.organizationId &&
        (item.resourceType === undefined || item.resourceType === plan.resource.resourceType) &&
        (item.resourceId === undefined || item.resourceId === plan.resource.resourceId),
    );
    if (hold !== undefined)
      return Promise.resolve({
        planId: plan.id,
        deleted: false,
        reason: `Legal hold: ${hold.reason}`,
      });
    if (plan.action !== 'DELETE' || plan.executeAfter.getTime() > Date.now())
      return Promise.resolve({
        planId: plan.id,
        deleted: false,
        reason: 'Retention period has not elapsed',
      });
    return Promise.resolve({ planId: plan.id, deleted: true });
  }
}

export interface DataSubjectRequest {
  readonly id: string;
  readonly organizationId: string;
  readonly subjectId: string;
  readonly type: DataSubjectRequestType;
  readonly status: DataSubjectRequestStatus;
}
export interface DataSubjectRequestResult {
  readonly requestId: string;
  readonly status: Extract<DataSubjectRequestStatus, 'COMPLETED' | 'PARTIALLY_COMPLETED'>;
  readonly evidence: readonly string[];
}
export interface DataSubjectRequestProvider {
  validate(request: DataSubjectRequest): Promise<void>;
  execute(request: DataSubjectRequest): Promise<DataSubjectRequestResult>;
}

export class InMemoryDataSubjectRequestProvider implements DataSubjectRequestProvider {
  validate(request: DataSubjectRequest): Promise<void> {
    if (request.organizationId === '' || request.subjectId === '' || request.id === '')
      throw new ValidationError('Data subject request identity is required');
    if (request.status !== 'APPROVED')
      throw new ValidationError('Data subject request is not approved');
    return Promise.resolve();
  }
  async execute(request: DataSubjectRequest): Promise<DataSubjectRequestResult> {
    await this.validate(request);
    return {
      requestId: request.id,
      status: 'COMPLETED',
      evidence: [`${request.type}:${request.subjectId}`],
    };
  }
}

export interface DataPlacementRequest {
  readonly organizationId: string;
  readonly region: string;
  readonly classification: DataClassification;
}
export interface DataResidencyDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}
export interface DataResidencyProvider {
  authorizePlacement(input: DataPlacementRequest): Promise<DataResidencyDecision>;
}

export class InMemoryDataResidencyProvider implements DataResidencyProvider {
  private readonly regions = new Map<string, readonly string[]>();
  setAllowedRegions(organizationId: string, regions: readonly string[]): void {
    if (organizationId === '' || regions.length === 0)
      throw new ValidationError('Residency policy is invalid');
    this.regions.set(organizationId, [...regions]);
  }
  authorizePlacement(input: DataPlacementRequest): Promise<DataResidencyDecision> {
    const allowed = this.regions.get(input.organizationId)?.includes(input.region) ?? false;
    return Promise.resolve(
      allowed
        ? { allowed: true }
        : { allowed: false, reason: 'Region is not allowed by residency policy' },
    );
  }
}
