import { Injectable, Inject, Optional } from '@nestjs/common';
import { repositoryName, uuidV7, type Repository, type TenantEntity } from '@handstack/domain';
import { ValidationError } from '@handstack/shared';
import {
  DataDeletionPropagator,
  ExternalBackupTombstoneAdapter,
  InMemorySubjectCache,
  type DataClassification,
  type DataSubjectRequestStatus,
  type DataSubjectRequestType,
  type DataDeletionPropagationAdapter,
  type PrivacyDataDestination,
  type DataDeletionPropagationInput,
  type DataDeletionPropagationResult,
  type BackupTombstoneStore,
  RedisSubjectCache,
} from '@handstack/privacy';
import { DatabaseService } from '../database/database.service.js';
import { LocalAttachmentStorage } from '../chat/attachment-storage.js';
import { OperationsRuntimeService } from '../operations/operations-runtime.service.js';
import { KnowledgeRuntimeService } from '../knowledge/knowledge-runtime.service.js';
import { McpRuntimeService } from '../mcp/mcp-runtime.service.js';
import { ChatService } from '@handstack/chat';
import { SettingsRuntimeService } from '../settings/settings-runtime.service.js';
import { EventBusRuntimeService } from '../core/event-bus-runtime.service.js';

export interface StoredRetentionPolicy extends TenantEntity {
  readonly organizationId: string;
  readonly resourceType: string;
  readonly retentionDays: number;
}
export interface StoredLegalHold extends TenantEntity {
  readonly organizationId: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly reason: string;
  readonly active: boolean;
}
export interface StoredDataSubjectRequest extends TenantEntity {
  readonly organizationId: string;
  readonly subjectId: string;
  readonly type: DataSubjectRequestType;
  readonly status: DataSubjectRequestStatus;
  readonly evidence: readonly string[];
  readonly exportId?: string;
}
export interface StoredDataExport extends TenantEntity {
  readonly organizationId: string;
  readonly requestId: string;
  readonly subjectId: string;
  readonly records: readonly Readonly<Record<string, unknown>>[];
}
export interface StoredResidencyPolicy extends TenantEntity {
  readonly organizationId: string;
  readonly region: string;
  readonly classification: DataClassification;
}
/** Normative tenant-owned data inventory entity from specification section 129. */
export interface DataInventoryEntry extends TenantEntity {
  readonly organizationId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly classification: DataClassification;
  readonly processingPurpose?: string;
  readonly region?: string;
  readonly subjectIds: readonly string[];
}
export interface StoredProcessingPurpose extends TenantEntity {
  readonly organizationId: string;
  readonly name: string;
  readonly description: string;
  readonly lawfulBasis: string;
  readonly active: boolean;
}
export interface StoredConsentRecord extends TenantEntity {
  readonly organizationId: string;
  readonly subjectId: string;
  readonly purposeId: string;
  readonly status: 'GRANTED' | 'WITHDRAWN';
  readonly capturedAt: Date;
  readonly withdrawnAt?: Date;
}
export interface StoredProcessorRecord extends TenantEntity {
  readonly organizationId: string;
  readonly name: string;
  readonly purpose: string;
  readonly regions: readonly string[];
  readonly status: 'ACTIVE' | 'INACTIVE';
}
export interface StoredPrivacyIncident extends TenantEntity {
  readonly organizationId: string;
  readonly title: string;
  readonly severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly status: 'OPEN' | 'INVESTIGATING' | 'CONTAINED' | 'CLOSED';
  readonly affectedResources: readonly string[];
  readonly description?: string;
}
export interface StoredDeletionJob extends TenantEntity {
  readonly organizationId: string;
  readonly requestId: string;
  readonly subjectId: string;
  readonly status: 'RUNNING' | 'COMPLETED' | 'PARTIALLY_COMPLETED';
  readonly evidenceCount: number;
}
export interface StoredDeletionEvidence extends TenantEntity {
  readonly organizationId: string;
  readonly jobId: string;
  readonly repository: string;
  readonly resourceId: string;
  readonly action: 'DELETED' | 'RETAINED';
  readonly reason?: string;
}
function matchesRetentionHold(
  holds: readonly StoredLegalHold[],
  resourceType: string,
  resourceId: string,
): boolean {
  return holds.some(
    (hold) =>
      (hold.resourceType === undefined || hold.resourceType === resourceType) &&
      (hold.resourceId === undefined || hold.resourceId === resourceId),
  );
}
interface StoredBackupTombstone extends TenantEntity {
  readonly organizationId: string;
  readonly subjectId: string;
  readonly requestId: string;
  readonly tombstonedAt: Date;
}

