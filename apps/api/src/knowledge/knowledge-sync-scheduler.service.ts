import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { KnowledgeRuntimeService } from './knowledge-runtime.service.js';
import { DatabaseService } from '../database/database.service.js';
import { repositoryName, type Repository, type TenantEntity } from '@handstack/domain';
import type { DataSourceType } from '@handstack/knowledge';
import type { Organization } from '@handstack/identity';
import { configFromEnvironment, type HandStackConfig } from '@handstack/config';

interface KnowledgeSyncSchedulerLease extends TenantEntity {
  readonly organizationId: string;
  readonly ownerId: string;
  readonly leaseUntil: number;
}

const SCHEDULABLE_SOURCE_TYPES: ReadonlySet<DataSourceType> = new Set([
  'URL',
  'GITHUB',
  'GOOGLE_DRIVE',
  'SHAREPOINT',
  'CONFLUENCE',
  'NOTION',
  'S3',
]);

/** Opt-in scheduler for source types with a concrete connector. */
@Injectable()
export class KnowledgeSyncSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KnowledgeSyncSchedulerService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly config: HandStackConfig = configFromEnvironment(process.env);
  private readonly ownerId = this.config.knowledgeSync.instanceId ?? crypto.randomUUID();
  private readonly leases: Repository<KnowledgeSyncSchedulerLease> | undefined;

  constructor(
    @Inject(forwardRef(() => KnowledgeRuntimeService))
    private readonly knowledge: KnowledgeRuntimeService,
    @Optional() @Inject(DatabaseService) private readonly database?: DatabaseService,
  ) {
    this.leases =
      database === undefined || typeof database.adapter.repository !== 'function'
        ? undefined
        : database.adapter.repository(repositoryName('knowledge-sync-scheduler-leases'));
  }

  onModuleInit(): void {
    if (!this.config.knowledgeSync.enabled) return;
    const intervalMs = this.config.knowledgeSync.intervalMs;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        this.logger.error('Knowledge source sync tick failed');
      });
    }, intervalMs);
    this.timer.unref();
    void this.tick().catch(() => {
      this.logger.error('Initial Knowledge source sync failed');
    });
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let synchronized = 0;
    try {
      for (const organizationId of await this.organizations())
        synchronized += await this.runOrganization(organizationId);
      return synchronized;
    } finally {
      this.running = false;
    }
  }

  private async runOrganization(organizationId: string): Promise<number> {
    if (!(await this.acquire(organizationId))) return 0;
    try {
      let synchronized = 0;
      for (const document of await this.knowledge.listDocuments(organizationId)) {
        if (!SCHEDULABLE_SOURCE_TYPES.has(document.sourceType)) continue;
        if (!(await this.acquire(organizationId))) break;
        await this.knowledge.syncUrl(organizationId, document.id);
        synchronized += 1;
      }
      return synchronized;
    } finally {
      await this.release(organizationId);
    }
  }

  private async acquire(organizationId: string): Promise<boolean> {
    if (this.leases === undefined) return true;
    const id = `${organizationId}:knowledge-sync`;
    const current = await this.leases.findById(organizationId, id);
    const now = Date.now();
    if (current !== undefined && current.ownerId !== this.ownerId && current.leaseUntil > now)
      return false;
    const timestamp = new Date(now);
    const next: KnowledgeSyncSchedulerLease = {
      id,
      tenantId: organizationId,
      organizationId,
      ownerId: this.ownerId,
      leaseUntil: now + this.leaseDurationMs(),
      version: (current?.version ?? 0) + 1,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    try {
      if (current === undefined) await this.leases.insert(next);
      else await this.leases.update(next, current.version);
      return true;
    } catch {
      // A competing scheduler won the compare-and-swap; skipping this tenant is safe.
      return false;
    }
  }

  private async release(organizationId: string): Promise<void> {
    if (this.leases === undefined) return;
    const id = `${organizationId}:knowledge-sync`;
    const current = await this.leases.findById(organizationId, id);
    if (current?.ownerId !== this.ownerId) return;
    await this.leases.update(
      { ...current, leaseUntil: 0, version: current.version + 1, updatedAt: new Date() },
      current.version,
    );
  }

  private leaseDurationMs(): number {
    return Math.max(60_000, this.config.knowledgeSync.intervalMs * 3);
  }

  private async organizations(): Promise<readonly string[]> {
    const configured = this.config.knowledgeSync.organizations;
    if (configured.length > 0) return configured;
    if (this.database?.adapter.listAll === undefined) return [];
    const values: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.database.adapter.listAll<Organization>(
        repositoryName('identity-organizations'),
        { limit: 200, ...(cursor === undefined ? {} : { cursor }) },
      );
      values.push(...page.items.filter((item) => item.status === 'ACTIVE').map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return values;
  }
}
