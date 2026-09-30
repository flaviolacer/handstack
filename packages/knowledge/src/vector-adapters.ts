import { ValidationError } from '@handstack/shared';
import type { Collection } from 'mongodb';
import type { VectorMatch, VectorStore } from './index.js';

/** Backends named by the product specification. */
export type VectorStoreAdapterKind =
  'pgvector' | 'mongodb-atlas' | 'qdrant' | 'pinecone' | 'weaviate' | 'chroma';

/** Provider boundary for a configured vector backend. */
export interface VectorStoreProvider extends VectorStore {
  readonly kind: VectorStoreAdapterKind;
  readonly configured: boolean;
}

export interface VectorStoreProviderFactory {
  create(kind: VectorStoreAdapterKind): VectorStoreProvider;
}

export interface VectorHttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export interface VectorHttpTransport {
  request(input: {
    readonly method: 'DELETE' | 'GET' | 'POST' | 'PUT';
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: unknown;
  }): Promise<VectorHttpResponse>;
}

export interface PineconeVectorStoreOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly transport?: VectorHttpTransport;
}

/** Pinecone data-plane adapter; organizationId is the namespace boundary. */
export class PineconeVectorStore implements VectorStoreProvider {
  readonly kind = 'pinecone' as const;
  readonly configured = true;
  private readonly base: string;
  private readonly transport: VectorHttpTransport;

  constructor(private readonly options: PineconeVectorStoreOptions) {
    this.base = endpoint(options.endpoint);
    this.transport = options.transport ?? fetchTransport();
    if (options.apiKey.trim() === '') throw new ValidationError('Pinecone API key is required');
  }

  async upsert(input: {
    organizationId: string;
    id: string;
    vector: readonly number[];
    metadata: Readonly<Record<string, string>>;
  }): Promise<void> {
    await assertOk(
      await this.transport.request({
        method: 'POST',
        url: `${this.base}/vectors/upsert`,
        headers: this.headers(),
        body: {
          namespace: input.organizationId,
          vectors: [
            {
              id: input.id,
              values: input.vector,
              metadata: { ...input.metadata, organizationId: input.organizationId },
            },
          ],
        },
      }),
      'Pinecone',
    );
  }

  async delete(organizationId: string, ids: readonly string[]): Promise<void> {
    await assertOk(
      await this.transport.request({
        method: 'POST',
        url: `${this.base}/vectors/delete`,
        headers: this.headers(),
        body: { namespace: organizationId, ids },
      }),
      'Pinecone',
    );
  }
  async deleteBySubject(organizationId: string, subjectId: string): Promise<number> {
    await assertOk(
      await this.transport.request({
        method: 'POST',
        url: `${this.base}/vectors/delete`,
        headers: this.headers(),
        body: {
          namespace: organizationId,
          filter: { organizationId: { $eq: organizationId }, subjectId: { $eq: subjectId } },
        },
      }),
      'Pinecone',
    );
    return 0;
  }

  async search(input: {
    organizationId: string;
    vector: readonly number[];
    topK: number;
    filter?: Readonly<Record<string, string>>;
  }): Promise<readonly VectorMatch[]> {
    if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 100)
      throw new RangeError('Vector topK must be between 1 and 100');
    const body = await assertOk(
      await this.transport.request({
        method: 'POST',
        url: `${this.base}/query`,
        headers: this.headers(),
        body: {
          namespace: input.organizationId,
          vector: input.vector,
          topK: input.topK,
          includeMetadata: true,
          filter: { ...(input.filter ?? {}), organizationId: input.organizationId },
        },
      }),
      'Pinecone',
    );
    if (!isRecord(body) || !Array.isArray(body.matches)) return [];
    return body.matches.flatMap((item): VectorMatch[] => {
      if (!isRecord(item) || typeof item.id !== 'string' || typeof item.score !== 'number')
        return [];
      return [
        {
          id: item.id,
          score: item.score,
          metadata: isRecord(item.metadata) ? stringRecord(item.metadata) : {},
        },
      ];
    });
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', 'api-key': this.options.apiKey };
  }
}

export interface WeaviateVectorStoreOptions {
  readonly endpoint: string;
  readonly collection: string;
  readonly apiKey?: string;
  readonly transport?: VectorHttpTransport;
}

/** Weaviate adapter using REST object writes and tenant-scoped GraphQL search. */
export class WeaviateVectorStore implements VectorStoreProvider {
  readonly kind = 'weaviate' as const;
  readonly configured = true;
  private readonly base: string;
  private readonly transport: VectorHttpTransport;