@Injectable()
export class PrivacyRuntimeService {
  private readonly propagator = new DataDeletionPropagator();
  private readonly subjectCache = new InMemorySubjectCache();
  private readonly backupTombstones: DataDeletionPropagationAdapter;
  private readonly database: DatabaseService;
  private readonly chat: ChatService;
  private readonly retention: Repository<StoredRetentionPolicy>;
  private readonly holds: Repository<StoredLegalHold>;
  private readonly requests: Repository<StoredDataSubjectRequest>;
  private readonly residency: Repository<StoredResidencyPolicy>;
  private readonly exports: Repository<StoredDataExport>;
  private readonly inventory: Repository<DataInventoryEntry>;
  private readonly purposes: Repository<StoredProcessingPurpose>;
  private readonly consents: Repository<StoredConsentRecord>;
  private readonly processors: Repository<StoredProcessorRecord>;
  private readonly incidents: Repository<StoredPrivacyIncident>;
  private readonly deletionJobs: Repository<StoredDeletionJob>;
  private readonly deletionEvidence: Repository<StoredDeletionEvidence>;

  constructor(
    @Inject(DatabaseService) database: DatabaseService,
    @Inject(LocalAttachmentStorage) private readonly attachmentStorage: LocalAttachmentStorage,
    @Optional()
    @Inject(OperationsRuntimeService)
    private readonly operations?: OperationsRuntimeService,
    @Optional()
    @Inject(KnowledgeRuntimeService)
    private readonly knowledge?: KnowledgeRuntimeService,
    @Optional() @Inject(McpRuntimeService) private readonly mcp?: McpRuntimeService,
    @Optional() @Inject(SettingsRuntimeService) private readonly settings?: SettingsRuntimeService,
    @Optional() @Inject(EventBusRuntimeService) eventBus?: EventBusRuntimeService,
  ) {
    this.database = database;
    this.chat = new ChatService(database.adapter, undefined, {
      attachmentStorage: this.attachmentStorage,
    });
    this.retention = database.adapter.repository(repositoryName('retention-policies'));
    this.holds = database.adapter.repository(repositoryName('legal-holds'));
    this.requests = database.adapter.repository(repositoryName('data-subject-requests'));
    this.residency = database.adapter.repository(repositoryName('data-residency-policies'));
    this.exports = database.adapter.repository(repositoryName('data-exports'));
    this.inventory = database.adapter.repository(repositoryName('data-inventory'));
    this.purposes = database.adapter.repository(repositoryName('data-processing-purposes'));
    this.consents = database.adapter.repository(repositoryName('consent-records'));
    this.processors = database.adapter.repository(repositoryName('processor-records'));
    this.incidents = database.adapter.repository(repositoryName('privacy-incidents'));
    this.deletionJobs = database.adapter.repository(repositoryName('deletion-jobs'));
    this.deletionEvidence = database.adapter.repository(repositoryName('deletion-evidence'));
    this.backupTombstones = new RepositoryBackupTombstoneAdapter(
      database.adapter.repository(repositoryName('backup-tombstones')),
    );
    if (database.config.vectorStore.adapter === 'repository') {
      this.registerDeletionAdapter({
        destination: 'VECTOR_STORE',
        deleteSubject: ({ organizationId, subjectId }) =>
          Promise.resolve({
            destination: 'VECTOR_STORE',
            deleted: true,
            evidence: [`repository-vectors-covered:${organizationId}:${subjectId}`],
          }),
      });
    } else if (this.knowledge !== undefined) {
      const knowledge = this.knowledge;
      this.registerDeletionAdapter({
        destination: 'VECTOR_STORE',
        deleteSubject: async ({ organizationId, subjectId }) => ({
          destination: 'VECTOR_STORE',
          deleted: true,
          evidence: [
            `vector-subject-delete:${String(await knowledge.deleteSubjectVectors(organizationId, subjectId))}`,
          ],
        }),
      });
    }
    if (this.knowledge !== undefined) {
      const knowledge = this.knowledge;
      this.registerDeletionAdapter({
        destination: 'SEARCH_INDEX',
        deleteSubject: async ({ organizationId, subjectId }) => ({
          destination: 'SEARCH_INDEX',
          deleted: true,
          evidence: [
            `search-index-records-removed:${String(await knowledge.deleteSubjectSearchIndex(organizationId, subjectId))}`,
          ],
        }),
      });
    }
    this.registerDeletionAdapter({
      destination: 'OBJECT_STORAGE',
      deleteSubject: ({ organizationId, subjectId }) =>
        Promise.resolve({
          destination: 'OBJECT_STORAGE',
          deleted: true,
          evidence: [`local-attachments-covered:${organizationId}:${subjectId}`],
        }),
    });
    this.registerDeletionAdapter({
      destination: 'PLUGIN_DATA',
      deleteSubject: ({ organizationId, subjectId }) =>
        Promise.resolve({
          destination: 'PLUGIN_DATA',
          deleted: true,
          evidence: [`plugin-repositories-covered:${organizationId}:${subjectId}`],
        }),
    });
    const cacheAdapters: DataDeletionPropagationAdapter[] = [];
    if (this.mcp === undefined) cacheAdapters.push(this.subjectCache);
    const backupAdapters: DataDeletionPropagationAdapter[] = [this.backupTombstones];
    if (eventBus?.subjectCache !== undefined) {
      const redis = eventBus.subjectCache;
      const externalStore: BackupTombstoneStore = {
        put: async (key, value) => {
          await redis.set(key, value);
        },
      };
      backupAdapters.push(new ExternalBackupTombstoneAdapter(externalStore));
    }
    this.registerDeletionAdapter({
      destination: 'BACKUP',
      deleteSubject: async (input) => {
        const results = await Promise.all(
          backupAdapters.map((adapter) => adapter.deleteSubject(input)),
        );
        return {
          destination: 'BACKUP',
          deleted: results.every((result) => result.deleted),
          evidence: results.flatMap((result) => result.evidence),
        };
      },
    });
    if (this.mcp !== undefined) {
      const mcp = this.mcp;
      cacheAdapters.push({
        destination: 'CACHE',
        deleteSubject: async ({ organizationId }) => ({
          destination: 'CACHE',
          deleted: true,
          evidence: [
            `mcp-cache-servers-removed:${String(await mcp.purgeOrganizationCache(organizationId))}`,
          ],
        }),
      });
    }
    if (eventBus?.subjectCache !== undefined)
      cacheAdapters.push(new RedisSubjectCache(eventBus.subjectCache));
    if (cacheAdapters.length > 0)
      this.registerDeletionAdapter({
        destination: 'CACHE',
        deleteSubject: async (input) => {
          const results = await Promise.all(
            cacheAdapters.map((adapter) => adapter.deleteSubject(input)),
          );
          return {
            destination: 'CACHE',
            deleted: results.every((result) => result.deleted),
            evidence: results.flatMap((result) => result.evidence),
          };
        },
      });
    if (this.operations !== undefined) {
      const operations = this.operations;
      this.registerDeletionAdapter({
        destination: 'QUEUE',
        deleteSubject: async ({ organizationId, subjectId }) => ({
          destination: 'QUEUE',
          deleted: true,
          evidence: [
            `jobs-removed:${String(await operations.deleteSubjectJobs(organizationId, subjectId))}`,
          ],
        }),
      });
    }
  }

