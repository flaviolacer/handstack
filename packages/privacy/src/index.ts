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

export type PrivacyDataDestination =
  | 'PRIMARY_DATABASE'
  | 'VECTOR_STORE'
  | 'SEARCH_INDEX'
  | 'OBJECT_STORAGE'
  | 'CACHE'
  | 'QUEUE'
  | 'BACKUP'
  | 'PLUGIN_DATA';

export interface DataDeletionPropagationInput {
  readonly organizationId: string;
  readonly subjectId: string;
  readonly requestId: string;
}

export interface DataDeletionPropagationResult {
  readonly destination: PrivacyDataDestination;
  readonly deleted: boolean;
  readonly evidence: readonly string[];
}

/** Adapter boundary for destinations that do not share the primary repository. */
export interface DataDeletionPropagationAdapter {
  readonly destination: PrivacyDataDestination;
  deleteSubject(input: DataDeletionPropagationInput): Promise<DataDeletionPropagationResult>;
}

/** Small official cache implementation with explicit subject ownership. */
export class InMemorySubjectCache implements DataDeletionPropagationAdapter {
  readonly destination = 'CACHE' as const;
  private readonly entries = new Map<
    string,
    { readonly organizationId: string; readonly subjectId?: string; readonly value: unknown }
  >();
  set(key: string, organizationId: string, value: unknown, subjectId?: string): void {
    this.entries.set(`${organizationId}:${key}`, {
      organizationId,
      ...(subjectId === undefined ? {} : { subjectId }),
      value,
    });
  }
  get(key: string, organizationId: string): unknown {
    return this.entries.get(`${organizationId}:${key}`)?.value;
  }
  deleteSubject(input: DataDeletionPropagationInput): Promise<DataDeletionPropagationResult> {
    let deleted = 0;
    for (const [key, entry] of this.entries)
      if (entry.organizationId === input.organizationId && entry.subjectId === input.subjectId) {
        this.entries.delete(key);
        deleted += 1;
      }
    return Promise.resolve({
      destination: this.destination,
      deleted: true,
      evidence: [`cache-entries-removed:${String(deleted)}`],
    });
  }
}

/** Minimal Redis surface used by the subject-indexed external cache adapter. */
export interface SubjectCacheRedisClient {
  set(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<readonly string[]>;
  del(...keys: readonly string[]): Promise<number>;
}

/** Redis-backed cache that can deterministically purge all values owned by a subject. */
export class RedisSubjectCache implements DataDeletionPropagationAdapter {
  readonly destination = 'CACHE' as const;
  constructor(
    private readonly client: SubjectCacheRedisClient,
    private readonly namespace = 'handstack:privacy-cache',
  ) {
    if (namespace.trim() === '') throw new ValidationError('Privacy cache namespace is required');
  }

  async set(key: string, organizationId: string, value: string, subjectId?: string): Promise<void> {
    const cacheKey = this.cacheKey(organizationId, key);
    const ownerKey = this.ownerKey(cacheKey);
    const previousSubjectId = await this.client.get(ownerKey);
    if (previousSubjectId !== null && previousSubjectId !== subjectId)
      await this.client.srem(this.subjectKey(organizationId, previousSubjectId), cacheKey);
    await this.client.set(cacheKey, value);
    if (subjectId !== undefined) {
      await this.client.set(ownerKey, subjectId);
      await this.client.sadd(this.subjectKey(organizationId, subjectId), cacheKey);
    } else await this.client.del(ownerKey);
  }

  get(key: string, organizationId: string): Promise<string | null> {
    return this.client.get(this.cacheKey(organizationId, key));
  }

  async deleteSubject(input: DataDeletionPropagationInput): Promise<DataDeletionPropagationResult> {
    const subjectKey = this.subjectKey(input.organizationId, input.subjectId);
    const keys = await this.client.smembers(subjectKey);
    const deleted = keys.length === 0 ? 0 : await this.client.del(...keys);
    if (keys.length > 0) await this.client.del(...keys.map((key) => this.ownerKey(key)));
    await this.client.del(subjectKey);
    return {
      destination: this.destination,
      deleted: true,
      evidence: [`redis-cache-entries-removed:${String(Math.max(0, deleted))}`],
    };
  }

