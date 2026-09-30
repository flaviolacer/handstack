import { repositoryName, type Repository, type TenantEntity } from '@handstack/domain';
import {
  McpClientRegistry,
  type McpCallContext,
  type McpOAuthAuthorization,
  type McpPrompt,
  type McpResource,
  type McpServerConfig,
  type McpTool,
} from '@handstack/mcp-client';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { SecretRuntimeService } from '../secrets/secret-runtime.service.js';

interface McpServerEntity extends TenantEntity {
  readonly organizationId: string;
  readonly config: Omit<McpServerConfig, 'credentialResolver' | 'auth' | 'environment'>;
}
interface McpCredentialBinding extends TenantEntity {
  readonly organizationId: string;
  readonly serverId: string;
  readonly principalId: string;
  readonly secretId: string;
  readonly type: 'API_KEY' | 'BEARER' | 'OAUTH2' | 'OIDC' | 'CUSTOM_HEADERS';
}
export interface McpResourceEntity extends TenantEntity {
  readonly organizationId: string;
  readonly serverId: string;
  readonly resource: McpResource;
}
export interface McpPromptEntity extends TenantEntity {
  readonly organizationId: string;
  readonly serverId: string;
  readonly prompt: McpPrompt;
}
export interface McpToolEntity extends TenantEntity {
  readonly organizationId: string;
  readonly serverId: string;
  readonly tool: McpTool;
}

const repository = repositoryName('mcp-servers');
const credentialsRepository = repositoryName('mcp-credentials');
const resourcesRepository = repositoryName('mcp-resources');
const promptsRepository = repositoryName('mcp-prompts');
const toolsRepository = repositoryName('mcp-tools');

@Injectable()
export class McpRuntimeService {
  readonly clients: McpClientRegistry;
  private readonly servers: Repository<McpServerEntity>;
  private readonly credentials: Repository<McpCredentialBinding>;
  private readonly resources: Repository<McpResourceEntity>;
  private readonly prompts: Repository<McpPromptEntity>;
  private readonly tools: Repository<McpToolEntity>;
  constructor(
    @Inject(DatabaseService) database: DatabaseService,
    @Inject(SecretRuntimeService) private readonly secrets: SecretRuntimeService,
  ) {
    this.clients = new McpClientRegistry(
      undefined,
      database.config.timeouts.mcp,
      database.config.queue.namespaces.cache,
    );
    this.servers = database.adapter.repository(repository);
    this.credentials = database.adapter.repository(credentialsRepository);
    this.resources = database.adapter.repository(resourcesRepository);
    this.prompts = database.adapter.repository(promptsRepository);
    this.tools = database.adapter.repository(toolsRepository);
  }

  purgeOrganizationCache(organizationId: string): Promise<number> {
    return this.clients.purgeOrganization(organizationId);
  }

  async saveCredential(input: {
    organizationId: string;
    serverId: string;
    principalId: string;
    type: McpCredentialBinding['type'];
    secret: string;
  }) {
    await this.ensureRegistered(input.organizationId, input.serverId);
    const pluginId = `mcp:${input.serverId}:${input.principalId}`;
    const stored = await this.credentials.findById(
      input.organizationId,
      `${input.serverId}:${input.principalId}`,
    );
    const secret =
      stored === undefined
        ? await this.secrets.create({
            organizationId: input.organizationId,
            actorId: input.principalId,
            name: `${input.serverId} credential`,
            pluginId,
            value: input.secret,
          })
        : await this.secrets.rotate(
            input.organizationId,
            input.principalId,
            stored.secretId,
            input.secret,
          );
    const now = new Date();
    const binding: McpCredentialBinding = {
      id: `${input.serverId}:${input.principalId}`,
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      serverId: input.serverId,
      principalId: input.principalId,
      secretId: secret.id,
      type: input.type,
      version: stored === undefined ? 1 : stored.version + 1,
      createdAt: stored?.createdAt ?? now,
      updatedAt: now,
    };
    if (stored === undefined) await this.credentials.insert(binding);
    else await this.credentials.update(binding, stored.version);
    return {
      serverId: input.serverId,
      principalId: input.principalId,
      type: input.type,
      secretId: secret.id,
    };
  }

