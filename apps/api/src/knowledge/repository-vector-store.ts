import { repositoryName, type Repository, type TenantEntity } from '@handstack/domain';
import type { VectorStore } from '@handstack/knowledge';
import { listAllTenant } from '../database/pagination.js';

interface VectorEntity extends TenantEntity {
  readonly organizationId: string;
  readonly vector: readonly number[];
  readonly metadata: Readonly<Record<string, string>>;
}
const vectorsRepository = repositoryName('knowledge-vectors');

export class RepositoryVectorStore implements VectorStore {
  private readonly repository: Repository<VectorEntity>;
  constructor(
    repositoryFactory: <T extends TenantEntity>(name: typeof vectorsRepository) => Repository<T>,
  ) {
    this.repository = repositoryFactory<VectorEntity>(vectorsRepository);
  }

  async upsert(input: {
    organizationId: string;
    id: string;
    vector: readonly number[];
    metadata: Readonly<Record<string, string>>;
  }) {
    const current = await this.repository.findById(input.organizationId, input.id);
    const now = new Date();
    const entity: VectorEntity = {
      id: input.id,
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      vector: [...input.vector],
      metadata: { ...input.metadata },
      version: current?.version ?? 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    if (current === undefined) await this.repository.insert(entity);
    else await this.repository.update({ ...entity, version: current.version + 1 }, current.version);
  }

  async delete(organizationId: string, ids: readonly string[]) {
    for (const id of ids) {
      const current = await this.repository.findById(organizationId, id);
      if (current !== undefined) await this.repository.delete(organizationId, id, current.version);
    }
  }

  async deleteBySubject(organizationId: string, subjectId: string): Promise<number> {
    const items = await this.items(organizationId);
    const matches = items.filter((item) => item.metadata.subjectId === subjectId);
    await this.delete(
      organizationId,
      matches.map((item) => item.id),
    );
    return matches.length;
  }

  async deleteByDocument(organizationId: string, documentId: string) {
    const items = await this.items(organizationId);
    await this.delete(
      organizationId,
      items.filter((item) => item.metadata.documentId === documentId).map((item) => item.id),
    );
  }

  async updateByDocument(input: {
    organizationId: string;
    documentId: string;
    sourceAcl: readonly { principalId: string }[];
    deletionStatus: string;
    lastVerifiedAt: Date;
  }) {
    const items = await this.items(input.organizationId);
    for (const current of items.filter((item) => item.metadata.documentId === input.documentId))
      await this.repository.update(
        {
          ...current,
          version: current.version + 1,
          updatedAt: new Date(),
          metadata: {
            ...current.metadata,
            sourceAcl: input.sourceAcl.map((entry) => entry.principalId).join(','),
            deletionStatus: input.deletionStatus,
            lastVerifiedAt: String(input.lastVerifiedAt.getTime()),
          },
        },
        current.version,
      );
  }

  async listByOrganization(input: { organizationId: string; knowledgeBaseId?: string }) {
    const items = await this.items(input.organizationId);
    return items
      .filter(
        (item) =>
          input.knowledgeBaseId === undefined ||
          item.metadata.knowledgeBaseId === input.knowledgeBaseId,
      )
      .map((item) => ({ id: item.id, score: 0, metadata: item.metadata }));
  }

  async search(input: {
    organizationId: string;
    vector: readonly number[];
    topK: number;
    filter?: Readonly<Record<string, string>>;
  }) {
    if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 100)
      throw new RangeError('Vector topK must be between 1 and 100');
    const items = await this.items(input.organizationId);
    return items
      .filter((item) => matches(item.metadata, input.filter))
      .map((item) => ({
        id: item.id,
        score: cosine(input.vector, item.vector),
        metadata: item.metadata,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, input.topK);
  }

  private async items(organizationId: string) {
    return listAllTenant(this.repository, organizationId);
  }
}

function matches(
  metadata: Readonly<Record<string, string>>,
  filter?: Readonly<Record<string, string>>,
) {
  return Object.entries(filter ?? {}).every(([key, value]) => metadata[key] === value);
}
function cosine(left: readonly number[], right: readonly number[]) {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}