  private cacheKey(organizationId: string, key: string): string {
    if (organizationId.trim() === '' || key.trim() === '')
      throw new ValidationError('Privacy cache identity is required');
    return `${this.namespace}:value:${encodeURIComponent(organizationId)}:${encodeURIComponent(key)}`;
  }

  private subjectKey(organizationId: string, subjectId: string): string {
    if (organizationId.trim() === '' || subjectId.trim() === '')
      throw new ValidationError('Privacy cache subject identity is required');
    return `${this.namespace}:subject:${encodeURIComponent(organizationId)}:${encodeURIComponent(subjectId)}`;
  }

  private ownerKey(cacheKey: string): string {
    return `${this.namespace}:owner:${cacheKey}`;
  }
}

/** Backup retention primitive: tombstones are durable deletion markers. */
export class InMemoryBackupTombstoneLedger implements DataDeletionPropagationAdapter {
  readonly destination = 'BACKUP' as const;
  private readonly tombstones = new Map<string, DataDeletionPropagationInput>();
  deleteSubject(input: DataDeletionPropagationInput): Promise<DataDeletionPropagationResult> {
    this.tombstones.set(`${input.organizationId}:${input.subjectId}`, input);
    return Promise.resolve({
      destination: this.destination,
      deleted: true,
      evidence: [`backup-tombstone:${input.organizationId}:${input.subjectId}`],
    });
  }
  hasTombstone(organizationId: string, subjectId: string): boolean {
    return this.tombstones.has(`${organizationId}:${subjectId}`);
  }
}

/** Minimal durable object boundary for backup deletion tombstones. */
export interface BackupTombstoneStore {
  put(key: string, value: string): Promise<void>;
}

/** External-backup adapter that records subject tombstones without storing subject content. */
export class ExternalBackupTombstoneAdapter implements DataDeletionPropagationAdapter {
  readonly destination = 'BACKUP' as const;
  constructor(
    private readonly store: BackupTombstoneStore,
    private readonly namespace = 'handstack:privacy-tombstones',
  ) {
    if (namespace.trim() === '')
      throw new ValidationError('Backup tombstone namespace is required');
  }

  async deleteSubject(input: DataDeletionPropagationInput): Promise<DataDeletionPropagationResult> {
    const id = `${input.organizationId}:${input.subjectId}`;
    const key = `${this.namespace}/${encodeURIComponent(input.organizationId)}/${encodeURIComponent(input.subjectId)}`;
    await this.store.put(
      key,
      JSON.stringify({
        organizationId: input.organizationId,
        subjectId: input.subjectId,
        requestId: input.requestId,
        tombstonedAt: new Date().toISOString(),
      }),
    );
    return {
      destination: this.destination,
      deleted: true,
      evidence: [`external-backup-tombstone:${id}`],
    };
  }
}

/**
 * Executes registered destination adapters deterministically. An unregistered
 * destination is not treated as successfully deleted; callers can use the
 * result to keep a deletion job partial and retry after configuration.
 */
export class DataDeletionPropagator {
  private readonly adapters = new Map<PrivacyDataDestination, DataDeletionPropagationAdapter>();

  register(adapter: DataDeletionPropagationAdapter): void {
    if (this.adapters.has(adapter.destination))
      throw new ValidationError(`Deletion adapter already registered: ${adapter.destination}`);
    this.adapters.set(adapter.destination, adapter);
  }

  async propagate(
    input: DataDeletionPropagationInput,
    destinations: readonly PrivacyDataDestination[],
  ): Promise<readonly DataDeletionPropagationResult[]> {
    if (
      [input.organizationId, input.subjectId, input.requestId].some((value) => value.trim() === '')
    )
      throw new ValidationError('Deletion propagation identity is required');
    const unique = [...new Set(destinations)];
    return Promise.all(
      unique.map(async (destination) => {
        const adapter = this.adapters.get(destination);
        if (adapter === undefined)
          return { destination, deleted: false, evidence: [`adapter-missing:${destination}`] };
        let result: DataDeletionPropagationResult;
        try {
          result = await adapter.deleteSubject(input);
        } catch {
          // Do not expose adapter errors in subject-request evidence. Persist a
          // retryable, fail-closed result instead of losing the partial job.
          return { destination, deleted: false, evidence: [`adapter-error:${destination}`] };
        }
        if (result.destination !== destination)
          throw new ValidationError(
            `Deletion adapter returned the wrong destination: ${result.destination}`,
          );
        return result;
      }),
    );
  }
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
