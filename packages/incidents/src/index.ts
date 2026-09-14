import { randomUUID } from 'node:crypto';
import {
  repositoryName,
  type Repository,
  type RepositoryName,
  type TenantEntity,
} from '@handstack/domain';
import { ValidationError } from '@handstack/shared';

export type IncidentSeverity = 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';
export type IncidentStatus =
  | 'DETECTED'
  | 'INVESTIGATING'
  | 'IDENTIFIED'
  | 'MITIGATING'
  | 'MONITORING'
  | 'RESOLVED'
  | 'POSTMORTEM';
export interface IncidentTimelineEntry {
  readonly id: string;
  readonly at: Date;
  readonly actor: string;
  readonly message: string;
  readonly customerSafe: boolean;
}
export interface CorrectiveAction {
  readonly id: string;
  readonly description: string;
  readonly owner?: string;
  readonly dueAt?: Date;
  readonly completedAt?: Date;
}
export interface IncidentEscalationPolicy {
  readonly organizationId: string;
  readonly capability: string;
  readonly levels: readonly { readonly afterMinutes: number; readonly owner: string }[];
}
export type IncidentLifecycleEvent =
  | 'INCIDENT_CREATED'
  | 'INCIDENT_TRANSITIONED'
  | 'INCIDENT_TIMELINE_ADDED'
  | 'INCIDENT_ACTION_UPDATED';
export interface IncidentNotification {
  readonly id: string;
  readonly organizationId: string;
  readonly event: IncidentLifecycleEvent;
  readonly incidentId: string;
  readonly recipient: string;
  readonly message: string;
}
export interface IncidentNotificationDispatcher {
  dispatch(notification: IncidentNotification): Promise<void>;
}
export interface Incident {
  readonly id: string;
  readonly organizationId: string;
  readonly severity: IncidentSeverity;
  readonly status: IncidentStatus;
  readonly startedAt: Date;
  readonly detectedAt: Date;
  readonly acknowledgedAt?: Date;
  readonly resolvedAt?: Date;
  readonly affectedOrganizations: readonly string[];
  readonly affectedCapabilities: readonly string[];
  readonly owner: string;
  readonly timeline: readonly IncidentTimelineEntry[];
  readonly customerImpact: string;
  readonly rootCause?: string;
  readonly correctiveActions: readonly CorrectiveAction[];
}
export interface IncidentStore {
  create(incident: Incident): Promise<Incident>;
  get(organizationId: string, id: string): Promise<Incident | undefined>;
  list(organizationId: string): Promise<readonly Incident[]>;
  update(incident: Incident, expectedVersion?: number): Promise<Incident>;
}
export interface IncidentManagementProvider {
  create(
    input: Omit<Incident, 'timeline'> & { timeline?: readonly IncidentTimelineEntry[] },
  ): Promise<Incident>;
  get(organizationId: string, id: string): Promise<Incident | undefined>;
  list(organizationId: string): Promise<readonly Incident[]>;
  transition(input: {
    organizationId: string;
    id: string;
    status: IncidentStatus;
    actor: string;
    message?: string;
  }): Promise<Incident>;
  addTimeline(input: {
    organizationId: string;
    id: string;
    actor: string;
    message: string;
    customerSafe: boolean;
  }): Promise<Incident>;
  updateAction(input: {
    organizationId: string;
    id: string;
    actionId: string;
    description?: string;
    owner?: string;
    dueAt?: Date;
    completed?: boolean;
  }): Promise<Incident>;
  setEscalationPolicy(policy: IncidentEscalationPolicy): Promise<IncidentEscalationPolicy>;
  getEscalationPolicy(
    organizationId: string,
    capability: string,
  ): Promise<IncidentEscalationPolicy | undefined>;
  export(organizationId: string, id: string): Promise<Incident>;
}
export interface StatusPageProvider {
  publish(incident: Incident): Promise<void>;
}
export class InMemoryStatusPageProvider implements StatusPageProvider {
  readonly published: Incident[] = [];
  publish(incident: Incident): Promise<void> {
    this.published.push(publicIncident(incident));
    return Promise.resolve();
  }
}
export class InMemoryIncidentNotificationDispatcher implements IncidentNotificationDispatcher {
  readonly sent: IncidentNotification[] = [];
  dispatch(notification: IncidentNotification): Promise<void> {
    if (this.sent.some((item) => item.id === notification.id)) return Promise.resolve();
    this.sent.push({ ...notification });
    return Promise.resolve();
  }
}

