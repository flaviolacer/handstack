import {
  repositoryName,
  uuidV7,
  type Repository,
  type RepositoryName,
  type TenantEntity,
} from '@handstack/domain';
import { ValidationError } from '@handstack/shared';

export type DataSourceType =
  | 'FILE'
  | 'URL'
  | 'TEXT'
  | 'GOOGLE_DRIVE'
  | 'SHAREPOINT'
  | 'CONFLUENCE'
  | 'NOTION'
  | 'GITHUB'
  | 'S3'
  | 'DATABASE';
export type ChunkingStrategy = 'CHARACTER' | 'TOKEN' | 'PARAGRAPH';
export type DataResidency = string;
export type DeletionStatus = 'ACTIVE' | 'PENDING' | 'DELETED';
export type SyncOperation = 'UPSERT' | 'DELETE' | 'PERMISSION_CHANGED';

export interface KnowledgeRetentionPolicy {
  readonly retentionDays: number;
  readonly legalHold: boolean;
}

export interface SyncCursor {
  readonly connector: string;
  readonly token: string;
  readonly issuedAt: Date;
}

export const knowledgeDocumentIndexRepository = repositoryName('knowledge-document-index');
export const knowledgeSyncCursorRepository = repositoryName('knowledge-sync-cursors');
export const knowledgeReindexJobRepository = repositoryName('knowledge-reindex-jobs');

export interface KnowledgeCitation {
  readonly chunkId: string;
  readonly documentId: string;
  readonly sourceId: string;
  readonly sourceLocator: string;
  readonly title: string;
  readonly ordinal: number;
  readonly quote: string;
  readonly score: number;
  readonly stale: boolean;
}

export interface SourceAclEntry {
  readonly principalId: string;
  readonly permissions: readonly ('read' | 'admin')[];
}

export interface KnowledgeBase extends TenantEntity {
  readonly organizationId: string;
  readonly name: string;
  readonly description: string;
  readonly chunkSize: number;
  readonly chunkOverlap: number;
  readonly strategy: ChunkingStrategy;
  readonly metadataExtraction: boolean;
  readonly embeddingModel: string;
}

export interface Document extends TenantEntity {
  readonly organizationId: string;
  readonly knowledgeBaseId: string;
  readonly sourceType: DataSourceType;
  readonly sourceLocator: string;
  readonly title: string;
  readonly contentDigest: string;
  readonly version: number;
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly sourceAcl: readonly SourceAclEntry[];
  readonly classification: DataClassification;
  readonly residency: DataResidency;
  readonly ingestedAt: Date;
  readonly lastVerifiedAt: Date;
  readonly retentionPolicy: KnowledgeRetentionPolicy;
  readonly deletionStatus: DeletionStatus;
}

export interface Chunk extends TenantEntity {
  readonly organizationId: string;
  readonly knowledgeBaseId: string;
  readonly documentId: string;
  readonly ordinal: number;
  readonly text: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly sourceAcl: readonly SourceAclEntry[];
  readonly classification: DataClassification;
  readonly residency: DataResidency;
  readonly contentDigest: string;
  readonly ingestedAt: Date;
  readonly lastVerifiedAt: Date;
  readonly retentionPolicy: KnowledgeRetentionPolicy;
  readonly deletionStatus: DeletionStatus;
}

export interface Embedding extends TenantEntity {
  readonly organizationId: string;
  readonly chunkId: string;
  readonly model: string;
  readonly vector: readonly number[];
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly sourceAcl: readonly SourceAclEntry[];
  readonly classification: DataClassification;
  readonly residency: DataResidency;
  readonly contentDigest: string;
  readonly ingestedAt: Date;
  readonly lastVerifiedAt: Date;
  readonly retentionPolicy: KnowledgeRetentionPolicy;
  readonly deletionStatus: DeletionStatus;
}

export type DataClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

