import type { Repository, TenantEntity } from '@handstack/domain';

/** Reads a tenant repository completely while preserving cursor safety. */
export async function listAllTenant<T extends TenantEntity>(
  repository: Repository<T>,
  tenantId: string,
  limit = 200,
): Promise<readonly T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await repository.list(tenantId, {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    if (page.nextCursor !== undefined && page.nextCursor === cursor)
      throw new Error('Repository cursor repeated');
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}