  async list(organizationId: string) {
    const values: McpServerConfig[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.servers.list(organizationId, {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      values.push(...page.items.map((entry) => entry.config));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return values;
  }

  async beginOAuth(
    organizationId: string,
    serverId: string,
    principalId: string,
  ): Promise<McpOAuthAuthorization> {
    await this.ensureRegistered(organizationId, serverId);
    return this.clients.beginOAuth(organizationId, serverId, principalId);
  }

  async completeOAuth(
    organizationId: string,
    serverId: string,
    principalId: string,
    state: string,
    code: string,
  ) {
    await this.ensureRegistered(organizationId, serverId);
    const credential = await this.clients.completeOAuth(
      organizationId,
      serverId,
      principalId,
      state,
      code,
    );
    return this.saveCredential({
      organizationId,
      serverId,
      principalId,
      type: 'OAUTH2',
      secret: credential.secret ?? '',
    });
  }

  async register(config: Omit<McpServerConfig, 'credentialResolver' | 'auth' | 'environment'>) {
    this.clients.register(config);
    const now = new Date();
    const entity: McpServerEntity = {
      id: config.id,
      tenantId: config.organizationId,
      organizationId: config.organizationId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      config,
    };
    return (await this.servers.insert(entity)).config;
  }

  async discover(organizationId: string, serverId: string) {
    await this.ensureRegistered(organizationId, serverId);
    const values = await this.clients.discover(organizationId, serverId);
    await this.persistDiscovery(organizationId, serverId, values, this.tools, (tool) => tool.name);
    return values;
  }

  /** Drops a stale client transport while preserving the registered server and discovery cache. */
  async reconnect(organizationId: string, serverId: string) {
    await this.ensureRegistered(organizationId, serverId);
    await this.clients.reconnect(organizationId, serverId);
    return { organizationId, serverId, reconnected: true };
  }

  async listTools(organizationId: string, serverId: string) {
    await this.ensureRegistered(organizationId, serverId);
    const cached = this.clients.listTools(organizationId, serverId);
    if (cached.length > 0) return cached;
    const values = await this.listAll(
      this.tools,
      organizationId,
      (item) => item.serverId === serverId,
      (item) => item.tool,
    );
    this.clients.restoreTools(organizationId, serverId, values);
    return values;
  }

  async discoverResources(organizationId: string, serverId: string) {
    await this.ensureRegistered(organizationId, serverId);
    const values = await this.clients.discoverResources(organizationId, serverId);
    await this.persistDiscovery(
      organizationId,
      serverId,
      values,
      this.resources,
      (resource) => resource.uri,
    );
    return values;
  }

  async discoverPrompts(organizationId: string, serverId: string) {
    await this.ensureRegistered(organizationId, serverId);
    const values = await this.clients.discoverPrompts(organizationId, serverId);
    await this.persistDiscovery(
      organizationId,
      serverId,
      values,
      this.prompts,
      (prompt) => prompt.name,
    );
    return values;
  }

  async listResources(organizationId: string, serverId: string) {
    await this.ensureRegistered(organizationId, serverId);
    const cached = this.clients.listResources(organizationId, serverId);
    if (cached.length > 0) return cached;
    const values = await this.listAll(
      this.resources,
      organizationId,
      (item) => item.serverId === serverId,
      (item) => item.resource,
    );
    this.clients.restoreResources(organizationId, serverId, values);
    return values;
  }

  async listPrompts(organizationId: string, serverId: string) {
    await this.ensureRegistered(organizationId, serverId);
    const cached = this.clients.listPrompts(organizationId, serverId);
    if (cached.length > 0) return cached;
    const values = await this.listAll(
      this.prompts,
      organizationId,
      (item) => item.serverId === serverId,
      (item) => item.prompt,
    );
    this.clients.restorePrompts(organizationId, serverId, values);
    return values;
  }

  async execute(
    organizationId: string,
    serverId: string,
    toolName: string,
    argumentsValue: unknown,
    context: McpCallContext,
  ) {
    await this.ensureRegistered(organizationId, serverId);
    const binding = await this.credentials.findById(
      organizationId,
      `${serverId}:${context.principalId}`,
    );
    if (binding === undefined)
      return this.clients.execute(organizationId, serverId, toolName, argumentsValue, context);
    const credential = await this.secrets.resolve(
      binding.secretId,
      organizationId,
      `mcp:${serverId}:${context.principalId}`,
    );
    if (credential === undefined)
      return this.clients.execute(organizationId, serverId, toolName, argumentsValue, context);
    if (binding.type === 'CUSTOM_HEADERS') {
      let headers: unknown;
      try {
        headers = JSON.parse(credential) as unknown;
      } catch {
        throw new Error('Stored MCP custom headers are invalid');
      }
      if (!isRecord(headers) || Object.values(headers).some((value) => typeof value !== 'string'))
        throw new Error('Stored MCP custom headers are invalid');
      return this.clients.execute(organizationId, serverId, toolName, argumentsValue, {
        ...context,
        credential: { type: binding.type, headers: headers as Record<string, string> },
      });
    }
    return this.clients.execute(organizationId, serverId, toolName, argumentsValue, {
      ...context,
      credential: { type: binding.type, secret: credential },
    });
  }

  private async ensureRegistered(organizationId: string, serverId: string): Promise<void> {
    if (this.clients.list(organizationId).some((server) => server.id === serverId)) return;
    const stored = await this.servers.findById(organizationId, serverId);
    if (stored === undefined) throw new Error('MCP server not found');
    this.clients.register(stored.config);
    const [resources, prompts, tools] = await Promise.all([
      this.listAll(
        this.resources,
        organizationId,
        (item) => item.serverId === serverId,
        (item) => item.resource,
      ),
      this.listAll(
        this.prompts,
        organizationId,
        (item) => item.serverId === serverId,
        (item) => item.prompt,
      ),
      this.listAll(
        this.tools,
        organizationId,
        (item) => item.serverId === serverId,
        (item) => item.tool,
      ),
    ]);
    this.clients.restoreTools(organizationId, serverId, tools);
    this.clients.restoreResources(organizationId, serverId, resources);
    this.clients.restorePrompts(organizationId, serverId, prompts);
  }

  private async listAll<T extends TenantEntity, V>(
    repository: Repository<T>,
    organizationId: string,
    filter: (item: T) => boolean,
    map: (item: T) => V,
  ): Promise<V[]> {
    const values: V[] = [];
    let cursor: string | undefined;
    do {
      const page = await repository.list(organizationId, {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      values.push(...page.items.filter(filter).map(map));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return values;
  }

  private async persistDiscovery<
    T extends McpResource | McpPrompt | McpTool,
    E extends TenantEntity,
  >(
    organizationId: string,
    serverId: string,
    values: readonly T[],
    repository: Repository<E>,
    key: (value: T) => string,
  ): Promise<void> {
    const existing = await repository.list(organizationId, { limit: 200 });
    const existingById = new Map(
      existing.items
        .filter((item) => (item as E & { serverId?: string }).serverId === serverId)
        .map((item) => [item.id, item]),
    );
    await Promise.all(
      values.map((value) => {
        const id = `${serverId}:${key(value)}`;
        const current = existingById.get(id);
        const now = new Date();
        const repositoryIdentity = repository as unknown;
        const entity = (repositoryIdentity === (this.resources as unknown)
          ? { id, tenantId: organizationId, organizationId, serverId, resource: value }
          : repositoryIdentity === (this.prompts as unknown)
            ? { id, tenantId: organizationId, organizationId, serverId, prompt: value }
            : {
                id,
                tenantId: organizationId,
                organizationId,
                serverId,
                tool: value,
              }) as unknown as E & TenantEntity;
        return current === undefined
          ? repository.insert({ ...entity, version: 1, createdAt: now, updatedAt: now })
          : repository.update(
              {
                ...current,
                ...entity,
                version: current.version + 1,
                createdAt: current.createdAt,
                updatedAt: now,
              },
              current.version,
            );
      }),
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
