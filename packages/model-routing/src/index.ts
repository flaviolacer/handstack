import { ValidationError } from '@handstack/shared';

export type RoutingStrategy =
  | 'fallback'
  | 'round_robin'
  | 'least_cost'
  | 'least_latency'
  | 'weighted'
  | 'priority'
  | 'random'
  | 'custom'
  | 'semantic';

export interface RoutingCandidate {
  readonly modelDefinitionId: string;
  readonly providerId: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly weight?: number;
  readonly costUsdPerRequest?: number;
  readonly latencyMs?: number;
  readonly tags?: readonly string[];
}

export interface RoutingPolicy {
  readonly organizationId: string;
  readonly id: string;
  readonly name: string;
  readonly strategy: RoutingStrategy;
  readonly candidates: readonly RoutingCandidate[];
  readonly fallbackPolicyId?: string;
}

export interface RoutingRequest {
  readonly organizationId: string;
  readonly policy: RoutingPolicy;
  readonly requiredTags?: readonly string[];
  readonly random?: () => number;
  readonly score?: (candidate: RoutingCandidate) => number;
}

export interface RoutingDecision {
  readonly organizationId: string;
  readonly policyId: string;
  readonly strategy: RoutingStrategy;
  readonly candidate: RoutingCandidate;
  readonly candidateIndex: number;
}

export class RoutingError extends Error {
  constructor(readonly code: 'NO_ROUTE' | 'INVALID_POLICY' | 'CUSTOM_SCORER_REQUIRED') {
    super(`Model routing failed: ${code}`);
    this.name = 'RoutingError';
  }
}

export class ModelRouter {
  private readonly cursors = new Map<string, number>();

  route(input: RoutingRequest): RoutingDecision {
    if (input.organizationId === '' || input.policy.organizationId !== input.organizationId)
      throw new ValidationError('Routing policy organization scope is invalid');
    const candidates = input.policy.candidates.filter((candidate) => {
      if (candidate.enabled === false) return false;
      return (input.requiredTags ?? []).every((tag) => candidate.tags?.includes(tag) === true);
    });
    if (candidates.length === 0) throw new RoutingError('NO_ROUTE');
    const index = this.select(input, candidates);
    return {
      organizationId: input.organizationId,
      policyId: input.policy.id,
      strategy: input.policy.strategy,
      candidate: this.candidateAt(candidates, index),
      candidateIndex: index,
    };
  }

  reset(policyId?: string): void {
    if (policyId === undefined) this.cursors.clear();
    else this.cursors.delete(policyId);
  }

  private select(input: RoutingRequest, candidates: readonly RoutingCandidate[]): number {
    const strategy = input.policy.strategy;
    if (strategy === 'fallback' || strategy === 'priority')
      return this.best(candidates, (c) => c.priority ?? 0, true);
    if (strategy === 'least_cost')
      return this.best(candidates, (c) => c.costUsdPerRequest ?? Number.POSITIVE_INFINITY, false);
    if (strategy === 'least_latency')
      return this.best(candidates, (c) => c.latencyMs ?? Number.POSITIVE_INFINITY, false);
    if (strategy === 'round_robin') {
      const cursor = this.cursors.get(input.policy.id) ?? 0;
      this.cursors.set(input.policy.id, cursor + 1);
      return cursor % candidates.length;
    }
    if (strategy === 'weighted') {
      const total = candidates.reduce(
        (sum, candidate) => sum + Math.max(0, candidate.weight ?? 0),
        0,
      );
      if (total === 0) return 0;
      let threshold = (input.random ?? Math.random)() * total;
      const selected = candidates.findIndex(
        (candidate) => (threshold -= Math.max(0, candidate.weight ?? 0)) < 0,
      );
      return selected < 0 ? candidates.length - 1 : selected;
    }
    if (strategy === 'random')
      return Math.floor((input.random ?? Math.random)() * candidates.length);
    switch (strategy) {
      case 'custom':
      case 'semantic':
        if (input.score === undefined) throw new RoutingError('CUSTOM_SCORER_REQUIRED');
        return this.best(candidates, input.score, false);
      default:
        return 0;
    }
  }

  private best(
    candidates: readonly RoutingCandidate[],
    score: (candidate: RoutingCandidate) => number,
    descending: boolean,
  ): number {
    return candidates.reduce((bestIndex, candidate, index) => {
      const current = score(candidate);
      const best = score(this.candidateAt(candidates, bestIndex));
      return (descending ? current > best : current < best) ? index : bestIndex;
    }, 0);
  }

  private candidateAt(candidates: readonly RoutingCandidate[], index: number): RoutingCandidate {
    const candidate = candidates[index];
    if (candidate === undefined) throw new RoutingError('NO_ROUTE');
    return candidate;
  }
}

export function validateRoutingPolicy(policy: RoutingPolicy): void {
  if (policy.organizationId === '' || policy.id === '' || policy.name === '')
    throw new ValidationError('Routing policy identity is required');
  if (policy.candidates.length === 0) throw new ValidationError('Routing policy needs a candidate');
  if (
    new Set(policy.candidates.map((candidate) => candidate.modelDefinitionId)).size !==
    policy.candidates.length
  )
    throw new ValidationError('Routing policy candidates must be unique');
  for (const candidate of policy.candidates) {
    if (candidate.modelDefinitionId === '' || candidate.providerId === '')
      throw new ValidationError('Routing candidate identity is required');
    if (
      candidate.weight !== undefined &&
      (!Number.isFinite(candidate.weight) || candidate.weight < 0)
    )
      throw new ValidationError('Routing candidate weight must be non-negative');
  }
}