  constructor(private readonly options: WeaviateVectorStoreOptions) {
    this.base = endpoint(options.endpoint);
    this.transport = options.transport ?? fetchTransport();
    graphqlName(options.collection, 'Weaviate collection');
  }

  async upsert(input: {
    organizationId: string;
    id: string;
    vector: readonly number[];
    metadata: Readonly<Record<string, string>>;
  }): Promise<void> {
    await assertOk(
      await this.transport.request({
        method: 'POST',
        url: `${this.base}/v1/objects`,
        headers: this.headers(),
        body: {
          class: this.options.collection,
          id: input.id,
          properties: { ...input.metadata, organizationId: input.organizationId },
          vector: input.vector,
          tenant: input.organizationId,
        },
      }),
      'Weaviate',
    );
  }

  async delete(organizationId: string, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await assertOk(
        await this.transport.request({
          method: 'DELETE',
          url: `${this.base}/v1/batch/objects?tenant=${encodeURIComponent(organizationId)}`,
          headers: this.headers(),
          body: {
            match: {
              class: this.options.collection,
              where: {
                operator: 'And',
                operands: [
                  { path: ['id'], operator: 'Equal', valueText: id },
                  { path: ['organizationId'], operator: 'Equal', valueText: organizationId },
                ],
              },
            },
            output: 'minimal',
          },
        }),
        'Weaviate',
      );
    }
  }
  async deleteBySubject(organizationId: string, subjectId: string): Promise<number> {
    await assertOk(
      await this.transport.request({
        method: 'DELETE',
        url: `${this.base}/v1/batch/objects?tenant=${encodeURIComponent(organizationId)}`,
        headers: this.headers(),
        body: {
          match: {
            class: this.options.collection,
            where: {
              operator: 'And',
              operands: [
                { path: ['organizationId'], operator: 'Equal', valueText: organizationId },
                { path: ['subjectId'], operator: 'Equal', valueText: subjectId },
              ],
            },
          },
          output: 'minimal',
        },
      }),
      'Weaviate',
    );
    return 0;
  }

  async search(input: {
    organizationId: string;
    vector: readonly number[];
    topK: number;
    filter?: Readonly<Record<string, string>>;
  }): Promise<readonly VectorMatch[]> {
    if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 100)
      throw new RangeError('Vector topK must be between 1 and 100');
    const filterEntries = Object.entries(input.filter ?? {}).filter(
      ([key]) => key !== 'organizationId',
    );
    const properties = [
      ...new Set([
        'organizationId',
        'documentId',
        ...filterEntries.map(([key]) => graphqlName(key, 'Weaviate filter property')),
      ]),
    ];
    const whereOperands = [
      ...filterEntries.map(
        ([key, value]) =>
          `{path: [${JSON.stringify(graphqlName(key, 'Weaviate filter property'))}], operator: Equal, valueText: ${JSON.stringify(value)}}`,
      ),
      `{path: ["organizationId"], operator: Equal, valueText: ${JSON.stringify(input.organizationId)}}`,
    ];
    const body = await assertOk(
      await this.transport.request({
        method: 'POST',
        url: `${this.base}/v1/graphql`,
        headers: this.headers(),
        body: {
          query: `{ Get { ${this.options.collection}(nearVector: {vector: [${input.vector.join(',')}]}, where: {operator: And, operands: [${whereOperands.join(', ')}]}, limit: ${String(input.topK)}, tenant: ${JSON.stringify(input.organizationId)}) { ${properties.join(' ')} _additional { id distance } } } }`,
        },
      }),
      'Weaviate',
    );
    const rows =
      isRecord(body) && isRecord(body.data) && isRecord(body.data.Get)
        ? body.data.Get[this.options.collection]
        : undefined;
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((item): VectorMatch[] => {
      if (!isRecord(item) || !isRecord(item._additional) || typeof item._additional.id !== 'string')
        return [];
      const distance = item._additional.distance;
      return [
        {
          id: item._additional.id,
          score: typeof distance === 'number' ? 1 - distance : 0,
          metadata: stringRecord(item),
        },
      ];
    });
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.options.apiKey === undefined
        ? {}
        : { authorization: `Bearer ${this.options.apiKey}` }),
    };
  }
}

