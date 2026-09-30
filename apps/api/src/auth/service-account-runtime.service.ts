import { repositoryName, type Repository, type TenantEntity } from '@handstack/domain';
import {
  ServiceAccountService,
  type ServiceAccount,
  type ServiceAccountStore,
} from '@handstack/service-accounts';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { listAllTenant } from '../database/pagination.js';

const accountsRepository = repositoryName('service-accounts');

interface StoredServiceAccount extends ServiceAccount, TenantEntity {}

class RepositoryServiceAccountStore implements ServiceAccountStore {
  private readonly repository: Repository<StoredServiceAccount>;
  constructor(database: DatabaseService) {
    this.repository = database.adapter.repository(accountsRepository);
  }
  async insert(account: ServiceAccount) {
    await this.repository.insert({
      ...account,
      tenantId: account.organizationId,
      version: 1,
      updatedAt: account.createdAt,
    });
  }
  async findByClientId(organizationId: string, clientId: string) {
    return (await this.list(organizationId)).find((account) => account.clientId === clientId);
  }
  async update(account: ServiceAccount) {
    const current = await this.repository.findById(account.organizationId, account.id);
    const version = current?.version ?? 1;
    await this.repository.update(
      { ...account, tenantId: account.organizationId, version: version + 1, updatedAt: new Date() },
      version,
    );
  }
  async list(organizationId: string) {
    return (await listAllTenant(this.repository, organizationId, 100)).map(
      (account) =>
        Object.fromEntries(
          Object.entries(account).filter(
            ([key]) => !['tenantId', 'version', 'updatedAt'].includes(key),
          ),
        ) as ServiceAccount,
    );
  }
}

@Injectable()
export class ServiceAccountRuntimeService {
  readonly service: ServiceAccountService;
  constructor(@Inject(DatabaseService) database: DatabaseService) {
    this.service = new ServiceAccountService(new RepositoryServiceAccountStore(database));
  }
}
