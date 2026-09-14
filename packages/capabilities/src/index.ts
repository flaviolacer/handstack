import { uuidV7, repositoryName, type Repository, type TenantEntity } from '@handstack/domain';
import type { DatabaseAdapter } from '@handstack/database';
import { ValidationError } from '@handstack/shared';

export type CapabilityChannel = 'WEB' | 'API' | 'MCP' | 'INTERNAL' | 'AGENT';
export type CapabilityType = 'TOOL' | 'AGENT' | 'WORKFLOW' | 'KNOWLEDGE' | 'PLUGIN' | 'CUSTOM';
export type CapabilityVisibility = 'PRIVATE' | 'ORGANIZATION' | 'PUBLIC';

export interface Capability extends TenantEntity {
  readonly organizationId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly type: CapabilityType;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly requiredPermissions: readonly string[];
  readonly allowedChannels: readonly CapabilityChannel[];
  readonly budgetPolicy?: { readonly estimateUsd: number };
  readonly timeoutMs: number;
  readonly visibility: CapabilityVisibility;
  readonly version: number;
  readonly ownerId: string;
  readonly metadata: Record<string, string>;
}

export interface CapabilityExecutionContext {
  readonly organizationId: string;
  readonly principalId: string;
  readonly permissions?: readonly string[];
  readonly channel: CapabilityChannel;
  readonly signal?: AbortSignal;
  readonly requestId?: string;
}

export type CapabilityHandler = (
  input: unknown,
  context: CapabilityExecutionContext,
) => Promise<unknown>;

export interface RegisteredCapability {
  readonly capability: Capability;
  readonly handler: CapabilityHandler;
}

export interface CapabilityRegistry {
  register(
    input: Omit<Capability, keyof TenantEntity> & { handler: CapabilityHandler },
  ): Promise<Capability>;
  list(organizationId: string, channel?: CapabilityChannel): Promise<readonly Capability[]>;
  get(organizationId: string, slug: string): Promise<RegisteredCapability | undefined>;
  publish(organizationId: string, slug: string): Promise<Capability>;
}

const capabilitiesRepository = repositoryName('capabilities');

/** Persists capability metadata while keeping executable handlers in the extension runtime. */
export class PersistentCapabilityRegistry implements CapabilityRegistry {
  private readonly handlers = new Map<string, CapabilityHandler>();
  private readonly repository: Repository<Capability>;

  constructor(adapter: DatabaseAdapter) {
    this.repository = adapter.repository<Capability>(capabilitiesRepository);
  }

  async register(
    input: Omit<Capability, keyof TenantEntity> & { handler: CapabilityHandler },
  ): Promise<Capability> {
    if (input.organizationId === '' || input.slug.trim() === '')
      throw new ValidationError('Capability organization and slug are required');
    if (input.timeoutMs <= 0 || !Number.isInteger(input.timeoutMs))
      throw new ValidationError('Capability timeout must be a positive integer');
    const slug = input.slug.trim().toLowerCase();
    const existing = await this.repository.list(input.organizationId, { limit: 100 });
    if (existing.items.some((item) => item.slug === slug))
      throw new ValidationError('Capability slug already exists');
    const now = new Date();
    const capability: Capability = {
      ...input,
      id: uuidV7(now.getTime()),
      tenantId: input.organizationId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      slug,
      requiredPermissions: [...new Set(input.requiredPermissions)].sort(),
      allowedChannels: [...new Set(input.allowedChannels)],
    };
    const inserted = await this.repository.insert(capability);
    this.handlers.set(`${input.organizationId}:${slug}`, input.handler);
    return inserted;
  }

  async list(organizationId: string, channel?: CapabilityChannel) {
    const page = await this.repository.list(organizationId, { limit: 100 });
    return page.items.filter(
      (capability) => channel === undefined || capability.allowedChannels.includes(channel),
    );
  }

  async get(organizationId: string, slug: string) {
    const page = await this.repository.list(organizationId, { limit: 100 });
    const capability = page.items.find((item) => item.slug === slug.trim().toLowerCase());
    if (capability === undefined) return undefined;
    const handler = this.handlers.get(`${organizationId}:${capability.slug}`);
    if (handler === undefined)
      throw new ValidationError('Capability handler is not loaded in this runtime');
    return { capability, handler };
  }

  async publish(organizationId: string, slug: string) {
    const page = await this.repository.list(organizationId, { limit: 100 });
    const capability = page.items.find((item) => item.slug === slug.trim().toLowerCase());
    if (capability === undefined) throw new ValidationError('Capability not found');
    return capability;
  }
}

export class InMemoryCapabilityRegistry implements CapabilityRegistry {
  private readonly entries = new Map<string, RegisteredCapability>();