interface IncidentEntity extends TenantEntity {
  readonly incident: Incident;
}
export class RepositoryIncidentStore implements IncidentStore {
  private readonly repository: Repository<IncidentEntity>;
  constructor(factory: <T extends TenantEntity>(name: RepositoryName) => Repository<T>) {
    this.repository = factory<IncidentEntity>(repositoryName('incidents'));
  }
  async create(incident: Incident): Promise<Incident> {
    const now = new Date();
    await this.repository.insert({
      id: incident.id,
      tenantId: incident.organizationId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      incident: clone(incident),
    });
    return clone(incident);
  }
  async get(organizationId: string, id: string): Promise<Incident | undefined> {
    const entity = await this.repository.findById(organizationId, id);
    return entity === undefined ? undefined : clone(entity.incident);
  }
  async list(organizationId: string): Promise<readonly Incident[]> {
    const page = await this.repository.list(organizationId, { limit: 200 });
    return page.items.map((item) => clone(item.incident));
  }
  async update(incident: Incident, expectedVersion?: number): Promise<Incident> {
    const entity = await this.repository.findById(incident.organizationId, incident.id);
    if (entity === undefined) throw new ValidationError('Incident not found');
    await this.repository.update(
      { ...entity, version: entity.version, updatedAt: new Date(), incident: clone(incident) },
      expectedVersion ?? entity.version,
    );
    return clone(incident);
  }
}
export class InMemoryIncidentStore implements IncidentStore {
  private readonly values = new Map<string, { incident: Incident; version: number }>();
  create(incident: Incident): Promise<Incident> {
    const key = `${incident.organizationId}:${incident.id}`;
    if (this.values.has(key)) return Promise.reject(new ValidationError('Incident already exists'));
    this.values.set(key, { incident: clone(incident), version: 1 });
    return Promise.resolve(clone(incident));
  }
  get(organizationId: string, id: string): Promise<Incident | undefined> {
    const item = this.values.get(`${organizationId}:${id}`);
    return Promise.resolve(item === undefined ? undefined : clone(item.incident));
  }
  list(organizationId: string): Promise<readonly Incident[]> {
    return Promise.resolve(
      [...this.values.values()]
        .filter((item) => item.incident.organizationId === organizationId)
        .map((item) => clone(item.incident)),
    );
  }
  update(incident: Incident, expectedVersion?: number): Promise<Incident> {
    const key = `${incident.organizationId}:${incident.id}`;
    const current = this.values.get(key);
    if (current === undefined) return Promise.reject(new ValidationError('Incident not found'));
    if (expectedVersion !== undefined && current.version !== expectedVersion)
      return Promise.reject(new ValidationError('Incident version conflict'));
    this.values.set(key, { incident: clone(incident), version: current.version + 1 });
    return Promise.resolve(clone(incident));
  }
}
export class DefaultIncidentManagementProvider implements IncidentManagementProvider {
  private readonly policies = new Map<string, IncidentEscalationPolicy>();
  constructor(
    private readonly store: IncidentStore,
    private readonly statusPage?: StatusPageProvider,
    private readonly notifications?: IncidentNotificationDispatcher,
  ) {}
  async create(
    input: Omit<Incident, 'timeline'> & { timeline?: readonly IncidentTimelineEntry[] },
  ): Promise<Incident> {
    validateBase(input);
    const incident: Incident = {
      ...input,
      timeline: input.timeline === undefined ? [] : input.timeline.map(cloneEntry),
    };
    const saved = await this.store.create(incident);
    await this.notify(saved, 'INCIDENT_CREATED', saved.owner, 'Incident registered');
    return saved;
  }
  get(organizationId: string, id: string) {
    return this.store.get(organizationId, id);
  }
  list(organizationId: string) {
    return this.store.list(organizationId);
  }
  async transition(input: {
    organizationId: string;
    id: string;
    status: IncidentStatus;
    actor: string;
    message?: string;
  }): Promise<Incident> {
    const incident = await this.require(input.organizationId, input.id);
    if (
      !allowedTransitions[incident.status].includes(input.status) &&
      incident.status !== input.status
    )
      throw new ValidationError(
        `Invalid incident transition: ${incident.status} -> ${input.status}`,
      );
    const at = new Date();
    const next: Incident = {
      ...incident,
      status: input.status,
      ...(input.status === 'INVESTIGATING' && incident.acknowledgedAt === undefined
        ? { acknowledgedAt: at }
        : {}),
      ...(input.status === 'RESOLVED' ? { resolvedAt: at } : {}),
      timeline:
        input.message === undefined
          ? incident.timeline
          : [
              ...incident.timeline,
              {
                id: randomUUID(),
                at,
                actor: input.actor,
                message: input.message,
                customerSafe: true,
              },
            ],
    };
    const saved = await this.store.update(next);
    await this.notify(saved, 'INCIDENT_TRANSITIONED', saved.owner, `Status: ${saved.status}`);
    if (
      this.statusPage !== undefined &&
      (input.status === 'MONITORING' || input.status === 'RESOLVED')
    )
      await this.statusPage.publish(saved);
    return saved;
  }
  async addTimeline(input: {
    organizationId: string;
    id: string;
    actor: string;
    message: string;
    customerSafe: boolean;
  }): Promise<Incident> {
    if (input.message.trim() === '') throw new ValidationError('Timeline message is required');
    const incident = await this.require(input.organizationId, input.id);
    const saved = await this.store.update({
      ...incident,
      timeline: [
        ...incident.timeline,
        {
          id: randomUUID(),
          at: new Date(),
          actor: input.actor,
          message: input.message,
          customerSafe: input.customerSafe,
        },
      ],
    });
    await this.notify(saved, 'INCIDENT_TIMELINE_ADDED', saved.owner, input.message);
    return saved;
  }
  async updateAction(input: {
    organizationId: string;
    id: string;
    actionId: string;
    description?: string;
    owner?: string;
    dueAt?: Date;
    completed?: boolean;
  }): Promise<Incident> {
    const incident = await this.require(input.organizationId, input.id);
    const current = incident.correctiveActions.find((action) => action.id === input.actionId);
    if (current === undefined) throw new ValidationError('Corrective action not found');
    const action: CorrectiveAction = {
      ...current,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.owner === undefined ? {} : { owner: input.owner }),
      ...(input.dueAt === undefined ? {} : { dueAt: new Date(input.dueAt) }),
      ...(input.completed === true ? { completedAt: new Date() } : {}),
    };
    const saved = await this.store.update({
      ...incident,
      correctiveActions: incident.correctiveActions.map((item) =>
        item.id === input.actionId ? action : item,
      ),
    });
    await this.notify(
      saved,
      'INCIDENT_ACTION_UPDATED',
      action.owner ?? saved.owner,
      action.description,
    );
    return saved;
  }
  setEscalationPolicy(policy: IncidentEscalationPolicy): Promise<IncidentEscalationPolicy> {
    if (
      policy.organizationId.trim() === '' ||
      policy.capability.trim() === '' ||
      policy.levels.length === 0
    )
      throw new ValidationError('Escalation policy is invalid');
    if (policy.levels.some((level) => level.afterMinutes < 0 || level.owner.trim() === ''))
      throw new ValidationError('Escalation policy levels are invalid');
    const saved = { ...policy, levels: policy.levels.map((level) => ({ ...level })) };
    this.policies.set(`${policy.organizationId}:${policy.capability}`, saved);
    return Promise.resolve(saved);
  }
  getEscalationPolicy(
    organizationId: string,
    capability: string,
  ): Promise<IncidentEscalationPolicy | undefined> {
    const policy = this.policies.get(`${organizationId}:${capability}`);
    return Promise.resolve(
      policy === undefined
        ? undefined
        : { ...policy, levels: policy.levels.map((level) => ({ ...level })) },
    );
  }
  async export(organizationId: string, id: string): Promise<Incident> {
    return this.require(organizationId, id);
  }
  private async require(organizationId: string, id: string): Promise<Incident> {
    const incident = await this.store.get(organizationId, id);
    if (incident === undefined) throw new ValidationError('Incident not found');
    return incident;
  }
  private async notify(
    incident: Incident,
    event: IncidentLifecycleEvent,
    recipient: string,
    message: string,
  ): Promise<void> {
    if (this.notifications === undefined) return;
    await this.notifications.dispatch({
      id: `${incident.id}:${event}:${String(incident.timeline.length)}:${incident.status}`,
      organizationId: incident.organizationId,
      event,
      incidentId: incident.id,
      recipient,
      message,
    });
  }
}
const allowedTransitions: Record<IncidentStatus, readonly IncidentStatus[]> = {
  DETECTED: ['INVESTIGATING'],
  INVESTIGATING: ['IDENTIFIED', 'MITIGATING'],
  IDENTIFIED: ['MITIGATING'],
  MITIGATING: ['MONITORING', 'RESOLVED'],
  MONITORING: ['RESOLVED', 'MITIGATING'],
  RESOLVED: ['POSTMORTEM'],
  POSTMORTEM: [],
};
function validateBase(
  incident: Pick<Incident, 'organizationId' | 'id' | 'owner' | 'customerImpact'>,
): void {
  if (
    incident.organizationId.trim() === '' ||
    incident.id.trim() === '' ||
    incident.owner.trim() === ''
  )
    throw new ValidationError('Incident identity is required');
  if (incident.customerImpact.trim() === '')
    throw new ValidationError('Customer impact is required');
}
function cloneEntry(entry: IncidentTimelineEntry): IncidentTimelineEntry {
  return { ...entry, at: new Date(entry.at) };
}
function clone(incident: Incident): Incident {
  return {
    ...incident,
    startedAt: new Date(incident.startedAt),
    detectedAt: new Date(incident.detectedAt),
    ...(incident.acknowledgedAt === undefined
      ? {}
      : { acknowledgedAt: new Date(incident.acknowledgedAt) }),
    ...(incident.resolvedAt === undefined ? {} : { resolvedAt: new Date(incident.resolvedAt) }),
    affectedOrganizations: [...incident.affectedOrganizations],
    affectedCapabilities: [...incident.affectedCapabilities],
    timeline: incident.timeline.map(cloneEntry),
    correctiveActions: incident.correctiveActions.map((action) => ({
      ...action,
      ...(action.dueAt === undefined ? {} : { dueAt: new Date(action.dueAt) }),
      ...(action.completedAt === undefined ? {} : { completedAt: new Date(action.completedAt) }),
    })),
  };
}
function publicIncident(incident: Incident): Incident {
  const cloned = clone(incident);
  const safe = Object.fromEntries(
    Object.entries(cloned).filter(([key]) => key !== 'rootCause'),
  ) as Omit<Incident, 'rootCause'>;
  return { ...safe, correctiveActions: [] };
}
