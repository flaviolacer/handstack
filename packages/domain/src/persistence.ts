export interface TenantEntity {
  readonly id: string;
  readonly tenantId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PageRequest {
  readonly limit: number;
  readonly cursor?: string;
  readonly direction?: 'forward' | 'backward';
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly previousCursor?: string;
}

export interface Repository<T extends TenantEntity> {
  findById(tenantId: string, id: string): Promise<T | undefined>;
  list(tenantId: string, page: PageRequest): Promise<Page<T>>;
  insert(entity: T): Promise<T>;
  update(entity: T, expectedVersion: number): Promise<T>;
  delete(tenantId: string, id: string, expectedVersion: number): Promise<boolean>;
}

export type RepositoryName = string & { readonly __repositoryName: unique symbol };

export interface TransactionContext {
  repository<T extends TenantEntity>(name: RepositoryName): Repository<T>;
}

export interface TransactionOptions {
  readonly isolation?: 'read-committed' | 'repeatable-read' | 'serializable';
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
}

export interface TransactionManager {
  run<T>(
    operation: (context: TransactionContext) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}

export function repositoryName(value: string): RepositoryName {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new TypeError(`Invalid repository name: ${value}`);
  }
  return value as RepositoryName;
}
