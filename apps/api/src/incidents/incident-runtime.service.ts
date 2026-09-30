import { Injectable } from '@nestjs/common';
import {
  DefaultIncidentManagementProvider,
  InMemoryIncidentStore,
  InMemoryStatusPageProvider,
  InMemoryIncidentNotificationDispatcher,
  RepositoryIncidentStore,
  RepositoryIncidentEscalationPolicyStore,
  type Incident,
  type IncidentManagementProvider,
  type IncidentEscalationPolicy,
} from '@handstack/incidents';
import { DatabaseService } from '../database/database.service.js';
import { EventBusRuntimeService } from '../core/event-bus-runtime.service.js';
import { publishRuntimeDomainEvent } from '../core/runtime-domain-event.js';
import type { DomainEventContext } from '@handstack/core';

@Injectable()
export class IncidentRuntimeService {
  readonly statusPage = new InMemoryStatusPageProvider();
  readonly notifications = new InMemoryIncidentNotificationDispatcher();
  private readonly provider: IncidentManagementProvider;
  constructor(database?: DatabaseService, eventBus?: EventBusRuntimeService) {
    this.eventBus = eventBus?.bus;
    const store =
      database === undefined
        ? new InMemoryIncidentStore()
        : new RepositoryIncidentStore((name) => database.adapter.repository(name));
    this.provider = new DefaultIncidentManagementProvider(
      store,
      this.statusPage,
      this.notifications,
      database === undefined
        ? undefined
        : new RepositoryIncidentEscalationPolicyStore((name) => database.adapter.repository(name)),
    );
  }
  private readonly eventBus: EventBusRuntimeService['bus'] | undefined;
  async create(input: Omit<Incident, 'timeline'>, context?: DomainEventContext): Promise<Incident> {
    const incident = await this.provider.create(input);
    await this.publish('incident.created', incident, { actor: incident.owner }, context);
    return incident;
  }
  get(organizationId: string, id: string): Promise<Incident | undefined> {
    return this.provider.get(organizationId, id);
  }
  list(organizationId: string): Promise<readonly Incident[]> {
    return this.provider.list(organizationId);
  }
  async transition(
    input: Parameters<IncidentManagementProvider['transition']>[0],
    context?: DomainEventContext,
  ): Promise<Incident> {
    const incident = await this.provider.transition(input);
    await this.publish('incident.transitioned', incident, { actor: input.actor }, context);
    return incident;
  }
  async addTimeline(
    input: Parameters<IncidentManagementProvider['addTimeline']>[0],
    context?: DomainEventContext,
  ): Promise<Incident> {
    const incident = await this.provider.addTimeline(input);
    await this.publish('incident.timeline_added', incident, { actor: input.actor }, context);
    return incident;
  }
  async updateAction(
    input: Parameters<IncidentManagementProvider['updateAction']>[0],
    context?: DomainEventContext,
  ): Promise<Incident> {
    const incident = await this.provider.updateAction(input);
    await this.publish('incident.action_updated', incident, { actionId: input.actionId }, context);
    return incident;
  }

  private async publish(
    type: string,
    incident: Incident,
    details: Record<string, string>,
    context?: DomainEventContext,
  ) {
    await publishRuntimeDomainEvent(this.eventBus, {
      organizationId: incident.organizationId,
      type,
      payload: {
        incidentId: incident.id,
        status: incident.status,
        severity: incident.severity,
        ...details,
      },
      ...(context === undefined ? {} : { context }),
    });
  }
  setEscalationPolicy(policy: IncidentEscalationPolicy): Promise<IncidentEscalationPolicy> {
    return this.provider.setEscalationPolicy(policy);
  }
  getEscalationPolicy(
    organizationId: string,
    capability: string,
  ): Promise<IncidentEscalationPolicy | undefined> {
    return this.provider.getEscalationPolicy(organizationId, capability);
  }
  publicList(): Promise<readonly Incident[]> {
    return Promise.resolve(
      this.statusPage.published.map((incident) => ({
        ...incident,
        affectedOrganizations: [],
        correctiveActions: [],
      })),
    );
  }
}