interface PgVectorRow {
  readonly id: string;
  readonly score: number;
  readonly metadata: Readonly<Record<string, string>>;
}
export interface PgVectorQueryable {
  query(sql: string, parameters?: readonly unknown[]): Promise<{ rows: PgVectorRow[] }>;
}
export interface PgVectorStoreOptions {
  readonly pool: PgVectorQueryable;
  readonly table?: string;
}

/** pgvector adapter. The table is fixed/validated and organizationId is mandatory in every query. */
export class PgVectorStore implements VectorStoreProvider {
  readonly kind = 'pgvector' as const;
  readonly configured = true;
  private readonly table: string;
  constructor(private readonly options: PgVectorStoreOptions) {
    this.table = options.table ?? 'handstack_knowledge_vectors';
    if (!/^[a-z][a-z0-9_]{1,62}$/u.test(this.table))
      throw new ValidationError('pgvector table name is invalid');
  }
  async ensureSchema(): Promise<void> {
    await this.options.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.options.pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (id varchar(200) NOT NULL, organization_id varchar(200) NOT NULL, vector vector NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY (id, organization_id))`,
    );
    await this.options.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_${this.table}_organization ON ${this.table} (organization_id)`,
    );
  }
  async upsert(input: {
    organizationId: string;
    id: string;
    vector: readonly number[];
    metadata: Readonly<Record<string, string>>;
  }): Promise<void> {
    await this.options.pool.query(
      `INSERT INTO ${this.table} (id, organization_id, vector, metadata) VALUES ($1, $2, $3::vector, $4::jsonb) ON CONFLICT (id, organization_id) DO UPDATE SET vector = EXCLUDED.vector, metadata = EXCLUDED.metadata`,
      [
        input.id,
        input.organizationId,
        `[${input.vector.join(',')}]`,
        JSON.stringify(input.metadata),
      ],
    );
  }
  async delete(organizationId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.options.pool.query(
      `DELETE FROM ${this.table} WHERE organization_id = $1 AND id = ANY($2::text[])`,
      [organizationId, [...ids]],
    );
  }
  async deleteBySubject(organizationId: string, subjectId: string): Promise<number> {
    const result = await this.options.pool.query(
      `DELETE FROM ${this.table} WHERE organization_id = $1 AND metadata @> $2::jsonb RETURNING id`,
      [organizationId, JSON.stringify({ subjectId })],
    );
    return result.rows.length;
  }
  async search(input: {
    organizationId: string;
    vector: readonly number[];
    topK: number;
    filter?: Readonly<Record<string, string>>;
  }): Promise<readonly VectorMatch[]> {
    if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 100)
      throw new RangeError('Vector topK must be between 1 and 100');
    const result = await this.options.pool.query(
      `SELECT id, 1 - (vector <=> $2::vector) AS score, metadata FROM ${this.table} WHERE organization_id = $1 AND metadata @> $3::jsonb ORDER BY vector <=> $2::vector LIMIT $4`,
      [
        input.organizationId,
        `[${input.vector.join(',')}]`,
        JSON.stringify(input.filter ?? {}),
        input.topK,
      ],
    );
    return result.rows.map((row) => ({ id: row.id, score: row.score, metadata: row.metadata }));
  }
}

export interface MongoAtlasVectorStoreOptions {
  readonly collection: Collection;
  readonly index?: string;
  readonly path?: string;
}