export interface IngestionPolicyInput {
  readonly organizationId: string;
  readonly classification: DataClassification;
  readonly sourceAcl: readonly SourceAclEntry[];
  readonly content: string;
}
export interface RetrievalPolicyInput {
  readonly organizationId: string;
  readonly principalId: string;
  readonly classification: DataClassification;
  readonly matches: readonly VectorMatch[];
}
export interface RetrievalPolicyResult {
  readonly allowedIds: readonly string[];
  readonly staleIds: readonly string[];
}
export interface RetrievalRevalidationInput {
  readonly organizationId: string;
  readonly principalId: string;
  readonly classification: DataClassification;
  readonly matches: readonly VectorMatch[];
}
export interface RagPolicyProvider {
  authorizeIngestion(
    input: IngestionPolicyInput,
  ): Promise<{ readonly allowed: boolean; readonly reason?: string }>;
  filterRetrieval(input: RetrievalPolicyInput): Promise<RetrievalPolicyResult>;
  revalidateRetrieval?(input: RetrievalRevalidationInput): Promise<RetrievalPolicyResult>;
}

export class InMemoryRagPolicyProvider implements RagPolicyProvider {
  authorizeIngestion(input: IngestionPolicyInput) {
    if (input.organizationId === '' || input.sourceAcl.length === 0)
      return Promise.resolve({ allowed: false, reason: 'Source ACL is required' });
    if (containsUnsafeContent(input.content))
      return Promise.resolve({
        allowed: false,
        reason: 'Content contains PII, secret, or prompt injection markers',
      });
    return Promise.resolve({ allowed: true });
  }

  filterRetrieval(input: RetrievalPolicyInput): Promise<RetrievalPolicyResult> {
    const allowed = input.matches.filter((match) => {
      const acl = match.metadata.sourceAcl ?? '';
      return acl
        .split(',')
        .some((principal) => principal === input.principalId || principal === '*');
    });
    const now = Date.now();
    const staleIds = allowed
      .filter((match) => Number(match.metadata.lastVerifiedAt ?? 0) < now - 86_400_000)
      .map((match) => match.id);
    return Promise.resolve({ allowedIds: allowed.map((match) => match.id), staleIds });
  }

  revalidateRetrieval(input: RetrievalRevalidationInput) {
    return this.filterRetrieval({ ...input, matches: input.matches });
  }
}

export interface DataSource {
  readonly type: DataSourceType;
  readonly locator: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface EmbeddingProvider {
  embed(text: string, model: string, signal?: AbortSignal): Promise<readonly number[]>;
}

export interface KnowledgeDocumentIndex {
  findBySourceAndDigest(input: {
    readonly organizationId: string;
    readonly knowledgeBaseId: string;
    readonly sourceId: string;
    readonly contentDigest: string;
  }): Promise<readonly Chunk[] | undefined>;
  save(input: {
    readonly organizationId: string;
    readonly knowledgeBaseId: string;
    readonly sourceId: string;
    readonly contentDigest: string;
    readonly chunks: readonly Chunk[];
  }): Promise<void>;
}

interface KnowledgeDocumentIndexRecord extends TenantEntity {
  readonly organizationId: string;
  readonly knowledgeBaseId: string;
  readonly sourceId: string;
  readonly contentDigest: string;
  readonly chunks: readonly Chunk[];
}

interface KnowledgeSyncCursorRecord extends TenantEntity {
  readonly organizationId: string;
  readonly connector: string;
  readonly token: string;
  readonly issuedAt: Date;
}

function indexRecordId(input: {
  readonly organizationId: string;
  readonly knowledgeBaseId: string;
  readonly sourceId: string;
  readonly contentDigest: string;
}): string {
  return [input.organizationId, input.knowledgeBaseId, input.sourceId, input.contentDigest]
    .map((part) => encodeURIComponent(part))
    .join(':');
}

function cursorRecordId(organizationId: string, connector: string): string {
  return `${encodeURIComponent(organizationId)}:${encodeURIComponent(connector)}`;
}

/** Repository-backed source/hash index. The repository enforces tenant scope and survives restarts. */
export class RepositoryKnowledgeDocumentIndex implements KnowledgeDocumentIndex {
  private readonly repository: Repository<KnowledgeDocumentIndexRecord>;

  constructor(
    repositoryFactory: <T extends TenantEntity>(name: RepositoryName) => Repository<T>,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.repository = repositoryFactory<KnowledgeDocumentIndexRecord>(
      knowledgeDocumentIndexRepository,
    );
  }

  async findBySourceAndDigest(input: {
    readonly organizationId: string;
    readonly knowledgeBaseId: string;
    readonly sourceId: string;
    readonly contentDigest: string;
  }): Promise<readonly Chunk[] | undefined> {
    const record = await this.repository.findById(input.organizationId, indexRecordId(input));
    return record?.chunks;
  }

