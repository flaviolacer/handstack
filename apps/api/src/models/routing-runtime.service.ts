import { repositoryName, uuidV7, type Repository, type TenantEntity } from '@handstack/domain';
import { validateRoutingPolicy, type RoutingPolicy } from '@handstack/model-routing';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { listAllTenant } from '../database/pagination.js';

type StoredRoutingPolicy = RoutingPolicy & TenantEntity;
const routingRepository = repositoryName('model-routing-policies');

@Injectable()
export class RoutingRuntimeService {
  private readonly policies: Repository<StoredRoutingPolicy>;

  constructor(@Inject(DatabaseService) database: DatabaseService) {
    this.policies = database.adapter.repository(routingRepository);
  }

  async list(organizationId: string): Promise<readonly StoredRoutingPolicy[]> {
    return listAllTenant(this.policies, organizationId);
  }

  async create(organizationId: string, input: Omit<RoutingPolicy, 'organizationId' | 'id'>) {
    const policy: StoredRoutingPolicy = {
      ...input,
      organizationId,
      tenantId: organizationId,
      id: uuidV7(),
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    validateRoutingPolicy(policy);
    return this.policies.insert(policy);
  }
}
