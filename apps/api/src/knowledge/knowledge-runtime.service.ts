import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { repositoryName, uuidV7, type Repository, type TenantEntity } from '@handstack/domain';
import {
  BearerKnowledgeSourceConnector,
  confluencePageUrl,
  extractConfluenceText,
  extractNotionText,
  googleDriveFileUrl,
  knowledgeDocumentVersionsRepository,
  GitHubKnowledgeSourceConnector,
  HttpKnowledgeSourceConnector,
  KnowledgeIngestionService,
  KnowledgeReindexJobService,
  RepositoryKnowledgeReindexJobStore,
  KnowledgeSearchService,
  KnowledgeSyncService,
  notionPageUrl,
  RepositoryKnowledgeDocumentIndex,
  RepositoryKnowledgeSyncCursorStore,
  S3KnowledgeSourceConnector,
  sharePointItemUrl,
  type Document,
  type DocumentVersion,
  type KnowledgeBase,
  type SyncOperation,
  type SyncCursor,
  type SourceAclEntry,
  type DeletionStatus,
  type VectorStore,
} from '@handstack/knowledge';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { ModelAdminRuntimeService } from '../models/model-admin-runtime.service.js';
import { RepositoryVectorStore } from './repository-vector-store.js';
import { ConfiguredVectorStore } from './configured-vector-store.js';
import { ValidationError } from '@handstack/shared';
import { SecretRuntimeService } from '../secrets/secret-runtime.service.js';
import { configFromEnvironment } from '@handstack/config';

const basesRepository = repositoryName('knowledge-bases');
const documentsRepository = repositoryName('knowledge-documents');

function normalizeDocumentDates(document: Document): Document {
  const parse = (value: Date): Date => {
    const parsed = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(parsed.getTime()))
      throw new ValidationError('Knowledge document date is invalid');
    return parsed;
  };
  return {
    ...document,
    ingestedAt: parse(document.ingestedAt),
    lastVerifiedAt: parse(document.lastVerifiedAt),
  };
}

@Injectable()
export class KnowledgeRuntimeService {
  private readonly bases: Repository<KnowledgeBase>;
  private readonly documents: Repository<Document>;
  private readonly versions: Repository<DocumentVersion>;
  private readonly vectors: VectorStore;
  private readonly index: RepositoryKnowledgeDocumentIndex;
  private readonly models: ModelAdminRuntimeService;
  private readonly sync: KnowledgeSyncService;
  private readonly reindexJobs: KnowledgeReindexJobService;
  private readonly sourceUrlGuard: (value: string) => Promise<void>;

  constructor(
    @Inject(DatabaseService) database: DatabaseService,
    @Inject(ModelAdminRuntimeService) models: ModelAdminRuntimeService,
    @Inject(SecretRuntimeService) private readonly secrets: SecretRuntimeService,
  ) {
    this.models = models;
    this.sourceUrlGuard = (value) =>
      assertSafeKnowledgeUrl(value, database.config.knowledge.allowedHosts);
    this.vectors =
      database.config.vectorStore.adapter === 'repository'
        ? new RepositoryVectorStore((name) => database.adapter.repository(name))
        : new ConfiguredVectorStore(database.config, this.secrets, database.adapter);
    this.index = new RepositoryKnowledgeDocumentIndex((name) => database.adapter.repository(name));
    this.bases = database.adapter.repository(basesRepository);
    this.documents = database.adapter.repository(documentsRepository);
    this.versions = database.adapter.repository(knowledgeDocumentVersionsRepository);
    this.sync = new KnowledgeSyncService(
      this.vectors,
      new RepositoryKnowledgeSyncCursorStore((name) => database.adapter.repository(name)),
    );
    this.reindexJobs = new KnowledgeReindexJobService(
      this.vectors,
      {
        embed: async (text, model, signal, organizationId) => {
          if (organizationId === undefined || organizationId === '')
            throw new ValidationError('Reindex embedding requires an organization scope');
          return (
            (
              await this.models.execution.embed({
                organizationId,
                model,
                dataClassification: 'INTERNAL',
                input: [text],
                ...(signal === undefined ? {} : { signal }),
              })
            ).vectors[0] ?? []
          );
        },
      },
      new RepositoryKnowledgeReindexJobStore((name) => database.adapter.repository(name)),
      {
        publish: async ({ organizationId, knowledgeBaseId, embeddingModel }) => {
          if (knowledgeBaseId === undefined)
            throw new ValidationError(
              'A knowledge base is required to publish the reindexed model',
            );
          const base = await this.bases.findById(organizationId, knowledgeBaseId);
          if (base === undefined) throw new ValidationError('Knowledge base was not found');
          await this.bases.update(
            { ...base, embeddingModel, updatedAt: new Date(), version: base.version + 1 },
            base.version,
          );
        },
      },
    );
  }