  async save(input: {
    readonly organizationId: string;
    readonly knowledgeBaseId: string;
    readonly sourceId: string;
    readonly contentDigest: string;
    readonly chunks: readonly Chunk[];
  }): Promise<void> {
    const id = indexRecordId(input);
    const existing = await this.repository.findById(input.organizationId, id);
    const now = this.now();
    const record: KnowledgeDocumentIndexRecord = {
      id,
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      knowledgeBaseId: input.knowledgeBaseId,
      sourceId: input.sourceId,
      contentDigest: input.contentDigest,
      chunks: input.chunks,
      version: existing?.version ?? 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing === undefined) await this.repository.insert(record);
    else await this.repository.update(record, existing.version);
  }
}

export interface KnowledgeSyncCursorStore {
  get(organizationId: string, connector: string): Promise<SyncCursor | undefined>;
  save(organizationId: string, cursor: SyncCursor): Promise<void>;
}

export type ReindexJobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface KnowledgeReindexJob extends TenantEntity {
  readonly organizationId: string;
  readonly embeddingModel: string;
  readonly knowledgeBaseId?: string;
  readonly status: ReindexJobStatus;
  readonly cursor: number;
  readonly scanned: number;
  readonly reindexed: number;
  readonly skipped: number;
  readonly cancelRequested: boolean;
  readonly activeModelPublished: boolean;
  readonly error?: string;
}

export interface KnowledgeReindexJobStore {
  get(organizationId: string, jobId: string): Promise<KnowledgeReindexJob | undefined>;
  save(job: KnowledgeReindexJob, expectedVersion?: number): Promise<KnowledgeReindexJob>;
}

export interface KnowledgeActiveModelPublisher {
  publish(input: {
    readonly organizationId: string;
    readonly knowledgeBaseId?: string;
    readonly embeddingModel: string;
  }): Promise<void>;
}

export class RepositoryKnowledgeReindexJobStore implements KnowledgeReindexJobStore {
  private readonly repository: Repository<KnowledgeReindexJob>;

  constructor(repositoryFactory: <T extends TenantEntity>(name: RepositoryName) => Repository<T>) {
    this.repository = repositoryFactory<KnowledgeReindexJob>(knowledgeReindexJobRepository);
  }

  get(organizationId: string, jobId: string) {
    return this.repository.findById(organizationId, jobId);
  }

  async save(job: KnowledgeReindexJob, expectedVersion?: number) {
    const current = await this.repository.findById(job.organizationId, job.id);
    if (current === undefined) return this.repository.insert(job);
    return this.repository.update(
      { ...job, version: current.version + 1, createdAt: current.createdAt },
      expectedVersion ?? current.version,
    );
  }
}

export class InMemoryKnowledgeReindexJobStore implements KnowledgeReindexJobStore {
  private readonly values = new Map<string, KnowledgeReindexJob>();

  get(organizationId: string, jobId: string) {
    return Promise.resolve(this.values.get(`${organizationId}:${jobId}`));
  }

  save(job: KnowledgeReindexJob, expectedVersion?: number) {
    const key = `${job.organizationId}:${job.id}`;
    const current = this.values.get(key);
    if (
      current !== undefined &&
      expectedVersion !== undefined &&
      current.version !== expectedVersion
    )
      return Promise.reject(new ValidationError('Reindex job version conflict'));
    const saved =
      current === undefined
        ? job
        : { ...job, version: current.version + 1, createdAt: current.createdAt };
    this.values.set(key, saved);
    return Promise.resolve(saved);
  }
}

/** Repository-backed cursor store used to resume connector sync after process restarts. */
export class RepositoryKnowledgeSyncCursorStore implements KnowledgeSyncCursorStore {
  private readonly repository: Repository<KnowledgeSyncCursorRecord>;

  constructor(
    repositoryFactory: <T extends TenantEntity>(name: RepositoryName) => Repository<T>,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.repository = repositoryFactory<KnowledgeSyncCursorRecord>(knowledgeSyncCursorRepository);
  }

