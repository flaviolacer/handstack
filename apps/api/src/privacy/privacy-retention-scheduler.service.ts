import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { repositoryName, type Repository, type TenantEntity } from '@handstack/domain';
import type { Organization } from '@handstack/identity';
import { configFromEnvironment, type HandStackConfig } from '@handstack/config';
import { DatabaseService } from '../database/database.service.js';
import { PrivacyRuntimeService } from './privacy-runtime.service.js';
import { WebhookRuntimeService } from '../webhooks/webhook-runtime.service.js';

interface RetentionSchedulerLease extends TenantEntity {
  readonly organizationId: string;
  readonly ownerId: string;
  readonly leaseUntil: number;
}

/** Opt-in tenant scheduler for the privacy retention executor. */
@Injectable()
export class PrivacyRetentionSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrivacyRetentionSchedulerService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private ownerId: string | undefined;
  private readonly leases: Repository<RetentionSchedulerLease> | undefined;

  constructor(
    @Inject(PrivacyRuntimeService) private readonly privacy: PrivacyRuntimeService,
    @Optional() @Inject(DatabaseService) private readonly database?: DatabaseService,
    @Optional() @Inject(WebhookRuntimeService) private readonly webhooks?: WebhookRuntimeService,
  ) {
    this.leases =
      database === undefined || typeof database.adapter.repository !== 'function'
        ? undefined
        : database.adapter.repository(repositoryName('privacy-retention-scheduler-leases'));
  }

  async onModuleInit(): Promise<void> {
    const config = this.schedulerConfig();
    if (!config.enabled) return;
    const organizations = await this.organizations();
    if (organizations.length === 0)
      throw new Error('Privacy retention scheduler requires active organizations');
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        this.logger.error('Privacy retention scheduler tick failed');
      });
    }, config.intervalMs);
    this.timer.unref();
    void this.tick(organizations).catch(() => {
      this.logger.error('Initial privacy retention scheduler tick failed');
    });
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(organizations?: readonly string[]): Promise<void> {
    const selected = organizations ?? (await this.organizations());
    if (this.running || selected.length === 0) return;
    this.running = true;
    try {
      const outcomes = await Promise.allSettled(
        selected.map(async (organizationId) => {
          if (!(await this.acquire(organizationId))) return;
          try {
            const actorId = 'system:privacy-retention-scheduler';
            await this.privacy.runConversationRetention(organizationId, actorId);
            await this.privacy.runUsageRetention(organizationId, actorId);
            await this.privacy.runAttachmentRetention(organizationId, actorId);
            await this.privacy.runTraceRetention(organizationId, actorId);
            await this.webhooks?.prune(organizationId);
          } finally {
            await this.release(organizationId);
          }
        }),
      );
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed?.status === 'rejected')
        throw new Error('Privacy retention failed for at least one organization', {
          cause: failed.reason,
        });
    } finally {
      this.running = false;
    }
  }

  private async acquire(organizationId: string): Promise<boolean> {
    if (this.leases === undefined) return true;
    const id = `${organizationId}:privacy-retention`;
    const current = await this.leases.findById(organizationId, id);
    const now = Date.now();
    if (current !== undefined && current.ownerId !== this.getOwnerId() && current.leaseUntil > now)
      return false;
    const timestamp = new Date(now);
    const next: RetentionSchedulerLease = {
      id,
      tenantId: organizationId,
      organizationId,
      ownerId: this.getOwnerId(),
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
      // Another scheduler instance won the compare-and-swap; skipping this tenant is safe.
      return false;
    }
  }

  private async release(organizationId: string): Promise<void> {
    if (this.leases === undefined) return;
    const id = `${organizationId}:privacy-retention`;
    const current = await this.leases.findById(organizationId, id);
    if (current?.ownerId !== this.getOwnerId()) return;
    await this.leases.update(
      { ...current, leaseUntil: 0, version: current.version + 1, updatedAt: new Date() },
      current.version,
    );
  }

  private leaseDurationMs(): number {
    return Math.max(60_000, this.intervalMs() * 3);
  }

  private async organizations(): Promise<readonly string[]> {
    const configured = this.schedulerConfig().organizations;
    if (configured.length > 0) return configured;
    if (this.database?.adapter.listAll === undefined) return [];
    const organizations: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.database.adapter.listAll<Organization>(
        repositoryName('identity-organizations'),
        { limit: 200, ...(cursor === undefined ? {} : { cursor }) },
      );
      organizations.push(
        ...page.items
          .filter((organization) => organization.status === 'ACTIVE')
          .map((organization) => organization.id),
      );
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return organizations;
  }

  private intervalMs(): number {
    return this.schedulerConfig().intervalMs;
  }

  private schedulerConfig(): HandStackConfig['privacyRetention'] {
    return configFromEnvironment(process.env).privacyRetention;
  }

  private getOwnerId(): string {
    return (this.ownerId ??= this.schedulerConfig().instanceId ?? crypto.randomUUID());
  }
}
