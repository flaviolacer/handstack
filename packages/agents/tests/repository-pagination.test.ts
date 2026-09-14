import { describe, expect, it } from 'vitest';
import { RepositoryAgentStore, type AgentEntity, type AgentVersionEntity } from '../src/index.js';
import type { Repository, RepositoryName, TenantEntity } from '@handstack/domain';

describe('RepositoryAgentStore pagination', () => {
  it('loads all agent pages beyond the canonical 200-item limit', async () => {
    const values: AgentEntity[] = Array.from({ length: 201 }, (_, index) => ({
      id: `agent-${String(index)}`,
      organizationId: 'org',
      tenantId: 'org',
      version: 1,
      slug: `agent-${String(index)}`,
      name: 'Agent',
      description: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const repository: Repository<AgentEntity> = {
      findById: (_tenant, id) => Promise.resolve(values.find((item) => item.id === id)),
      list: (tenant, page) => {
        const scoped = values.filter((item) => item.tenantId === tenant);
        const start =
          page.cursor === undefined ? 0 : scoped.findIndex((item) => item.id === page.cursor) + 1;
        const items = scoped.slice(start, start + page.limit);
        const last = items.at(-1);
        return Promise.resolve({
          items,
          ...(last !== undefined && start + page.limit < scoped.length
            ? { nextCursor: last.id }
            : {}),
        });
      },
      insert: (entity) => {
        values.push(entity);
        return Promise.resolve(entity);
      },
      update: (entity) => Promise.resolve(entity),
      delete: () => Promise.resolve(true),
    };
    const factory = (() => repository) as <T extends TenantEntity>(
      name: RepositoryName,
    ) => Repository<T>;
    await expect(new RepositoryAgentStore(factory).listAgents('org')).resolves.toHaveLength(201);
  });

  it('loads all versions for an agent across multiple pages', async () => {
    const values: AgentVersionEntity[] = Array.from({ length: 201 }, (_, index) => ({
      id: `version-${String(index)}`,
      organizationId: 'org',
      tenantId: 'org',
      version: 1,
      agentId: 'agent-1',
      status: 'DRAFT' as const,
      model: 'model',
      systemPrompt: '',
      tools: [],
      maxIterations: 1,
      timeoutMs: 1000,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const repository: Repository<AgentVersionEntity> = {
      findById: (_tenant, id) => Promise.resolve(values.find((item) => item.id === id)),
      list: (tenant, page) => {
        const scoped = values.filter((item) => item.tenantId === tenant);
        const start =
          page.cursor === undefined ? 0 : scoped.findIndex((item) => item.id === page.cursor) + 1;
        const items = scoped.slice(start, start + page.limit);
        const last = items.at(-1);
        return Promise.resolve({
          items,
          ...(last !== undefined && start + page.limit < scoped.length
            ? { nextCursor: last.id }
            : {}),
        });
      },
      insert: (entity) => {
        values.push(entity);
        return Promise.resolve(entity);
      },
      update: (entity) => Promise.resolve(entity),
      delete: () => Promise.resolve(true),
    };
    const factory = (() => repository) as <T extends TenantEntity>(
      name: RepositoryName,
    ) => Repository<T>;
    await expect(
      new RepositoryAgentStore(factory).listVersions('org', 'agent-1'),
    ).resolves.toHaveLength(201);
  });

  it('fails fast when an adapter repeats a pagination cursor', async () => {
    const repository: Repository<AgentEntity> = {
      findById: () => Promise.resolve(undefined),
      list: () => Promise.resolve({ items: [], nextCursor: 'same' }),
      insert: (entity) => Promise.resolve(entity),
      update: (entity) => Promise.resolve(entity),
      delete: () => Promise.resolve(true),
    };
    const factory = (() => repository) as <T extends TenantEntity>(
      name: RepositoryName,
    ) => Repository<T>;
    await expect(new RepositoryAgentStore(factory).listAgents('org')).rejects.toThrow(
      'repeated pagination cursor',
    );
  });
});