  async get(organizationId: string, connector: string): Promise<SyncCursor | undefined> {
    const record = await this.repository.findById(
      organizationId,
      cursorRecordId(organizationId, connector),
    );
    return record === undefined
      ? undefined
      : { connector: record.connector, token: record.token, issuedAt: record.issuedAt };
  }

  async save(organizationId: string, cursor: SyncCursor): Promise<void> {
    const id = cursorRecordId(organizationId, cursor.connector);
    const existing = await this.repository.findById(organizationId, id);
    const now = this.now();
    const record: KnowledgeSyncCursorRecord = {
      id,
      tenantId: organizationId,
      organizationId,
      connector: cursor.connector,
      token: cursor.token,
      issuedAt: cursor.issuedAt,
      version: existing?.version ?? 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing === undefined) await this.repository.insert(record);
    else await this.repository.update(record, existing.version);
  }
}

export class InMemoryKnowledgeDocumentIndex implements KnowledgeDocumentIndex {
  private readonly values = new Map<string, readonly Chunk[]>();

  findBySourceAndDigest(input: {
    organizationId: string;
    knowledgeBaseId: string;
    sourceId: string;
    contentDigest: string;
  }) {
    return Promise.resolve(
      this.values.get(
        [input.organizationId, input.knowledgeBaseId, input.sourceId, input.contentDigest].join(
          ':',
        ),
      ),
    );
  }

  save(input: {
    organizationId: string;
    knowledgeBaseId: string;
    sourceId: string;
    contentDigest: string;
    chunks: readonly Chunk[];
  }) {
    this.values.set(
      [input.organizationId, input.knowledgeBaseId, input.sourceId, input.contentDigest].join(':'),
      input.chunks,
    );
    return Promise.resolve();
  }
}

export interface VectorMatch {
  readonly id: string;
  readonly score: number;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface VectorStore {
  upsert(input: {
    readonly organizationId: string;
    readonly id: string;
    readonly vector: readonly number[];
    readonly metadata: Readonly<Record<string, string>>;
  }): Promise<void>;
  delete(organizationId: string, ids: readonly string[]): Promise<void>;
  deleteByDocument?(organizationId: string, documentId: string): Promise<void>;
  updateByDocument?(input: {
    readonly organizationId: string;
    readonly documentId: string;
    readonly sourceAcl: readonly SourceAclEntry[];
    readonly deletionStatus: DeletionStatus;
    readonly lastVerifiedAt: Date;
  }): Promise<void>;
  listByOrganization?(input: {
    readonly organizationId: string;
    readonly knowledgeBaseId?: string;
  }): Promise<readonly VectorMatch[]>;
  search(input: {
    readonly organizationId: string;
    readonly vector: readonly number[];
    readonly topK: number;
    readonly filter?: Readonly<Record<string, string>>;
  }): Promise<readonly VectorMatch[]>;
}

export class InMemoryVectorStore implements VectorStore {
  private readonly values = new Map<
    string,
    { vector: readonly number[]; metadata: Readonly<Record<string, string>> }
  >();

  upsert(input: {
    organizationId: string;
    id: string;
    vector: readonly number[];
    metadata: Readonly<Record<string, string>>;
  }) {
    if (input.organizationId === '') throw new ValidationError('Vector organization is required');
    this.values.set(`${input.organizationId}:${input.id}`, {
      vector: [...input.vector],
      metadata: input.metadata,
    });
    return Promise.resolve();
  }

  delete(organizationId: string, ids: readonly string[]) {
    for (const id of ids) this.values.delete(`${organizationId}:${id}`);
    return Promise.resolve();
  }

  deleteByDocument(organizationId: string, documentId: string) {
    for (const [key, value] of this.values)
      if (key.startsWith(`${organizationId}:`) && value.metadata.documentId === documentId)
        this.values.delete(key);
    return Promise.resolve();
  }

  updateByDocument(input: {
    organizationId: string;
    documentId: string;
    sourceAcl: readonly SourceAclEntry[];
    deletionStatus: DeletionStatus;
    lastVerifiedAt: Date;
  }) {
    for (const [key, value] of this.values) {
      if (
        key.startsWith(`${input.organizationId}:`) &&
        value.metadata.documentId === input.documentId
      ) {
        this.values.set(key, {
          ...value,
          metadata: {
            ...value.metadata,
            sourceAcl: input.sourceAcl.map((entry) => entry.principalId).join(','),
            deletionStatus: input.deletionStatus,
            lastVerifiedAt: String(input.lastVerifiedAt.getTime()),
          },
        });
      }
    }
    return Promise.resolve();
  }