/** MongoDB Atlas Vector Search adapter; it is opt-in and independent from the primary Mongo adapter. */
export class MongoAtlasVectorStore implements VectorStoreProvider {
  readonly kind = 'mongodb-atlas' as const;
  readonly configured = true;
  private readonly index: string;
  private readonly path: string;
  constructor(private readonly options: MongoAtlasVectorStoreOptions) {
    this.index = options.index ?? 'handstack-vector-index';
    this.path = options.path ?? 'vector';
  }
  async upsert(input: {
    organizationId: string;
    id: string;
    vector: readonly number[];
    metadata: Readonly<Record<string, string>>;
  }): Promise<void> {
    await this.options.collection.updateOne(
      { id: input.id, organizationId: input.organizationId },
      {
        $set: {
          id: input.id,
          organizationId: input.organizationId,
          vector: [...input.vector],
          metadata: { ...input.metadata },
        },
      },
      { upsert: true },
    );
  }
  async delete(organizationId: string, ids: readonly string[]): Promise<void> {
    if (ids.length > 0)
      await this.options.collection.deleteMany({ organizationId, id: { $in: [...ids] } });
  }
  async deleteBySubject(organizationId: string, subjectId: string): Promise<number> {
    const result = await this.options.collection.deleteMany({
      organizationId,
      'metadata.subjectId': subjectId,
    });
    return result.deletedCount;
  }
  async search(input: {
    organizationId: string;
    vector: readonly number[];
    topK: number;
    filter?: Readonly<Record<string, string>>;
  }): Promise<readonly VectorMatch[]> {
    if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 100)
      throw new RangeError('Vector topK must be between 1 and 100');
    const metadataFilter = Object.fromEntries(
      Object.entries(input.filter ?? {})
        .filter(([key]) => key !== 'organizationId')
        .map(([key, value]) => [`metadata.${key}`, value]),
    );
    const rows = (await this.options.collection
      .aggregate([
        {
          $vectorSearch: {
            index: this.index,
            path: this.path,
            queryVector: [...input.vector],
            numCandidates: Math.max(input.topK * 10, 100),
            limit: input.topK,
            filter: { ...metadataFilter, organizationId: input.organizationId },
          },
        },
        { $project: { id: 1, metadata: 1, score: { $meta: 'vectorSearchScore' } } },
      ])
      .toArray()) as { id: string; score: number; metadata: Readonly<Record<string, string>> }[];
    return rows.map((row) => ({ id: row.id, score: row.score, metadata: row.metadata }));
  }
}

function graphqlName(value: string, label: string): string {
  if (!/^[_A-Za-z][_0-9A-Za-z]*$/u.test(value))
    throw new ValidationError(`${label} must be a valid GraphQL name`);
  return value;
}

function fetchTransport(): VectorHttpTransport {
  return {
    request: async ({ method, url, headers, body }) => {
      const response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
      });
      return { status: response.status, json: () => response.json() };
    },
  };
}

function assertOk(response: VectorHttpResponse, kind: string): Promise<unknown> {
  if (response.status < 200 || response.status >= 300)
    throw new ValidationError(`${kind} vector operation failed`);
  return response.json();
}

function endpoint(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname))
    throw new ValidationError('Vector endpoint must use HTTPS unless loopback');
  return value.replace(/\/$/u, '');
}

export interface QdrantVectorStoreOptions {
  readonly endpoint: string;
  readonly collection: string;
  readonly apiKey?: string;
  readonly transport?: VectorHttpTransport;
}

/** Qdrant REST adapter; organizationId is always stored and filtered in payload. */
export class QdrantVectorStore implements VectorStoreProvider {
  readonly kind = 'qdrant' as const;
  readonly configured = true;
  private readonly base: string;
  private readonly transport: VectorHttpTransport;

  constructor(private readonly options: QdrantVectorStoreOptions) {
    this.base = endpoint(options.endpoint);
    this.transport = options.transport ?? fetchTransport();
    if (options.collection.trim() === '')
      throw new ValidationError('Qdrant collection is required');
  }

  async upsert(input: {
    organizationId: string;
    id: string;
    vector: readonly number[];
    metadata: Readonly<Record<string, string>>;
  }): Promise<void> {
    await assertOk(
      await this.transport.request({
        method: 'PUT',
        url: `${this.base}/collections/${encodeURIComponent(this.options.collection)}/points?wait=true`,
        headers: this.headers(),
        body: {
          points: [
            {
              id: input.id,
              vector: input.vector,
              payload: { ...input.metadata, organizationId: input.organizationId },
            },
          ],
        },
      }),
      'Qdrant',
    );
  }

  async delete(organizationId: string, ids: readonly string[]): Promise<void> {
    await assertOk(
      await this.transport.request({
        method: 'POST',
        url: `${this.base}/collections/${encodeURIComponent(this.options.collection)}/points/delete?wait=true`,
        headers: this.headers(),
        body: {
          filter: {
            must: [{ key: 'organizationId', match: { value: organizationId } }, { has_id: ids }],
          },
        },
      }),
      'Qdrant',
    );
  }
  async deleteBySubject(organizationId: string, subjectId: string): Promise<number> {
    await assertOk(
      await this.transport.request({
        method: 'POST',
        url: `${this.base}/collections/${encodeURIComponent(this.options.collection)}/points/delete?wait=true`,
        headers: this.headers(),
        body: {
          filter: {
            must: [
              { key: 'organizationId', match: { value: organizationId } },
              { key: 'subjectId', match: { value: subjectId } },
            ],
          },
        },
      }),
      'Qdrant',
    );
    return 0;
  }

