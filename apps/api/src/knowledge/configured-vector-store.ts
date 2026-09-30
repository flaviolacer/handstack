import type { HandStackConfig } from '@handstack/config';
import {
  ChromaVectorStore,
  MongoAtlasVectorStore,
  PineconeVectorStore,
  PgVectorStore,
  QdrantVectorStore,
  WeaviateVectorStore,
  type VectorMatch,
  type VectorStore,
  type VectorStoreAdapterKind,
} from '@handstack/knowledge';
import { MongoAdapter, TypeOrmAdapter, type DatabaseAdapter } from '@handstack/database';
import { ValidationError } from '@handstack/shared';
import type { SecretRuntimeService } from '../secrets/secret-runtime.service.js';

interface VectorInput {
  readonly organizationId: string;
  readonly id: string;
  readonly vector: readonly number[];
  readonly metadata: Readonly<Record<string, string>>;
}
interface SearchInput {
  readonly organizationId: string;
  readonly vector: readonly number[];
  readonly topK: number;
  readonly filter?: Readonly<Record<string, string>>;
}

/** Resolves configured HTTP vector providers lazily, keeping credentials out of config and records. */
export class ConfiguredVectorStore implements VectorStore {
  constructor(
    private readonly config: HandStackConfig,
    private readonly secrets: SecretRuntimeService,
    private readonly database: DatabaseAdapter,
  ) {}

  async upsert(input: VectorInput): Promise<void> {
    await this.provider(input.organizationId).then((store) => store.upsert(input));
  }
  async delete(organizationId: string, ids: readonly string[]): Promise<void> {
    await this.provider(organizationId).then((store) => store.delete(organizationId, ids));
  }
  async deleteBySubject(organizationId: string, subjectId: string): Promise<number> {
    const store = await this.provider(organizationId);
    if (store.deleteBySubject === undefined)
      throw new ValidationError(
        `Vector store ${this.config.vectorStore.adapter} does not support subject deletion`,
      );
    return store.deleteBySubject(organizationId, subjectId);
  }
  async search(input: SearchInput): Promise<readonly VectorMatch[]> {
    return this.provider(input.organizationId).then((store) => store.search(input));
  }

  private async provider(organizationId: string): Promise<VectorStore> {
    const settings = this.config.vectorStore;
    if (settings.adapter === 'pgvector') {
      if (
        !(this.database instanceof TypeOrmAdapter) ||
        this.config.database.adapter !== 'postgresql'
      )
        throw new ValidationError('pgvector requires the PostgreSQL primary adapter');
      const sqlAdapter = this.database;
      const store = new PgVectorStore({
        pool: {
          query: (sql, parameters) =>
            sqlAdapter.dataSource.query(
              sql,
              parameters === undefined ? undefined : [...parameters],
            ),
        },
      });
      await store.ensureSchema();
      return store;
    }
    if (settings.adapter === 'mongodb-atlas') {
      if (!(this.database instanceof MongoAdapter) || this.config.database.adapter !== 'mongodb')
        throw new ValidationError(
          'MongoDB Atlas Vector Search requires the MongoDB primary adapter and explicit opt-in',
        );
      return new MongoAtlasVectorStore({
        collection: this.database.nativeDatabase().collection('handstack_knowledge_vectors'),
        ...(settings.index === undefined ? {} : { index: settings.index }),
      });
    }
    const endpoint = settings.endpoint;
    const collection = settings.collection;
    if (endpoint === undefined || collection === undefined)
      throw new ValidationError(
        `Vector store ${settings.adapter} requires endpoint and collection`,
      );
    const reference = settings.credentialReference;
    const secret =
      reference === undefined || reference === ''
        ? undefined
        : await this.secrets.resolve(reference, organizationId, 'knowledge-vector');
    const options = {
      endpoint,
      collection,
      ...(settings.index === undefined ? {} : { index: settings.index }),
    };
    switch (settings.adapter as VectorStoreAdapterKind) {
      case 'qdrant':
        return new QdrantVectorStore({
          ...options,
          ...(secret === undefined ? {} : { apiKey: secret }),
        });
      case 'chroma':
        return new ChromaVectorStore({
          ...options,
          ...(secret === undefined ? {} : { apiKey: secret }),
        });
      case 'pinecone':
        if (secret === undefined || secret === '')
          throw new ValidationError('Pinecone requires a vector store credential reference');
        return new PineconeVectorStore({ endpoint, apiKey: secret });
      case 'weaviate':
        return new WeaviateVectorStore({
          ...options,
          ...(secret === undefined ? {} : { apiKey: secret }),
        });
      case 'pgvector':
      case 'mongodb-atlas':
        throw new ValidationError(
          `Vector store ${settings.adapter} requires a compatible primary database`,
        );
      default:
        throw new ValidationError(`Unsupported vector store adapter: ${settings.adapter}`);
    }
  }
}