  search(input: {
    organizationId: string;
    vector: readonly number[];
    topK: number;
    filter?: Readonly<Record<string, string>>;
  }) {
    if (input.topK < 1 || input.topK > 100)
      throw new ValidationError('Vector topK must be between 1 and 100');
    const matches = [...this.values.entries()]
      .filter(
        ([key, value]) =>
          key.startsWith(`${input.organizationId}:`) && matchesFilter(value.metadata, input.filter),
      )
      .map(([key, value]) => ({
        id: key.slice(input.organizationId.length + 1),
        score: cosine(input.vector, value.vector),
        metadata: value.metadata,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, input.topK);
    return Promise.resolve(matches);
  }

  listByOrganization(input: { organizationId: string; knowledgeBaseId?: string }) {
    return Promise.resolve(
      [...this.values.entries()]
        .filter(
          ([key, value]) =>
            key.startsWith(`${input.organizationId}:`) &&
            (input.knowledgeBaseId === undefined ||
              value.metadata.knowledgeBaseId === input.knowledgeBaseId),
        )
        .map(([key, value]) => ({
          id: key.slice(input.organizationId.length + 1),
          score: 0,
          metadata: value.metadata,
        })),
    );
  }
}

export function chunkText(
  text: string,
  config: Pick<KnowledgeBase, 'chunkSize' | 'chunkOverlap' | 'strategy'>,
): readonly string[] {
  if (config.chunkSize < 1 || config.chunkOverlap < 0 || config.chunkOverlap >= config.chunkSize)
    throw new ValidationError('Invalid chunk size or overlap');
  if (config.strategy === 'PARAGRAPH')
    return paragraphChunks(text, config.chunkSize, config.chunkOverlap);
  const units = config.strategy === 'TOKEN' ? text.split(/\s+/u).filter(Boolean) : Array.from(text);
  const chunks: string[] = [];
  for (let start = 0; start < units.length; start += config.chunkSize - config.chunkOverlap) {
    const part = units.slice(start, start + config.chunkSize);
    if (part.length === 0) break;
    chunks.push(config.strategy === 'TOKEN' ? part.join(' ') : part.join(''));
  }
  return chunks;
}

export class KnowledgeIngestionService {
  constructor(
    private readonly vectors: VectorStore,
    private readonly embeddings: EmbeddingProvider,
    private readonly policy: RagPolicyProvider = new InMemoryRagPolicyProvider(),
    private readonly documents?: KnowledgeDocumentIndex,
  ) {}

  async ingest(input: {
    readonly organizationId: string;
    readonly knowledgeBase: KnowledgeBase;
    readonly document: Document;
    readonly content: string;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  }): Promise<readonly Chunk[]> {
    if (
      input.document.organizationId !== input.organizationId ||
      input.knowledgeBase.organizationId !== input.organizationId
    )
      throw new ValidationError('Knowledge organization mismatch');
    const decision = await this.policy.authorizeIngestion({
      organizationId: input.organizationId,
      classification: input.document.classification,
      sourceAcl: input.document.sourceAcl,
      content: input.content,
    });
    if (!decision.allowed)
      throw new ValidationError(decision.reason ?? 'Knowledge ingestion denied');
    const contentDigest = input.document.contentDigest;
    const existing = await this.documents?.findBySourceAndDigest({
      organizationId: input.organizationId,
      knowledgeBaseId: input.knowledgeBase.id,
      sourceId: input.document.sourceId,
      contentDigest,
    });
    if (existing !== undefined) return existing;
    const chunks = chunkText(input.content, input.knowledgeBase).map((text, ordinal) => ({
      id: uuidV7(),
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      knowledgeBaseId: input.knowledgeBase.id,
      documentId: input.document.id,
      ordinal,
      text,
      metadata: input.metadata ?? {},
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      sourceId: input.document.sourceId,
      sourceVersion: input.document.sourceVersion,
      sourceAcl: input.document.sourceAcl,
      classification: input.document.classification,
      residency: input.document.residency,
      contentDigest: input.document.contentDigest,
      ingestedAt: input.document.ingestedAt,
      lastVerifiedAt: input.document.lastVerifiedAt,
      retentionPolicy: input.document.retentionPolicy,
      deletionStatus: input.document.deletionStatus,
    }));
    for (const chunk of chunks) {
      const vector = await this.embeddings.embed(
        chunk.text,
        input.knowledgeBase.embeddingModel,
        input.signal,
      );
      await this.vectors.upsert({
        organizationId: input.organizationId,
        id: chunk.id,
        vector,
        metadata: {
          ...chunk.metadata,
          knowledgeBaseId: chunk.knowledgeBaseId,
          documentId: chunk.documentId,
          sourceId: chunk.sourceId,
          sourceVersion: chunk.sourceVersion,
          sourceLocator: input.document.sourceLocator,
          title: input.document.title,
          ordinal: String(chunk.ordinal),
          quote: chunk.text,
          sourceAcl: chunk.sourceAcl.map((entry) => entry.principalId).join(','),
          classification: chunk.classification,
          residency: chunk.residency,
          contentDigest: chunk.contentDigest,
          ingestedAt: chunk.ingestedAt.toISOString(),
          lastVerifiedAt: String(chunk.lastVerifiedAt.getTime()),
          retentionDays: String(chunk.retentionPolicy.retentionDays),
          retentionLegalHold: String(chunk.retentionPolicy.legalHold),
          deletionStatus: chunk.deletionStatus,
          embeddingModel: input.knowledgeBase.embeddingModel,
        },
      });
    }
    await this.documents?.save({
      organizationId: input.organizationId,
      knowledgeBaseId: input.knowledgeBase.id,
      sourceId: input.document.sourceId,
      contentDigest,
      chunks,
    });
    return chunks;
  }
}

export interface ReindexResult {
  readonly organizationId: string;
  readonly embeddingModel: string;
  readonly scanned: number;
  readonly reindexed: number;
  readonly skipped: number;
}

export class KnowledgeReindexService {
  constructor(
    private readonly vectors: VectorStore,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async migrate(input: {
    readonly organizationId: string;
    readonly embeddingModel: string;
    readonly knowledgeBaseId?: string;
    readonly signal?: AbortSignal;
  }): Promise<ReindexResult> {
    if (input.organizationId === '' || input.embeddingModel === '')
      throw new ValidationError('Reindex organization and embedding model are required');
    if (this.vectors.listByOrganization === undefined)
      throw new ValidationError('Vector store does not support reindexing');
    const matches = await this.vectors.listByOrganization({
      organizationId: input.organizationId,
      ...(input.knowledgeBaseId === undefined ? {} : { knowledgeBaseId: input.knowledgeBaseId }),
    });
    let reindexed = 0;
    for (const match of matches) {
      if (match.metadata.embeddingModel === input.embeddingModel) continue;
      const text = match.metadata.quote ?? '';
      const vector = await this.embeddings.embed(text, input.embeddingModel, input.signal);
      await this.vectors.upsert({
        organizationId: input.organizationId,
        id: match.id,
        vector,
        metadata: { ...match.metadata, embeddingModel: input.embeddingModel },
      });
      reindexed += 1;
    }
    return {
      organizationId: input.organizationId,
      embeddingModel: input.embeddingModel,
      scanned: matches.length,
      reindexed,
      skipped: matches.length - reindexed,
    };
  }
}

/** Durable, resumable reindex workflow. A model is published only after every chunk succeeds. */
export class KnowledgeReindexJobService {
  constructor(
    private readonly vectors: VectorStore,
    private readonly embeddings: EmbeddingProvider,
    private readonly jobs: KnowledgeReindexJobStore,
    private readonly publisher: KnowledgeActiveModelPublisher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: {
    readonly organizationId: string;
    readonly embeddingModel: string;
    readonly knowledgeBaseId?: string;
    readonly jobId?: string;
  }): Promise<KnowledgeReindexJob> {
    if (input.organizationId === '' || input.embeddingModel === '')
      throw new ValidationError('Reindex organization and embedding model are required');
    const now = this.now();
    return this.jobs.save({
      id: input.jobId ?? uuidV7(),
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      embeddingModel: input.embeddingModel,
      ...(input.knowledgeBaseId === undefined ? {} : { knowledgeBaseId: input.knowledgeBaseId }),
      status: 'PENDING',
      cursor: 0,
      scanned: 0,
      reindexed: 0,
      skipped: 0,
      cancelRequested: false,
      activeModelPublished: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  async cancel(organizationId: string, jobId: string): Promise<KnowledgeReindexJob> {
    const job = await this.jobs.get(organizationId, jobId);
    if (job === undefined) throw new ValidationError('Reindex job was not found');
    if (job.status === 'SUCCEEDED' || job.status === 'FAILED' || job.status === 'CANCELLED')
      return job;
    return this.jobs.save({ ...job, cancelRequested: true, updatedAt: this.now() }, job.version);
  }

  async run(
    organizationId: string,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<KnowledgeReindexJob> {
    const initial = await this.jobs.get(organizationId, jobId);
    if (initial === undefined) throw new ValidationError('Reindex job was not found');
    if (initial.organizationId !== organizationId)
      throw new ValidationError('Reindex organization mismatch');
    if (initial.status === 'SUCCEEDED' || initial.status === 'CANCELLED') return initial;
    if (this.vectors.listByOrganization === undefined)
      throw new ValidationError('Vector store does not support reindexing');
    let job = await this.jobs.save(
      { ...initial, status: 'RUNNING', updatedAt: this.now() },
      initial.version,
    );
    try {
      const matches = await this.vectors.listByOrganization({
        organizationId,
        ...(job.knowledgeBaseId === undefined ? {} : { knowledgeBaseId: job.knowledgeBaseId }),
      });
      for (let index = job.cursor; index < matches.length; index += 1) {
        if (signal?.aborted || job.cancelRequested) {
          job = await this.jobs.save(
            { ...job, status: 'CANCELLED', updatedAt: this.now() },
            job.version,
          );
          return job;
        }
        const match = matches[index];
        if (match === undefined) continue;
        const alreadyCurrent = match.metadata.embeddingModel === job.embeddingModel;
        if (!alreadyCurrent) {
          const vector = await this.embeddings.embed(
            match.metadata.quote ?? '',
            job.embeddingModel,
            signal,
          );
          await this.vectors.upsert({
            organizationId,
            id: match.id,
            vector,
            metadata: { ...match.metadata, embeddingModel: job.embeddingModel },
          });
        }
        const latest = await this.jobs.get(organizationId, job.id);
        if (latest !== undefined) job = latest;
        if (signal?.aborted || job.cancelRequested) {
          return await this.jobs.save(
            { ...job, status: 'CANCELLED', updatedAt: this.now() },
            job.version,
          );
        }
        job = await this.jobs.save(
          {
            ...job,
            cursor: index + 1,
            scanned: job.scanned + 1,
            reindexed: job.reindexed + (alreadyCurrent ? 0 : 1),
            skipped: job.skipped + (alreadyCurrent ? 1 : 0),
            updatedAt: this.now(),
          },
          job.version,
        );
      }
      if (signal?.aborted || job.cancelRequested) {
        return await this.jobs.save(
          { ...job, status: 'CANCELLED', updatedAt: this.now() },
          job.version,
        );
      }
      await this.publisher.publish({
        organizationId,
        ...(job.knowledgeBaseId === undefined ? {} : { knowledgeBaseId: job.knowledgeBaseId }),
        embeddingModel: job.embeddingModel,
      });
      return await this.jobs.save(
        { ...job, status: 'SUCCEEDED', activeModelPublished: true, updatedAt: this.now() },
        job.version,
      );
    } catch (error) {
      return this.jobs.save(
        {
          ...job,
          status: 'FAILED',
          error: error instanceof Error ? error.message : 'Reindex failed',
          updatedAt: this.now(),
        },
        job.version,
      );
    }
  }
}

export class KnowledgeSearchService {
  constructor(
    private readonly vectors: VectorStore,
    private readonly embeddings: EmbeddingProvider,
    private readonly policy: RagPolicyProvider = new InMemoryRagPolicyProvider(),
  ) {}
  async search(input: {
    readonly organizationId: string;
    readonly knowledgeBaseId: string;
    readonly query: string;
    readonly model: string;
    readonly principalId: string;
    readonly classification?: DataClassification;
    readonly topK?: number;
    readonly signal?: AbortSignal;
  }) {
    const vector = await this.embeddings.embed(input.query, input.model, input.signal);
    const matches = await this.vectors.search({
      organizationId: input.organizationId,
      vector,
      topK: input.topK ?? 5,
      filter: { knowledgeBaseId: input.knowledgeBaseId },
    });
    const policyInput = {
      organizationId: input.organizationId,
      principalId: input.principalId,
      classification: input.classification ?? 'INTERNAL',
      matches,
    } as const;
    const decision = await this.policy.filterRetrieval(policyInput);
    const revalidated =
      policyInput.classification === 'RESTRICTED'
        ? this.policy.revalidateRetrieval === undefined
          ? Promise.reject(new ValidationError('Restricted retrieval requires policy revalidation'))
          : this.policy.revalidateRetrieval(policyInput)
        : Promise.resolve(decision);
    const finalDecision = await revalidated;
    const allowed = new Set(finalDecision.allowedIds);
    const stale = new Set(finalDecision.staleIds);
    return matches
      .filter((match) => allowed.has(match.id))
      .map((match) => {
        const isStale = stale.has(match.id);
        return {
          ...match,
          metadata: { ...match.metadata, stale: isStale ? 'true' : 'false' },
          citation: {
            chunkId: match.id,
            documentId: match.metadata.documentId ?? '',
            sourceId: match.metadata.sourceId ?? '',
            sourceLocator: match.metadata.sourceLocator ?? '',
            title: match.metadata.title ?? '',
            ordinal: Number(match.metadata.ordinal ?? 0),
            quote: match.metadata.quote ?? '',
            score: match.score,
            stale: isStale,
          } satisfies KnowledgeCitation,
        };
      });
  }
}

export class KnowledgeSyncService {
  constructor(
    private readonly vectors: VectorStore,
    private readonly cursors?: KnowledgeSyncCursorStore,
  ) {}

  async apply(input: {
    readonly organizationId: string;
    readonly documentId: string;
    readonly operation: SyncOperation;
    readonly sourceAcl?: readonly SourceAclEntry[];
    readonly deletionStatus?: DeletionStatus;
    readonly lastVerifiedAt?: Date;
    readonly cursor: SyncCursor;
  }): Promise<SyncCursor> {
    if (input.organizationId === '' || input.documentId === '' || input.cursor.token === '')
      throw new ValidationError('Knowledge sync identity and cursor are required');
    const previous = await this.cursors?.get(input.organizationId, input.cursor.connector);
    if (previous?.token === input.cursor.token) return previous;
    if (input.operation === 'DELETE') {
      if (this.vectors.deleteByDocument === undefined)
        throw new ValidationError('Vector store does not support deletion propagation');
      await this.vectors.deleteByDocument(input.organizationId, input.documentId);
    } else {
      if (this.vectors.updateByDocument === undefined)
        throw new ValidationError('Vector store does not support permission propagation');
      if (input.sourceAcl === undefined || input.lastVerifiedAt === undefined)
        throw new ValidationError('Permission sync requires ACL and verification timestamp');
      await this.vectors.updateByDocument({
        organizationId: input.organizationId,
        documentId: input.documentId,
        sourceAcl: input.sourceAcl,
        deletionStatus: input.deletionStatus ?? 'ACTIVE',
        lastVerifiedAt: input.lastVerifiedAt,
      });
    }
    await this.cursors?.save(input.organizationId, input.cursor);
    return input.cursor;
  }
}

function containsUnsafeContent(content: string): boolean {
  return /ignore\s+(?:all\s+)?previous\s+instructions|\bAKIA[0-9A-Z]{16}\b|bearer\s+[a-z0-9._-]{20,}|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/iu.test(
    content,
  );
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

function matchesFilter(
  metadata: Readonly<Record<string, string>>,
  filter?: Readonly<Record<string, string>>,
): boolean {
  return (
    filter === undefined || Object.entries(filter).every(([key, value]) => metadata[key] === value)
  );
}

function paragraphChunks(text: string, size: number, overlap: number): readonly string[] {
  const paragraphs = text
    .split(/\n\s*\n/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const output: string[] = [];
  for (let index = 0; index < paragraphs.length; index += Math.max(1, size - overlap))
    output.push(paragraphs.slice(index, index + size).join('\n\n'));
  return output;
}