  async search(input: {
    organizationId: string;
    vector: readonly number[];
    topK: number;
    filter?: Readonly<Record<string, string>>;
  }): Promise<readonly VectorMatch[]> {
    if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 100)
      throw new RangeError('Vector topK must be between 1 and 100');
    const must = [
      { key: 'organizationId', match: { value: input.organizationId } },
      ...Object.entries(input.filter ?? {}).map(([key, value]) => ({ key, match: { value } })),
    ];
    const body = await assertOk(
      await this.transport.request({
        method: 'POST',
        url: `${this.base}/collections/${encodeURIComponent(this.options.collection)}/points/search`,
        headers: this.headers(),
        body: { vector: input.vector, limit: input.topK, with_payload: true, filter: { must } },
      }),
      'Qdrant',
    );
    const result = body as { result?: unknown };
    return Array.isArray(result.result)
      ? result.result.flatMap((item): VectorMatch[] => {
          if (!isRecord(item) || typeof item.id !== 'string' || typeof item.score !== 'number')
            return [];
          return [
            {
              id: item.id,
              score: item.score,
              metadata: isRecord(item.payload) ? stringRecord(item.payload) : {},
            },
          ];
        })
      : [];
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.options.apiKey === undefined ? {} : { 'api-key': this.options.apiKey }),
    };
  }
}

export interface ChromaVectorStoreOptions {
  readonly endpoint: string;
  readonly collection: string;
  readonly apiKey?: string;
  readonly tenant?: string;
  readonly database?: string;
  readonly transport?: VectorHttpTransport;
}

/** Chroma REST adapter; organizationId is enforced through `where` clauses. */
export class ChromaVectorStore implements VectorStoreProvider {
  readonly kind = 'chroma' as const;
  readonly configured = true;
  private readonly base: string;
  private readonly transport: VectorHttpTransport;
  private readonly tenant: string;
  private readonly database: string;
  private collectionIdPromise: Promise<string> | undefined;

  constructor(private readonly options: ChromaVectorStoreOptions) {
    this.base = endpoint(options.endpoint);
    this.transport = options.transport ?? fetchTransport();
    this.tenant = options.tenant ?? 'default_tenant';
    this.database = options.database ?? 'default_database';
    if (options.collection.trim() === '')
      throw new ValidationError('Chroma collection is required');
  }

  async upsert(input: {
    organizationId: string;
    id: string;
    vector: readonly number[];
    metadata: Readonly<Record<string, string>>;
  }): Promise<void> {
    const collectionId = await this.collectionId();
    await assertOk(
      await this.transport.request({
        method: 'POST',
        url: `${this.collectionUrl(collectionId)}/upsert`,
        headers: this.headers(),
        body: {
          ids: [input.id],
          embeddings: [input.vector],
          metadatas: [{ ...input.metadata, organizationId: input.organizationId }],
        },
      }),
      'Chroma',
    );
  }

  async delete(organizationId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const collectionId = await this.collectionId();
    await assertOk(
      await this.transport.request({
        method: 'POST',
        url: `${this.collectionUrl(collectionId)}/delete`,
        headers: this.headers(),
        body: { ids, where: { organizationId } },
      }),
      'Chroma',
    );
  }
  async deleteBySubject(organizationId: string, subjectId: string): Promise<number> {
    const collectionId = await this.collectionId();
    const where = chromaWhere({ organizationId, subjectId });
    const seen = new Set<string>();
    let deleted = 0;
    let complete = false;
    while (!complete) {
      const page = await assertOk(
        await this.transport.request({
          method: 'POST',
          url: `${this.collectionUrl(collectionId)}/get`,
          headers: this.headers(),
          body: { where, limit: 500, include: [] },
        }),
        'Chroma',
      );
      if (!isRecord(page) || !Array.isArray(page.ids))
        throw new ValidationError('Chroma subject lookup did not return record ids');
      const ids = page.ids.filter((id): id is string => typeof id === 'string');
      if (ids.length === 0) {
        complete = true;
        continue;
      }
      if (ids.some((id) => seen.has(id)))
        throw new ValidationError('Chroma subject deletion stopped making progress');
      for (const id of ids) seen.add(id);

      const result = await assertOk(
        await this.transport.request({
          method: 'POST',
          url: `${this.collectionUrl(collectionId)}/delete`,
          headers: this.headers(),
          body: { ids, where },
        }),
        'Chroma',
      );
      const reported =
        isRecord(result) && typeof result.deleted === 'number' ? result.deleted : ids.length;
      if (reported === 0)
        throw new ValidationError('Chroma did not delete the matched subject records');
      deleted += reported;
    }
    return deleted;
  }