  async listBases(organizationId: string) {
    return this.listAll(this.bases, organizationId, 100);
  }

  async createBase(
    organizationId: string,
    input: Omit<
      KnowledgeBase,
      'id' | 'tenantId' | 'version' | 'createdAt' | 'updatedAt' | 'organizationId'
    >,
  ) {
    const now = new Date();
    const base: KnowledgeBase = {
      ...input,
      id: uuidV7(),
      tenantId: organizationId,
      organizationId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    return this.bases.insert(base);
  }

  async listDocuments(organizationId: string) {
    return this.listAll(this.documents, organizationId, 100);
  }

  async createReindexJob(input: {
    readonly organizationId: string;
    readonly knowledgeBaseId: string;
    readonly embeddingModel: string;
  }) {
    if ((await this.bases.findById(input.organizationId, input.knowledgeBaseId)) === undefined)
      throw new ValidationError('Knowledge base was not found');
    return this.reindexJobs.create(input);
  }

  async getReindexJob(organizationId: string, jobId: string) {
    return this.reindexJobs.get(organizationId, jobId);
  }

  runReindexJob(organizationId: string, jobId: string, signal?: AbortSignal) {
    return this.reindexJobs.run(organizationId, jobId, signal);
  }

  cancelReindexJob(organizationId: string, jobId: string) {
    return this.reindexJobs.cancel(organizationId, jobId);
  }

  async createDocument(
    organizationId: string,
    input: Omit<
      Document,
      'id' | 'tenantId' | 'version' | 'createdAt' | 'updatedAt' | 'organizationId'
    >,
  ) {
    const now = new Date();
    const document: Document = {
      ...input,
      id: uuidV7(),
      tenantId: organizationId,
      organizationId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.documents.insert(document);
    await this.versions.insert({
      id: uuidV7(),
      tenantId: organizationId,
      organizationId,
      documentId: created.id,
      documentVersion: 1,
      sourceVersion: created.sourceVersion,
      contentDigest: created.contentDigest,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    return created;
  }

  async listVersions(organizationId: string, documentId: string) {
    const versions = await this.listAll(this.versions, organizationId, 100);
    return versions.filter((version) => version.documentId === documentId);
  }

  async ingest(organizationId: string, documentId: string, content: string) {
    const storedDocument = await this.documents.findById(organizationId, documentId);
    if (storedDocument === undefined) throw new Error('Knowledge document not found');
    const document = normalizeDocumentDates(storedDocument);
    const base = await this.bases.findById(organizationId, document.knowledgeBaseId);
    if (base === undefined) throw new Error('Knowledge base not found');
    const embeddings = {
      embed: async (text: string, model: string, signal?: AbortSignal) =>
        (
          await this.models.execution.embed({
            organizationId,
            model,
            dataClassification: 'INTERNAL',
            input: [text],
            ...(signal === undefined ? {} : { signal }),
          })
        ).vectors[0] ?? [],
    };
    return new KnowledgeIngestionService(this.vectors, embeddings, undefined, this.index).ingest({
      organizationId,
      knowledgeBase: base,
      document,
      content,
    });
  }

  async search(
    organizationId: string,
    knowledgeBaseId: string,
    query: string,
    model: string,
    principalId: string,
    topK?: number,
  ) {
    const embeddings = {
      embed: async (text: string, embeddingModel: string, signal?: AbortSignal) =>
        (
          await this.models.execution.embed({
            organizationId,
            model: embeddingModel,
            dataClassification: 'INTERNAL',
            input: [text],
            ...(signal === undefined ? {} : { signal }),
          })
        ).vectors[0] ?? [],
    };
    return new KnowledgeSearchService(this.vectors, embeddings).search({
      organizationId,
      knowledgeBaseId,
      query,
      model,
      principalId,
      ...(topK === undefined ? {} : { topK }),
    });
  }

  async deleteSubjectVectors(organizationId: string, subjectId: string): Promise<number> {
    if (this.vectors.deleteBySubject === undefined)
      throw new ValidationError('Configured vector store does not support subject deletion');
    return this.vectors.deleteBySubject(organizationId, subjectId);
  }

  async deleteSubjectSearchIndex(organizationId: string, subjectId: string): Promise<number> {
    return this.index.deleteBySubject(organizationId, subjectId);
  }

  async syncUrl(organizationId: string, documentId: string) {
    const storedDocument = await this.documents.findById(organizationId, documentId);
    if (storedDocument === undefined) throw new Error('Knowledge document not found');
    const document = normalizeDocumentDates(storedDocument);
    let content: string;
    if (document.sourceType === 'S3') {
      if (document.credentialReference === undefined)
        throw new ValidationError('S3 Knowledge sources require a credential reference');
      const connector = new S3KnowledgeSourceConnector((organizationId, reference) =>
        this.secrets.resolve(reference, organizationId, 'knowledge-s3'),
      );
      content = (
        await connector.fetch({
          organizationId,
          locator: document.sourceLocator,
          credentialReference: document.credentialReference,
        })
      ).content;
    } else if (document.sourceType === 'URL' || document.sourceType === 'GITHUB') {
      const connector =
        document.sourceType === 'GITHUB'
          ? new GitHubKnowledgeSourceConnector(this.sourceUrlGuard)
          : new HttpKnowledgeSourceConnector(this.sourceUrlGuard);
      content = (await connector.fetch(document.sourceLocator)).content;
    } else {
      if (document.credentialReference === undefined)
        throw new ValidationError('Authenticated Knowledge sources require a credential reference');
      const resolveCredential = (organizationId: string, reference: string, connectorId: string) =>
        this.secrets.resolve(reference, organizationId, connectorId);
      const connector =
        document.sourceType === 'GOOGLE_DRIVE'
          ? new BearerKnowledgeSourceConnector(
              'knowledge-google-drive',
              googleDriveFileUrl,
              this.sourceUrlGuard,
              resolveCredential,
            )
          : document.sourceType === 'SHAREPOINT'
            ? new BearerKnowledgeSourceConnector(
                'knowledge-sharepoint',
                sharePointItemUrl,
                this.sourceUrlGuard,
                resolveCredential,
              )
            : document.sourceType === 'NOTION'
              ? new BearerKnowledgeSourceConnector(
                  'knowledge-notion',
                  notionPageUrl,
                  this.sourceUrlGuard,
                  resolveCredential,
                  undefined,
                  extractNotionText,
                )
              : document.sourceType === 'CONFLUENCE'
                ? new BearerKnowledgeSourceConnector(
                    'knowledge-confluence',
                    confluencePageUrl,
                    this.sourceUrlGuard,
                    resolveCredential,
                    undefined,
                    extractConfluenceText,
                  )
                : undefined;
      if (connector === undefined)
        throw new Error('No connector is configured for this source type');
      content = (
        await connector.fetch({
          organizationId,
          locator: document.sourceLocator,
          credentialReference: document.credentialReference,
        })
      ).content;
    }
    const digest = createHash('sha256').update(content, 'utf8').digest('hex');
    const now = new Date();
    if (digest === document.contentDigest) {
      const verified = {
        ...document,
        lastVerifiedAt: now,
        updatedAt: now,
        version: document.version + 1,
      };
      await this.documents.update(verified, document.version);
      return { changed: false, document: verified, chunks: [] };
    }
    if (this.vectors.deleteByDocument !== undefined)
      await this.vectors.deleteByDocument(organizationId, document.id);
    const updated = {
      ...document,
      contentDigest: digest,
      sourceVersion: digest,
      version: document.version + 1,
      updatedAt: now,
      lastVerifiedAt: now,
      ingestedAt: now,
    };
    await this.documents.update(updated, document.version);
    await this.versions.insert({
      id: uuidV7(),
      tenantId: organizationId,
      organizationId,
      documentId: document.id,
      documentVersion: updated.version,
      sourceVersion: digest,
      contentDigest: digest,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const chunks = await this.ingest(organizationId, document.id, content);
    return { changed: true, document: updated, chunks };
  }

  syncDocument(input: {
    organizationId: string;
    documentId: string;
    operation: SyncOperation;
    sourceAcl?: readonly SourceAclEntry[];
    deletionStatus?: DeletionStatus;
    lastVerifiedAt?: Date;
    cursor: SyncCursor;
  }) {
    return this.sync.apply(input);
  }

  private async listAll<T extends TenantEntity>(
    repository: Repository<T>,
    organizationId: string,
    limit: number,
  ): Promise<readonly T[]> {
    const values: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await repository.list(organizationId, {
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      values.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return values;
  }
}

export async function assertSafeKnowledgeUrl(
  value: string,
  configuredAllowlist?: readonly string[],
): Promise<void> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError('Knowledge source URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
    throw new ValidationError('Knowledge source must use HTTPS without embedded credentials');
  const allowlist = (
    configuredAllowlist ?? configFromEnvironment(process.env).knowledge.allowedHosts
  )
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '');
  if (allowlist.length > 0 && !allowlist.includes(url.hostname.toLowerCase()))
    throw new ValidationError('Knowledge source host is not allowlisted');
  let addresses: readonly { address: string }[];
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new ValidationError('Knowledge source host could not be resolved');
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address)))
    throw new ValidationError('Knowledge source resolves to a private or local address');
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    const [first, second] = octets;
    return (
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      first === 0
    );
  }
  const normalized = address.toLowerCase();
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:192.168.')
  );
}