  registerDeletionAdapter(adapter: DataDeletionPropagationAdapter): void {
    this.propagator.register(adapter);
  }

  listInventory(organizationId: string) {
    return this.listAll(this.inventory, organizationId);
  }
  createInventory(input: Omit<DataInventoryEntry, keyof TenantEntity>) {
    if (input.resourceType.trim() === '' || input.resourceId.trim() === '')
      throw new ValidationError('Inventory resource identity is required');
    return this.inventory.insert({
      ...input,
      id: uuidV7(),
      tenantId: input.organizationId,
      subjectIds: [...input.subjectIds],
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  listPurposes(organizationId: string) {
    return this.listAll(this.purposes, organizationId);
  }
  createPurpose(input: {
    organizationId: string;
    name: string;
    description: string;
    lawfulBasis: string;
  }) {
    if ([input.name, input.description, input.lawfulBasis].some((value) => value.trim() === ''))
      throw new ValidationError('Processing purpose fields are required');
    return this.purposes.insert({
      id: uuidV7(),
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      name: input.name.trim(),
      description: input.description.trim(),
      lawfulBasis: input.lawfulBasis.trim(),
      active: true,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  listConsents(organizationId: string) {
    return this.listAll(this.consents, organizationId);
  }
  async authorizeConsent(
    organizationId: string,
    subjectId: string,
    purposeId: string,
  ): Promise<{ readonly allowed: boolean; readonly reason?: string }> {
    if ([organizationId, subjectId, purposeId].some((value) => value.trim() === ''))
      return { allowed: false, reason: 'Consent identity is required' };
    const matching = (await this.listConsents(organizationId))
      .filter((consent) => consent.subjectId === subjectId && consent.purposeId === purposeId)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
    const latest = matching[0];
    if (latest?.status === 'GRANTED') return { allowed: true };
    return { allowed: false, reason: `Consent is not granted for purpose ${purposeId}` };
  }
  createConsent(input: { organizationId: string; subjectId: string; purposeId: string }) {
    if ([input.subjectId, input.purposeId].some((value) => value.trim() === ''))
      throw new ValidationError('Consent subject and purpose are required');
    const now = new Date();
    return this.consents.insert({
      id: uuidV7(),
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      subjectId: input.subjectId.trim(),
      purposeId: input.purposeId.trim(),
      status: 'GRANTED',
      capturedAt: now,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }
  async withdrawConsent(organizationId: string, id: string) {
    const current = await this.consents.findById(organizationId, id);
    if (current === undefined) throw new ValidationError('Consent record not found');
    return this.consents.update(
      {
        ...current,
        status: 'WITHDRAWN',
        withdrawnAt: new Date(),
        version: current.version + 1,
        updatedAt: new Date(),
      },
      current.version,
    );
  }

  listProcessors(organizationId: string) {
    return this.listAll(this.processors, organizationId);
  }
  createProcessor(input: {
    organizationId: string;
    name: string;
    purpose: string;
    regions: readonly string[];
  }) {
    if (
      [input.name, input.purpose].some((value) => value.trim() === '') ||
      input.regions.length === 0 ||
      input.regions.some((value) => value.trim() === '')
    )
      throw new ValidationError('Processor fields are required');
    return this.processors.insert({
      id: uuidV7(),
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      name: input.name.trim(),
      purpose: input.purpose.trim(),
      regions: input.regions.map((value) => value.trim()),
      status: 'ACTIVE',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  listIncidents(organizationId: string) {
    return this.listAll(this.incidents, organizationId);
  }
  createIncident(input: {
    organizationId: string;
    title: string;
    severity: StoredPrivacyIncident['severity'];
    affectedResources: readonly string[];
    description?: string;
  }) {
    if (input.title.trim() === '' || input.affectedResources.length === 0)
      throw new ValidationError('Privacy incident title and affected resources are required');
    return this.incidents.insert({
      id: uuidV7(),
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      title: input.title.trim(),
      severity: input.severity,
      status: 'OPEN',
      affectedResources: [...input.affectedResources],
      ...(input.description === undefined ? {} : { description: input.description.trim() }),
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  listDeletionJobs(organizationId: string) {
    return this.listAll(this.deletionJobs, organizationId);
  }
  listDeletionEvidence(organizationId: string, jobId: string) {
    return this.listAll(this.deletionEvidence, organizationId).then((items) =>
      items.filter((item) => item.jobId === jobId),
    );
  }

  listRetention(organizationId: string) {
    return this.listAll(this.retention, organizationId);
  }
  async setRetention(organizationId: string, resourceType: string, retentionDays: number) {
    if (resourceType.trim() === '' || !Number.isSafeInteger(retentionDays) || retentionDays < 0)
      throw new ValidationError('Invalid retention policy');
    const id = `${organizationId}:${resourceType.trim()}`;
    const current = await this.retention.findById(organizationId, id);
    const now = new Date();
    const next: StoredRetentionPolicy = {
      id,
      tenantId: organizationId,
      organizationId,
      resourceType: resourceType.trim(),
      retentionDays,
      version: (current?.version ?? 0) + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    return current === undefined
      ? this.retention.insert(next)
      : this.retention.update(next, current.version);
  }

  /** Applies the effective conversation retention policy through ChatService's cascade path. */
  async runConversationRetention(organizationId: string, actorId: string) {
    if (actorId.trim() === '') throw new ValidationError('Retention actor is required');
    const configuredPolicy = (await this.listRetention(organizationId)).find(
      (policy) => policy.resourceType === 'conversations',
    );
    const effectiveConfig =
      this.settings === undefined
        ? this.database.config
        : await this.settings.resolveForOrganization(organizationId);
    const retentionDays = configuredPolicy?.retentionDays ?? effectiveConfig.retention.conversation;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const runId = uuidV7();
    const conversations = await this.listAll(
      this.repositoryFor('conversations') as Repository<
        TenantEntity & {
          readonly status: string;
          readonly createdBy: string;
        }
      >,
      organizationId,
    );
    const holds = (await this.listHolds(organizationId)).filter((hold) => hold.active);
    const childRepositories = [
      'conversation-participants',
      'conversation-branches',
      'conversation-messages',
      'conversation-stream-events',
      'conversation-attachments',
      'conversation-citations',
      'conversation-artifacts',
    ] as const;
    const childrenByRepository = await Promise.all(
      childRepositories.map(async (repository) => ({
        repository,
        children: await this.listAll(
          this.repositoryFor(repository) as Repository<
            TenantEntity & {
              readonly conversationId: string;
            }
          >,
          organizationId,
        ),
      })),
    );
    const heldConversationIds = new Set<string>();
    for (const conversation of conversations)
      if (matchesRetentionHold(holds, 'conversations', conversation.id))
        heldConversationIds.add(conversation.id);
    for (const { repository, children } of childrenByRepository)
      for (const child of children)
        if (matchesRetentionHold(holds, repository, child.id))
          heldConversationIds.add(child.conversationId);
    let deleted = 0;
    let retained = 0;
    for (const conversation of conversations) {
      if (conversation.status === 'DELETED' || conversation.createdAt.getTime() > cutoff) continue;
      if (heldConversationIds.has(conversation.id)) {
        retained += 1;
        await this.deletionEvidence.insert({
          id: uuidV7(),
          tenantId: organizationId,
          organizationId,
          jobId: runId,
          repository: 'conversations',
          resourceId: conversation.id,
          action: 'RETAINED',
          reason: 'Active legal hold on conversation or child resource',
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        continue;
      }
      await this.chat.deleteConversationForRetention({
        organizationId,
        conversationId: conversation.id,
        actorId: actorId.trim(),
      });
      deleted += 1;
      await this.deletionEvidence.insert({
        id: uuidV7(),
        tenantId: organizationId,
        organizationId,
        jobId: runId,
        repository: 'conversations',
        resourceId: conversation.id,
        action: 'DELETED',
        reason: `Conversation retention elapsed (${String(retentionDays)} days)`,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    const completedAt = new Date();
    await this.deletionJobs.insert({
      id: runId,
      tenantId: organizationId,
      organizationId,
      requestId: runId,
      subjectId: actorId.trim(),
      status: 'COMPLETED',
      evidenceCount: deleted + retained,
      version: 1,
      createdAt: completedAt,
      updatedAt: completedAt,
    });
    return { runId, retentionDays, scanned: conversations.length, deleted, retained };
  }

  /** Applies tenant/global usage retention with legal holds and durable per-record evidence. */
  async runUsageRetention(organizationId: string, actorId: string) {
    if (actorId.trim() === '') throw new ValidationError('Retention actor is required');
    const configuredPolicy = (await this.listRetention(organizationId)).find(
      (policy) => policy.resourceType === 'usage-records',
    );
    const effectiveConfig =
      this.settings === undefined
        ? this.database.config
        : await this.settings.resolveForOrganization(organizationId);
    const retentionDays = configuredPolicy?.retentionDays ?? effectiveConfig.retention.usage;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const runId = uuidV7();
    const repository = this.repositoryFor('usage-records');
    const records = await this.listAll(repository, organizationId);
    const holds = (await this.listHolds(organizationId)).filter((hold) => hold.active);
    let deleted = 0;
    let retained = 0;
    for (const record of records) {
      if (record.createdAt.getTime() > cutoff) continue;
      const held = matchesRetentionHold(holds, 'usage-records', record.id);
      if (held) {
        retained += 1;
        await this.deletionEvidence.insert({
          id: uuidV7(),
          tenantId: organizationId,
          organizationId,
          jobId: runId,
          repository: 'usage-records',
          resourceId: record.id,
          action: 'RETAINED',
          reason: 'Active legal hold on usage record',
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        continue;
      }
      const removed = await repository.delete(organizationId, record.id, record.version);
      if (removed) deleted += 1;
      else retained += 1;
      await this.deletionEvidence.insert({
        id: uuidV7(),
        tenantId: organizationId,
        organizationId,
        jobId: runId,
        repository: 'usage-records',
        resourceId: record.id,
        action: removed ? 'DELETED' : 'RETAINED',
        ...(removed ? {} : { reason: 'Usage record changed during retention execution' }),
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    const completedAt = new Date();
    await this.deletionJobs.insert({
      id: runId,
      tenantId: organizationId,
      organizationId,
      requestId: runId,
      subjectId: actorId.trim(),
      status: 'COMPLETED',
      evidenceCount: deleted + retained,
      version: 1,
      createdAt: completedAt,
      updatedAt: completedAt,
    });
    return { runId, retentionDays, scanned: records.length, deleted, retained };
  }

  /** Removes expired local attachments while keeping the metadata and blob decision auditable. */
  async runAttachmentRetention(organizationId: string, actorId: string) {
    if (actorId.trim() === '') throw new ValidationError('Retention actor is required');
    const configuredPolicy = (await this.listRetention(organizationId)).find(
      (policy) => policy.resourceType === 'conversation-attachments',
    );
    const effectiveConfig =
      this.settings === undefined
        ? this.database.config
        : await this.settings.resolveForOrganization(organizationId);
    const retentionDays = configuredPolicy?.retentionDays ?? effectiveConfig.retention.attachments;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const runId = uuidV7();
    const repository = this.repositoryFor('conversation-attachments') as Repository<
      TenantEntity & { readonly status?: string; readonly storageKey: string }
    >;
    const records = await this.listAll(repository, organizationId);
    const holds = (await this.listHolds(organizationId)).filter((hold) => hold.active);
    let deleted = 0;
    let retained = 0;
    for (const record of records) {
      if (record.status === 'DELETED' || record.createdAt.getTime() > cutoff) continue;
      const held = matchesRetentionHold(holds, 'conversation-attachments', record.id);
      if (held) {
        retained += 1;
        await this.deletionEvidence.insert({
          id: uuidV7(),
          tenantId: organizationId,
          organizationId,
          jobId: runId,
          repository: 'conversation-attachments',
          resourceId: record.id,
          action: 'RETAINED',
          reason: 'Active legal hold on attachment',
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        continue;
      }
      await this.attachmentStorage.delete(record.storageKey);
      const removed = await repository.update(
        { ...record, status: 'DELETED', version: record.version + 1, updatedAt: new Date() },
        record.version,
      );
      deleted += removed.status === 'DELETED' ? 1 : 0;
      await this.deletionEvidence.insert({
        id: uuidV7(),
        tenantId: organizationId,
        organizationId,
        jobId: runId,
        repository: 'conversation-attachments',
        resourceId: record.id,
        action: removed.status === 'DELETED' ? 'DELETED' : 'RETAINED',
        ...(removed.status === 'DELETED'
          ? {}
          : { reason: 'Attachment changed during retention execution' }),
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    const completedAt = new Date();
    await this.deletionJobs.insert({
      id: runId,
      tenantId: organizationId,
      organizationId,
      requestId: runId,
      subjectId: actorId.trim(),
      status: 'COMPLETED',
      evidenceCount: deleted + retained,
      version: 1,
      createdAt: completedAt,
      updatedAt: completedAt,
    });
    return { runId, retentionDays, scanned: records.length, deleted, retained };
  }

  /** Removes expired trace correlation from messages without deleting message content. */
  async runTraceRetention(organizationId: string, actorId: string) {
    if (actorId.trim() === '') throw new ValidationError('Retention actor is required');
    const configuredPolicy = (await this.listRetention(organizationId)).find(
      (policy) => policy.resourceType === 'traces',
    );
    const effectiveConfig =
      this.settings === undefined
        ? this.database.config
        : await this.settings.resolveForOrganization(organizationId);
    const retentionDays = configuredPolicy?.retentionDays ?? effectiveConfig.retention.trace;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const runId = uuidV7();
    const repository = this.repositoryFor('conversation-messages') as Repository<
      TenantEntity & { readonly traceId?: string }
    >;
    const records = await this.listAll(repository, organizationId);
    const holds = (await this.listHolds(organizationId)).filter((hold) => hold.active);
    let deleted = 0;
    let retained = 0;
    for (const record of records) {
      if (record.traceId === undefined || record.createdAt.getTime() > cutoff) continue;
      const held =
        matchesRetentionHold(holds, 'traces', record.id) ||
        matchesRetentionHold(holds, 'conversation-messages', record.id);
      if (held) {
        retained += 1;
        await this.deletionEvidence.insert({
          id: uuidV7(),
          tenantId: organizationId,
          organizationId,
          jobId: runId,
          repository: 'conversation-messages',
          resourceId: record.id,
          action: 'RETAINED',
          reason: 'Active legal hold on trace or message',
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        continue;
      }
      const withoutTrace = Object.fromEntries(
        Object.entries(record).filter(([key]) => key !== 'traceId'),
      ) as TenantEntity;
      await repository.update(
        { ...withoutTrace, version: record.version + 1, updatedAt: new Date() },
        record.version,
      );
      deleted += 1;
      await this.deletionEvidence.insert({
        id: uuidV7(),
        tenantId: organizationId,
        organizationId,
        jobId: runId,
        repository: 'conversation-messages',
        resourceId: record.id,
        action: 'DELETED',
        reason: 'Trace retention elapsed; message content preserved',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    const completedAt = new Date();
    await this.deletionJobs.insert({
      id: runId,
      tenantId: organizationId,
      organizationId,
      requestId: runId,
      subjectId: actorId.trim(),
      status: 'COMPLETED',
      evidenceCount: deleted + retained,
      version: 1,
      createdAt: completedAt,
      updatedAt: completedAt,
    });
    return { runId, retentionDays, scanned: records.length, deleted, retained };
  }

  listHolds(organizationId: string) {
    return this.listAll(this.holds, organizationId);
  }
  createHold(input: {
    organizationId: string;
    resourceType?: string;
    resourceId?: string;
    reason: string;
  }) {
    if (input.reason.trim() === '') throw new ValidationError('Legal hold reason is required');
    const now = new Date();
    return this.holds.insert({
      id: uuidV7(),
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
      ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
      reason: input.reason.trim(),
      active: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }
  async releaseHold(organizationId: string, id: string) {
    const current = await this.holds.findById(organizationId, id);
    if (current === undefined) throw new ValidationError('Legal hold not found');
    return this.holds.update(
      { ...current, active: false, version: current.version + 1, updatedAt: new Date() },
      current.version,
    );
  }

  listRequests(organizationId: string) {
    return this.listAll(this.requests, organizationId);
  }
  async createRequest(input: {
    organizationId: string;
    subjectId: string;
    type: DataSubjectRequestType;
  }) {
    if (input.subjectId.trim() === '') throw new ValidationError('Data subject is required');
    const now = new Date();
    return this.requests.insert({
      id: uuidV7(),
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      subjectId: input.subjectId.trim(),
      type: input.type,
      status: 'RECEIVED',
      evidence: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }
  async updateRequest(
    organizationId: string,
    id: string,
    status: DataSubjectRequestStatus,
    evidence: readonly string[] = [],
  ) {
    const current = await this.requests.findById(organizationId, id);
    if (current === undefined) throw new ValidationError('Data subject request not found');
    return this.requests.update(
      { ...current, status, evidence, version: current.version + 1, updatedAt: new Date() },
      current.version,
    );
  }

  async executeRequest(organizationId: string, id: string) {
    const current = await this.requests.findById(organizationId, id);
    if (current === undefined) throw new ValidationError('Data subject request not found');
    if (current.status !== 'APPROVED' && current.status !== 'IN_PROGRESS')
      throw new ValidationError('Data subject request must be approved before execution');
    const started = await this.requests.update(
      { ...current, status: 'IN_PROGRESS', version: current.version + 1, updatedAt: new Date() },
      current.version,
    );
    if (current.type === 'DELETION') {
      const deletionJob = await this.deletionJobs.insert({
        id: uuidV7(),
        tenantId: organizationId,
        organizationId,
        requestId: started.id,
        subjectId: current.subjectId,
        status: 'RUNNING',
        evidenceCount: 0,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const evidence = await this.deleteSubjectRecords(
        organizationId,
        current.subjectId,
        deletionJob.id,
      );
      const propagated = await this.propagator.propagate(
        { organizationId, subjectId: current.subjectId, requestId: started.id },
        EXTERNAL_DELETION_DESTINATIONS,
      );
      const propagationEvidence = propagated.flatMap((result) =>
        result.evidence.map((item) => `${result.destination}:${item}`),
      );
      const complete = propagated.every((result) => result.deleted);
      await this.deletionJobs.update(
        {
          ...deletionJob,
          status: complete ? 'COMPLETED' : 'PARTIALLY_COMPLETED',
          evidenceCount: evidence.length + propagationEvidence.length,
          version: deletionJob.version + 1,
          updatedAt: new Date(),
        },
        deletionJob.version,
      );
      return this.requests.update(
        {
          ...started,
          status: complete ? 'COMPLETED' : 'PARTIALLY_COMPLETED',
          evidence: [`deletion-job:${deletionJob.id}`, ...evidence, ...propagationEvidence],
          version: started.version + 1,
          updatedAt: new Date(),
        },
        started.version,
      );
    }
    const exported = await this.createExport(organizationId, started.id, current.subjectId);
    return this.requests.update(
      {
        ...started,
        status: 'COMPLETED',
        exportId: exported.id,
        evidence: [
          `${current.type}:export:${exported.id}`,
          `records:${String(exported.records.length)}`,
        ],
        version: started.version + 1,
        updatedAt: new Date(),
      },
      started.version,
    );
  }

  async getExport(organizationId: string, requestId: string) {
    const exported = (await this.listAll(this.exports, organizationId)).find(
      (item) => item.requestId === requestId,
    );
    if (exported === undefined) throw new ValidationError('Data export not found');
    return exported;
  }

  private async createExport(
    organizationId: string,
    requestId: string,
    subjectId: string,
  ): Promise<StoredDataExport> {
    const records: Readonly<Record<string, unknown>>[] = [];
    for (const name of SUBJECT_DATA_REPOSITORIES) {
      let cursor: string | undefined;
      do {
        const page = await this.repositoryFor(name).list(organizationId, {
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const item of page.items) {
          const record = item as unknown as Record<string, unknown>;
          if (recordBelongsToSubject(record, subjectId))
            records.push({ repository: name, ...sanitizeExportRecord(record) });
        }
        if (page.nextCursor !== undefined && page.nextCursor === cursor)
          throw new ValidationError('Privacy export repository cursor repeated');
        cursor = page.nextCursor;
      } while (cursor !== undefined);
    }
    const now = new Date();
    return this.exports.insert({
      id: uuidV7(),
      tenantId: organizationId,
      organizationId,
      requestId,
      subjectId,
      records,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  private async deleteSubjectRecords(
    organizationId: string,
    subjectId: string,
    jobId: string,
  ): Promise<readonly string[]> {
    const holds = (await this.listAll(this.holds, organizationId)).filter((hold) => hold.active);
    const repositories = SUBJECT_DATA_REPOSITORIES;
    const deleted: string[] = [];
    for (const name of repositories) {
      const repository = this.repositoryFor(name);
      let cursor: string | undefined;
      do {
        const page = await repository.list(organizationId, {
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const item of page.items) {
          const record = item as unknown as Record<string, unknown>;
          const matches = recordBelongsToSubject(record, subjectId);
          if (!matches) continue;
          const held = holds.some(
            (hold) =>
              (hold.resourceType === undefined || hold.resourceType === name) &&
              (hold.resourceId === undefined || hold.resourceId === item.id),
          );
          if (held) {
            await this.deletionEvidence.insert({
              id: uuidV7(),
              tenantId: organizationId,
              organizationId,
              jobId,
              repository: name,
              resourceId: item.id,
              action: 'RETAINED',
              reason: 'Active legal hold',
              version: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
            continue;
          }
          await repository.delete(organizationId, item.id, item.version);
          if (name === 'conversation-attachments') {
            const storageKey = record.storageKey;
            if (typeof storageKey === 'string' && storageKey !== '')
              await this.attachmentStorage.delete(storageKey);
          }
          await this.deletionEvidence.insert({
            id: uuidV7(),
            tenantId: organizationId,
            organizationId,
            jobId,
            repository: name,
            resourceId: item.id,
            action: 'DELETED',
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          deleted.push(`${name}:${item.id}`);
        }
        if (page.nextCursor !== undefined && page.nextCursor === cursor)
          throw new ValidationError('Privacy repository cursor repeated');
        cursor = page.nextCursor;
      } while (cursor !== undefined);
    }
    return deleted;
  }

  private repositoryFor(name: string): Repository<TenantEntity> {
    // All repositories in this method are tenant-scoped and expose the common entity contract.
    return this.database.adapter.repository(repositoryName(name));
  }

  private async listAll<T extends TenantEntity>(
    repository: Repository<T>,
    organizationId: string,
  ): Promise<readonly T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await repository.list(organizationId, {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      items.push(...page.items);
      if (page.nextCursor !== undefined && page.nextCursor === cursor)
        throw new ValidationError('Privacy repository cursor repeated');
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return items;
  }

  listResidency(organizationId: string) {
    return this.listAll(this.residency, organizationId);
  }
  async authorizePlacement(
    organizationId: string,
    classification: DataClassification,
    region: string,
  ): Promise<{ readonly allowed: boolean; readonly reason?: string }> {
    const policies = (await this.listResidency(organizationId)).filter(
      (policy) => policy.classification === classification,
    );
    if (policies.length === 0)
      return { allowed: false, reason: 'No residency policy registers this classification' };
    return policies.some((policy) => policy.region === region.trim())
      ? { allowed: true }
      : { allowed: false, reason: `Region ${region} is not allowed for ${classification}` };
  }
  async setResidency(organizationId: string, region: string, classification: DataClassification) {
    if (region.trim() === '') throw new ValidationError('Residency region is required');
    const id = `${organizationId}:${classification}:${region.trim()}`;
    const current = await this.residency.findById(organizationId, id);
    const now = new Date();
    const next: StoredResidencyPolicy = {
      id,
      tenantId: organizationId,
      organizationId,
      region: region.trim(),
      classification,
      version: (current?.version ?? 0) + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    return current === undefined
      ? this.residency.insert(next)
      : this.residency.update(next, current.version);
  }
}

/**
 * Persisted subject-bearing resources are kept in one allow-list so export and
 * deletion cannot silently drift apart. External object/vector/cache/queue
 * destinations require a registered deletion adapter and are not implied by
 * deleting their database metadata.
 */
const SUBJECT_DATA_REPOSITORIES = [
  'identity-users',
  'identity-organization-memberships',
  'identity-group-memberships',
  'conversations',
  'conversation-participants',
  'conversation-messages',
  'conversation-attachments',
  'agent-memory',
  'secrets',
  'api-keys',
  'service-accounts',
  'mcp-credentials',
  'access-requests',
  'access-grants',
  'workflow-executions',
  'workflow-steps',
  'knowledge-bases',
  'knowledge-documents',
  'knowledge-document-versions',
  'knowledge-vectors',
  'plugin-installations',
  'plugin-settings',
  'webhook-deliveries',
  'notifications',
  'data-inventory',
  'consent-records',
] as const;

const EXTERNAL_DELETION_DESTINATIONS: readonly PrivacyDataDestination[] = [
  'VECTOR_STORE',
  'SEARCH_INDEX',
  'OBJECT_STORAGE',
  'CACHE',
  'QUEUE',
  'BACKUP',
  'PLUGIN_DATA',
];

function sanitizeExportRecord(record: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key]) => !/(?:secret|token|password|hash|ciphertext|nonce)/iu.test(key),
    ),
  );
}

class RepositoryBackupTombstoneAdapter implements DataDeletionPropagationAdapter {
  readonly destination = 'BACKUP' as const;
  constructor(private readonly repository: Repository<StoredBackupTombstone>) {}

  async deleteSubject(input: DataDeletionPropagationInput): Promise<DataDeletionPropagationResult> {
    const id = `${input.organizationId}:${input.subjectId}`;
    const current = await this.repository.findById(input.organizationId, id);
    const now = new Date();
    if (current === undefined) {
      await this.repository.insert({
        id,
        tenantId: input.organizationId,
        organizationId: input.organizationId,
        subjectId: input.subjectId,
        requestId: input.requestId,
        tombstonedAt: now,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
    return {
      destination: this.destination,
      deleted: true,
      evidence: [`backup-tombstone-persisted:${id}`],
    };
  }
}

function recordBelongsToSubject(record: Record<string, unknown>, subjectId: string): boolean {
  return (
    ['id', 'userId', 'principalId', 'subjectId', 'ownerId', 'actorId', 'requesterId'].some(
      (key) => record[key] === subjectId,
    ) ||
    ['subjectIds', 'userIds', 'principalIds', 'participantIds'].some(
      (key) => Array.isArray(record[key]) && record[key].some((value) => value === subjectId),
    )
  );
}
