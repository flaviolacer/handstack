import type { OrganizationOwnedEntity } from '@handstack/identity';

export interface Role extends OrganizationOwnedEntity {
  readonly name: string;
  readonly description?: string;
}

export interface Permission extends OrganizationOwnedEntity {
  readonly resource: string;
  readonly action: string;
}

export interface RolePermission extends OrganizationOwnedEntity {
  readonly roleId: string;
  readonly permissionId: string;
}

export interface PrincipalRole extends OrganizationOwnedEntity {
  readonly principalId: string;
  readonly roleId: string;
}

export interface TimeCondition {
  readonly from: string;
  readonly to: string;
}

export interface PolicyCondition {
  readonly groupId?: string;
  readonly time?: TimeCondition;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface AuthorizationRequest {
  readonly organizationId: string;
  readonly principalId: string;
  readonly resource: string;
  readonly action: string;
  readonly groupIds: readonly string[];
  readonly evaluatedAt: Date;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly obligations?: readonly string[];
  readonly policyIds?: readonly string[];
}

export interface AuthorizationPolicy {
  readonly id: string;
  readonly organizationId: string;
  readonly principalIds: readonly string[];
  readonly resource: string;
  readonly action: string;
  readonly effect: 'allow' | 'deny';
  readonly conditions?: PolicyCondition;
}

export interface PolicyEngine {
  authorize(input: AuthorizationRequest): Promise<AuthorizationDecision>;
}

function validTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function minutes(value: string): number {
  const [hours = 0, minute = 0] = value.split(':').map(Number);
  return hours * 60 + minute;
}

function conditionsMatch(policy: AuthorizationPolicy, request: AuthorizationRequest): boolean {
  const { conditions } = policy;
  if (conditions?.groupId !== undefined && !request.groupIds.includes(conditions.groupId)) {
    return false;
  }
  if (conditions?.time !== undefined) {
    const { from, to } = conditions.time;
    if (!validTime(from) || !validTime(to)) return false;
    const current = request.evaluatedAt.getUTCHours() * 60 + request.evaluatedAt.getUTCMinutes();
    if (current < minutes(from) || current > minutes(to)) return false;
  }
  if (conditions?.attributes !== undefined) {
    const actual = request.attributes ?? {};
    if (!Object.entries(conditions.attributes).every(([key, value]) => actual[key] === value))
      return false;
  }
  return true;
}

export class InMemoryPolicyEngine implements PolicyEngine {
  constructor(private readonly policies: readonly AuthorizationPolicy[]) {}

  authorize(input: AuthorizationRequest): Promise<AuthorizationDecision> {
    const applicable = this.policies.filter(
      (policy) =>
        policy.organizationId === input.organizationId &&
        policy.principalIds.includes(input.principalId) &&
        policy.resource === input.resource &&
        policy.action === input.action &&
        conditionsMatch(policy, input),
    );
    const denied = applicable.filter((policy) => policy.effect === 'deny');
    if (denied.length > 0) {
      return Promise.resolve({
        allowed: false,
        reason: 'explicit deny',
        policyIds: denied.map(({ id }) => id),
      });
    }
    const allowed = applicable.filter((policy) => policy.effect === 'allow');
    if (allowed.length > 0) {
      return Promise.resolve({ allowed: true, policyIds: allowed.map(({ id }) => id) });
    }
    return Promise.resolve({ allowed: false, reason: 'no matching policy' });
  }
}

export function parsePermission(value: string): { resource: string; action: string } {
  const separator = value.lastIndexOf('.');
  if (separator <= 0 || separator === value.length - 1) {
    throw new TypeError('Permission must use resource.action format');
  }
  return { resource: value.slice(0, separator), action: value.slice(separator + 1) };
}

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export interface ApprovalRequest {
  readonly id: string;
  readonly organizationId: string;
  readonly requesterId: string;
  readonly resource: string;
  readonly action: string;
  readonly payloadDigest: string;
  readonly requiredApprovers: readonly string[];
  readonly approvedBy: readonly string[];
  readonly status: ApprovalStatus;
  readonly expiresAt?: Date;
  readonly createdAt: Date;
}

export interface ApprovalService {
  request(
    input: Omit<ApprovalRequest, 'approvedBy' | 'status' | 'createdAt'>,
  ): Promise<ApprovalRequest>;
  approve(organizationId: string, approvalId: string, approverId: string): Promise<ApprovalRequest>;
  requireApproved(organizationId: string, approvalId: string): Promise<ApprovalRequest>;
}

export class InMemoryApprovalService implements ApprovalService {
  private readonly requests = new Map<string, ApprovalRequest>();

  request(input: Omit<ApprovalRequest, 'approvedBy' | 'status' | 'createdAt'>) {
    if (
      input.organizationId === '' ||
      input.requesterId === '' ||
      input.requiredApprovers.length === 0
    )
      return Promise.reject(new Error('Approval tenant, requester and approvers are required'));
    const request: ApprovalRequest = {
      ...input,
      approvedBy: [],
      status: 'PENDING',
      createdAt: new Date(),
    };
    this.requests.set(`${input.organizationId}:${input.id}`, request);
    return Promise.resolve(request);
  }

  approve(organizationId: string, approvalId: string, approverId: string) {
    const current = this.requests.get(`${organizationId}:${approvalId}`);
    if (current === undefined) return Promise.reject(new Error('Approval request not found'));
    if (!current.requiredApprovers.includes(approverId))
      return Promise.reject(new Error('Approver is not authorized'));
    const approvedBy = [...new Set([...current.approvedBy, approverId])];
    const status: ApprovalStatus = current.requiredApprovers.every((id) => approvedBy.includes(id))
      ? 'APPROVED'
      : 'PENDING';
    const updated = { ...current, approvedBy, status };
    this.requests.set(`${organizationId}:${approvalId}`, updated);
    return Promise.resolve(updated);
  }

  requireApproved(organizationId: string, approvalId: string) {
    const current = this.requests.get(`${organizationId}:${approvalId}`);
    if (current === undefined) return Promise.reject(new Error('Approval request not found'));
    if (current.expiresAt !== undefined && current.expiresAt.getTime() <= Date.now())
      return Promise.reject(new Error('Approval request expired'));
    if (current.status !== 'APPROVED') return Promise.reject(new Error('Approval is required'));
    return Promise.resolve(current);
  }
}