  register(
    input: Omit<Capability, keyof TenantEntity> & { handler: CapabilityHandler },
  ): Promise<Capability> {
    if (input.organizationId === '' || input.slug.trim() === '')
      throw new ValidationError('Capability organization and slug are required');
    if (input.timeoutMs <= 0 || !Number.isInteger(input.timeoutMs))
      throw new ValidationError('Capability timeout must be a positive integer');
    const now = new Date();
    const capability: Capability = {
      ...input,
      id: uuidV7(now.getTime()),
      tenantId: input.organizationId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      slug: input.slug.trim().toLowerCase(),
      requiredPermissions: [...new Set(input.requiredPermissions)].sort(),
      allowedChannels: [...new Set(input.allowedChannels)],
    };
    const key = `${input.organizationId}:${capability.slug}`;
    if (this.entries.has(key)) throw new ValidationError('Capability slug already exists');
    this.entries.set(key, { capability, handler: input.handler });
    return Promise.resolve(capability);
  }

  list(organizationId: string, channel?: CapabilityChannel) {
    return Promise.resolve(
      [...this.entries.values()]
        .filter(
          ({ capability }) =>
            capability.organizationId === organizationId &&
            (channel === undefined || capability.allowedChannels.includes(channel)),
        )
        .map(({ capability }) => capability),
    );
  }

  get(organizationId: string, slug: string) {
    return Promise.resolve(this.entries.get(`${organizationId}:${slug.trim().toLowerCase()}`));
  }

  async publish(organizationId: string, slug: string) {
    const entry = await this.get(organizationId, slug);
    if (entry === undefined) throw new ValidationError('Capability not found');
    return entry.capability;
  }
}

export interface CapabilityExecutionHooks {
  authorize(input: { capability: Capability; context: CapabilityExecutionContext }): Promise<void>;
  guardrails?(input: unknown, capability: Capability): Promise<unknown>;
  reserveBudget?(
    capability: Capability,
    context: CapabilityExecutionContext,
  ): Promise<() => Promise<void>>;
  rateLimit?(capability: Capability, context: CapabilityExecutionContext): Promise<void>;
  approval?(capability: Capability, context: CapabilityExecutionContext): Promise<void>;
  audit?(event: {
    organizationId: string;
    principalId: string;
    capabilityId: string;
    outcome: 'SUCCESS' | 'FAILURE';
    requestId?: string;
  }): Promise<void>;
  observe?(observation: CapabilityOperationalObservation): void;
}

export interface CapabilityOperationalObservation {
  readonly operation: 'execute' | 'authorize' | 'policy-denied';
  readonly outcome: 'success' | 'error';
  readonly durationMs: number;
}

export class CapabilityExecutionEngine {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly hooks: CapabilityExecutionHooks,
  ) {}

  async execute(
    slug: string,
    input: unknown,
    context: CapabilityExecutionContext,
  ): Promise<unknown> {
    const startedAt = Date.now();
    const entry = await this.registry.get(context.organizationId, slug);
    if (entry === undefined) {
      this.hooks.observe?.({
        operation: 'execute',
        outcome: 'error',
        durationMs: Date.now() - startedAt,
      });
      throw new ValidationError('Capability is unavailable on this channel');
    }
    const capability = entry.capability;
    if (!capability.allowedChannels.includes(context.channel)) {
      this.hooks.observe?.({
        operation: 'execute',
        outcome: 'error',
        durationMs: Date.now() - startedAt,
      });
      throw new ValidationError('Capability is unavailable on this channel');
    }
    let release: (() => Promise<void>) | undefined;
    try {
      try {
        await this.hooks.authorize({ capability, context });
      } catch (error) {
        this.hooks.observe?.({
          operation: 'policy-denied',
          outcome: 'error',
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
      const guarded =
        this.hooks.guardrails === undefined
          ? input
          : await this.hooks.guardrails(input, capability);
      release =
        this.hooks.reserveBudget === undefined
          ? undefined
          : await this.hooks.reserveBudget(capability, context);
      if (this.hooks.rateLimit !== undefined) await this.hooks.rateLimit(capability, context);
      if (this.hooks.approval !== undefined) await this.hooks.approval(capability, context);
      const result = await this.withTimeout(
        entry.handler(guarded, context),
        capability.timeoutMs,
        context.signal,
      );
      this.hooks.observe?.({
        operation: 'execute',
        outcome: 'success',
        durationMs: Date.now() - startedAt,
      });
      if (release !== undefined) await release();
      await this.hooks.audit?.({
        organizationId: context.organizationId,
        principalId: context.principalId,
        capabilityId: capability.id,
        outcome: 'SUCCESS',
        ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      });
      return result;
    } catch (error) {
      this.hooks.observe?.({
        operation: 'execute',
        outcome: 'error',
        durationMs: Date.now() - startedAt,
      });
      if (release !== undefined) await release().catch(() => Promise.resolve());
      await this.hooks.audit?.({
        organizationId: context.organizationId,
        principalId: context.principalId,
        capabilityId: capability.id,
        outcome: 'FAILURE',
        ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      });
      throw error;
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Capability execution timed out'));
      }, timeoutMs);
      const abort = () => {
        reject(new Error('Capability execution aborted'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      promise.then(
        (value) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}
