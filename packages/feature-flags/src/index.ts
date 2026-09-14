import { ValidationError } from '@handstack/shared';

export type FeatureFlagScope = 'global' | 'organization' | 'user';

export interface FeatureFlag {
  readonly key: string;
  readonly scope: FeatureFlagScope;
  readonly enabled: boolean;
  readonly organizationId?: string;
  readonly userId?: string;
  readonly updatedAt: Date;
}

export interface FeatureFlagContext {
  readonly organizationId?: string;
  readonly userId?: string;
}

export interface FeatureFlagService {
  set(input: {
    readonly key: string;
    readonly scope: FeatureFlagScope;
    readonly enabled: boolean;
    readonly organizationId?: string;
    readonly userId?: string;
  }): FeatureFlag;
  remove(input: {
    readonly key: string;
    readonly scope: FeatureFlagScope;
    readonly organizationId?: string;
    readonly userId?: string;
  }): boolean;
  isEnabled(key: string, context?: FeatureFlagContext): boolean;
  list(context?: FeatureFlagContext): readonly FeatureFlag[];
}

/** In-memory reference implementation; persistence adapters can implement the same contract. */
export class InMemoryFeatureFlagService implements FeatureFlagService {
  private readonly flags = new Map<string, FeatureFlag>();

  set(input: {
    key: string;
    scope: FeatureFlagScope;
    enabled: boolean;
    organizationId?: string;
    userId?: string;
  }): FeatureFlag {
    validateInput(input);
    const flag: FeatureFlag = { ...input, updatedAt: new Date() };
    this.flags.set(flagKey(flag), flag);
    return flag;
  }

  remove(input: {
    key: string;
    scope: FeatureFlagScope;
    organizationId?: string;
    userId?: string;
  }): boolean {
    validateInput(input);
    return this.flags.delete(flagKey(input));
  }

  isEnabled(key: string, context: FeatureFlagContext = {}): boolean {
    if (key.trim() === '') throw new ValidationError('Feature flag key is required');
    const user =
      context.userId === undefined || context.organizationId === undefined
        ? undefined
        : this.flags.get(`${key}:user:${context.organizationId}:${context.userId}`);
    if (user !== undefined) return user.enabled;
    const organization =
      context.organizationId === undefined
        ? undefined
        : this.flags.get(`${key}:organization:${context.organizationId}`);
    if (organization !== undefined) return organization.enabled;
    return this.flags.get(`${key}:global`)?.enabled ?? false;
  }

  list(context: FeatureFlagContext = {}): readonly FeatureFlag[] {
    return [...this.flags.values()].filter(
      (flag) =>
        flag.scope === 'global' ||
        (flag.scope === 'organization' && flag.organizationId === context.organizationId) ||
        (flag.scope === 'user' &&
          flag.organizationId === context.organizationId &&
          flag.userId === context.userId),
    );
  }
}

function validateInput(input: {
  key: string;
  scope: FeatureFlagScope;
  organizationId?: string;
  userId?: string;
}): void {
  if (input.key.trim() === '') throw new ValidationError('Feature flag key is required');
  if (input.scope === 'organization' && input.organizationId === undefined)
    throw new ValidationError('Organization feature flags require organizationId');
  if (input.scope === 'user' && (input.organizationId === undefined || input.userId === undefined))
    throw new ValidationError('User feature flags require organizationId and userId');
  if (
    input.scope === 'global' &&
    (input.organizationId !== undefined || input.userId !== undefined)
  )
    throw new ValidationError('Global feature flags cannot include tenant ids');
}

function flagKey(flag: {
  key: string;
  scope: FeatureFlagScope;
  organizationId?: string;
  userId?: string;
}): string {
  if (flag.scope === 'user')
    return `${flag.key}:user:${String(flag.organizationId)}:${String(flag.userId)}`;
  if (flag.scope === 'organization')
    return `${flag.key}:organization:${String(flag.organizationId)}`;
  return `${flag.key}:global`;
}
