import {
  forwardRef,
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { WorkflowRuntimeService } from './workflow-runtime.service.js';
import { DatabaseService } from '../database/database.service.js';
import { repositoryName, type Repository, type TenantEntity } from '@handstack/domain';
import type { Organization } from '@handstack/identity';
import { configFromEnvironment, type HandStackConfig } from '@handstack/config';

interface SchedulerLease extends TenantEntity {
  readonly organizationId: string;
  readonly ownerId: string;
  readonly leaseUntil: number;
}

/**
 * Runs due schedule triggers for the organizations explicitly assigned to this
 * API instance. Explicit assignment keeps the scheduler tenant-safe and makes
 * ownership visible in distributed deployments.
 */
@Injectable()
export class WorkflowSchedulerService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly config: HandStackConfig = configFromEnvironment(process.env);
  private readonly ownerId = this.config.workflowScheduler.instanceId ?? crypto.randomUUID();
  private readonly leases: Repository<SchedulerLease> | undefined;

  constructor(
    @Inject(forwardRef(() => WorkflowRuntimeService))
    private readonly workflows: WorkflowRuntimeService,
    @Optional()
    @Inject(forwardRef(() => DatabaseService))
    private readonly database?: DatabaseService,
  ) {
    this.leases =
      database === undefined || typeof database.adapter.repository !== 'function'
        ? undefined
        : database.adapter.repository(repositoryName('workflow-scheduler-leases'));
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.workflowScheduler.enabled) return;
    const organizations = await this.organizations();
    if (organizations.length === 0) throw new Error('Workflow scheduler requires organizations');
    const intervalMs = this.intervalMs();
    this.timer = setInterval(() => void this.tick(organizations), intervalMs);
    void this.tick(organizations);
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(organizations?: readonly string[], now?: Date): Promise<void> {
    const selected = organizations ?? (await this.organizations());
    if (this.running || selected.length === 0) return;
    this.running = true;
    try {
      await Promise.all(
        selected.map((organizationId) => this.runOrganization(organizationId, now)),
      );
    } finally {
      this.running = false;
    }
  }

  private async runOrganization(organizationId: string, now?: Date): Promise<void> {
    if (!(await this.acquire(organizationId))) return;
    try {
      await this.workflows.dispatchDueSchedules({
        organizationId,
        principalId: this.config.workflowScheduler.principal,
        payload: { source: 'workflow-scheduler' },
        ...(now === undefined ? {} : { now }),
      });
    } finally {
      await this.release(organizationId);
    }
  }

  private async acquire(organizationId: string): Promise<boolean> {
    if (this.leases === undefined) return true;
    const id = `${organizationId}:workflow-scheduler`;
    const current = await this.leases.findById(organizationId, id);
    const now = Date.now();
    if (current !== undefined && current.ownerId !== this.ownerId && current.leaseUntil > now)
      return false;
    const timestamp = new Date(now);
    const next: SchedulerLease = {
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
      // Another scheduler won the CAS race. It is safe to skip this tenant.
      return false;
    }
  }

  private async release(organizationId: string): Promise<void> {
    if (this.leases === undefined) return;
    const id = `${organizationId}:workflow-scheduler`;
    const current = await this.leases.findById(organizationId, id);
    if (current?.ownerId !== this.ownerId) return;
    await this.leases.update(
      { ...current, leaseUntil: 0, version: current.version + 1, updatedAt: new Date() },
      current.version,
    );
  }

  private leaseDurationMs(): number {
    const interval = this.intervalMs();
    return Math.max(30_000, interval * 3);
  }

  private async organizations(): Promise<readonly string[]> {
    const configured =
      this.config.workflowScheduler.organizations.length > 0
        ? this.config.workflowScheduler.organizations
        : configFromEnvironment(process.env).workflowScheduler.organizations;
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
          .map(({ id }) => id),
      );
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return organizations;
  }

  private intervalMs(): number {
    return this.config.workflowScheduler.intervalMs;
  }
}
