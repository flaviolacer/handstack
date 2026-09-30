import { repositoryName, uuidV7, type Repository, type TenantEntity } from '@handstack/domain';
import {
  PersistentPolicyEngine,
  type AuthorizationPolicy,
  type AuthorizationRequest,
} from '@handstack/policy';
import { Injectable, Inject } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { listAllTenant } from '../database/pagination.js';

type StoredPolicy = AuthorizationPolicy & TenantEntity;
const policies = repositoryName('authorization-policies');

@Injectable()
export class PolicyRuntimeService {
  private readonly repository: Repository<StoredPolicy>;
  readonly engine: PersistentPolicyEngine;

  constructor(@Inject(DatabaseService) database: DatabaseService) {
    this.repository = database.adapter.repository(policies);
    this.engine = new PersistentPolicyEngine((organizationId) => this.list(organizationId));
  }

  authorize(input: AuthorizationRequest) {
    return this.engine.authorize(input);
  }

  async list(organizationId: string): Promise<readonly StoredPolicy[]> {
    return listAllTenant(this.repository, organizationId);
  }

  create(organizationId: string, input: Omit<AuthorizationPolicy, 'id' | 'organizationId'>) {
    const now = new Date();
    const policy: StoredPolicy = {
      ...input,
      id: uuidV7(now.getTime()),
      tenantId: organizationId,
      organizationId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    return this.repository.insert(policy);
  }
}
