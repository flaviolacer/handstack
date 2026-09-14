import { Injectable } from '@nestjs/common';
import {
  DefaultIncidentManagementProvider,
  InMemoryIncidentStore,
  InMemoryStatusPageProvider,
  InMemoryIncidentNotificationDispatcher,
  RepositoryIncidentStore,
  type Incident,
  type IncidentManagementProvider,
  type IncidentEscalationPolicy,
} from '@handstack/incidents';
import { DatabaseService } from '../database/database.service.js';

@Injectable()
export class IncidentRuntimeService {
  readonly statusPage = new InMemoryStatusPageProvider();
  readonly notifications = new InMemoryIncidentNotificationDispatcher();
  private readonly provider: IncidentManagementProvider;
  constructor(database?: DatabaseService) {
    const store =
      database === undefined
        ? new InMemoryIncidentStore()
        : new RepositoryIncidentStore((name) => database.adapter.repository(name));
    this.provider = new DefaultIncidentManagementProvider(
      store,
      this.statusPage,
      this.notifications,
    );
  }
  create(input: Omit<Incident, 'timeline'>): Promise<Incident> {
    return this.provider.create(input);
  }
  get(organizationId: string, id: string): Promise<Incident | undefined> {
    return this.provider.get(organizationId, id);
  }
  list(organizationId: string): Promise<readonly Incident[]> {
    return this.provider.list(organizationId);
  }
  transition(input: Parameters<IncidentManagementProvider['transition']>[0]): Promise<Incident> {
    return this.provider.transition(input);
  }
  addTimeline(input: Parameters<IncidentManagementProvider['addTimeline']>[0]): Promise<Incident> {
    return this.provider.addTimeline(input);
  }
  updateAction(
    input: Parameters<IncidentManagementProvider['updateAction']>[0],
  ): Promise<Incident> {
    return this.provider.updateAction(input);
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
