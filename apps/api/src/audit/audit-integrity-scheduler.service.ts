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
import { OperationsRuntimeService } from '../operations/operations-runtime.service.js';

interface AuditIntegritySchedulerLease extends TenantEntity {
  readonly organizationId: string;
  readonly ownerId: string;
  readonly leaseUntil: number;
}

/** Opt-in tenant scheduler that verifies the tamper-evident audit chain. */
@Injectable()
export class AuditIntegritySchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditIntegritySchedulerService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private ownerId: string | undefined;
  private readonly leases: Repository<AuditIntegritySchedulerLease> | undefined;

  constructor(
    @Inject(OperationsRuntimeService) private readonly operations: OperationsRuntimeService,
    @Optional() @Inject(DatabaseService) private readonly database?: DatabaseService,
  ) {
    this.leases =
      database === undefined || typeof database.adapter.repository !== 'function'
        ? undefined
        : database.adapter.repository(repositoryName('audit-integrity-scheduler-leases'));
  }

  async onModuleInit(): Promise<void> {
    const config = this.schedulerConfig();
    if (!config.enabled) return;
    const organizations = await this.organizations();
    if (organizations.length === 0)
      throw new Error('Audit integrity scheduler requires active organizations');
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        this.logger.error('Audit integrity scheduler tick failed');
      });
    }, config.intervalMs);
    this.timer.unref();
    void this.tick(organizations).catch(() => {
      this.logger.error('Initial audit integrity scheduler tick failed');
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
            const result = await this.operations.audit.verify(organizationId);
            if (!result.valid)
              throw new Error(`Audit integrity verification failed for ${organizationId}`);
            await this.operations.audit.record({
              organizationId,
              actorId: 'system:audit-integrity-scheduler',
              actorType: 'SYSTEM',
              action: 'AUDIT_VERIFIED',
              resourceType: 'audit',
              decision: 'ALLOW',
              metadata: {
                checked: String(result.checked),
                valid: 'true',
                scheduled: 'true',
              },
            });
          } finally {
            await this.release(organizationId);
          }
        }),
      );
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed?.status === 'rejected')
        throw new Error('Audit integrity verification failed for at least one organization', {
          cause: failed.reason,
        });
    } finally {
      this.running = false;
    }
  }

  private async acquire(organizationId: string): Promise<boolean> {
    if (this.leases === undefined) return true;
    const id = `${organizationId}:audit-integrity`;
    const current = await this.leases.findById(organizationId, id);
    const now = Date.now();
    if (current !== undefined && current.ownerId !== this.getOwnerId() && current.leaseUntil > now)
      return false;
    const timestamp = new Date(now);
    const next: AuditIntegritySchedulerLease = {
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
      return false;
    }
  }

  private async release(organizationId: string): Promise<void> {
    if (this.leases === undefined) return;
    const id = `${organizationId}:audit-integrity`;
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

  private schedulerConfig(): HandStackConfig['auditIntegrity'] {
    return configFromEnvironment(process.env).auditIntegrity;
  }

  private getOwnerId(): string {
    return (this.ownerId ??= this.schedulerConfig().instanceId ?? crypto.randomUUID());
  }
}