  async search(input: {
    organizationId: string;
    vector: readonly number[];
    topK: number;
    filter?: Readonly<Record<string, string>>;
  }): Promise<readonly VectorMatch[]> {
    if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 100)
      throw new RangeError('Vector topK must be between 1 and 100');
    const collectionId = await this.collectionId();
    const where = chromaWhere({ ...(input.filter ?? {}), organizationId: input.organizationId });
    const body = await assertOk(
      await this.transport.request({
        method: 'POST',
        url: `${this.collectionUrl(collectionId)}/query`,
        headers: this.headers(),
        body: {
          query_embeddings: [input.vector],
          n_results: input.topK,
          where,
          include: ['metadatas', 'distances'],
        },
      }),
      'Chroma',
    );
    if (!isRecord(body)) return [];
    const chromaResponse = body as {
      readonly ids?: unknown;
      readonly distances?: unknown;
      readonly metadatas?: unknown;
    };
    if (!Array.isArray(chromaResponse.ids) || !Array.isArray(chromaResponse.ids[0])) return [];
    const ids = chromaResponse.ids[0].filter((value): value is string => typeof value === 'string');
    const distances = firstArray(chromaResponse.distances);
    const metadatas = firstArray(chromaResponse.metadatas);
    return ids.map((id, index) => ({
      id,
      score: typeof distances[index] === 'number' ? 1 - distances[index] : 0,
      metadata: isRecord(metadatas[index]) ? stringRecord(metadatas[index]) : {},
    }));
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.options.apiKey === undefined ? {} : { 'x-chroma-token': this.options.apiKey }),
    };
  }

  private collectionUrl(collectionId: string): string {
    return `${this.base}/api/v2/tenants/${encodeURIComponent(this.tenant)}/databases/${encodeURIComponent(this.database)}/collections/${encodeURIComponent(collectionId)}`;
  }

  private async collectionId(): Promise<string> {
    this.collectionIdPromise ??= (async () => {
      const body = await assertOk(
        await this.transport.request({
          method: 'GET',
          url: `${this.base}/api/v2/tenants/${encodeURIComponent(this.tenant)}/databases/${encodeURIComponent(this.database)}/collections/${encodeURIComponent(this.options.collection)}`,
          headers: this.headers(),
        }),
        'Chroma',
      );
      if (!isRecord(body) || typeof body.id !== 'string' || body.id === '')
        throw new ValidationError('Chroma collection response did not include an id');
      return body.id;
    })();
    return this.collectionIdPromise;
  }
}

function chromaWhere(filters: Readonly<Record<string, string>>): Readonly<Record<string, unknown>> {
  const conditions = Object.entries(filters).map(([key, value]) => ({ [key]: value }));
  return conditions.length === 1 ? (conditions[0] ?? {}) : { $and: conditions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function stringRecord(value: Record<string, unknown>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => (typeof item === 'string' ? [[key, item]] : [])),
  );
}
function firstArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) && Array.isArray(value[0]) ? value[0] : [];
}

/** Explicit fail-closed provider used until a concrete backend is configured. */
export class FailClosedVectorStoreProvider implements VectorStoreProvider {
  readonly configured = false;

  constructor(
    readonly kind: VectorStoreAdapterKind,
    private readonly reason = 'Vector store adapter is not configured',
  ) {}

  upsert(): Promise<void> {
    return Promise.reject(new ValidationError(this.reason));
  }
  delete(): Promise<void> {
    return Promise.reject(new ValidationError(this.reason));
  }
  search(): Promise<readonly VectorMatch[]> {
    return Promise.reject(new ValidationError(this.reason));
  }
}

/** Registry for vendor adapters; unregistered backends fail closed. */
export class InMemoryVectorStoreProviderFactory implements VectorStoreProviderFactory {
  private readonly providers = new Map<VectorStoreAdapterKind, VectorStoreProvider>();

  register(provider: VectorStoreProvider): void {
    if (this.providers.has(provider.kind))
      throw new ValidationError(`Vector store provider already registered: ${provider.kind}`);
    this.providers.set(provider.kind, provider);
  }

  create(kind: VectorStoreAdapterKind): VectorStoreProvider {
    return this.providers.get(kind) ?? new FailClosedVectorStoreProvider(kind);
  }
}
