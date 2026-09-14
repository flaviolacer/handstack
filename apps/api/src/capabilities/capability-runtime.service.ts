import { CapabilityExecutionEngine, PersistentCapabilityRegistry } from '@handstack/capabilities';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { ApiMetrics } from '../observability/api-metrics.js';
import { createCapabilityMetricsObserver } from '@handstack/telemetry';

@Injectable()
export class CapabilityRuntimeService {
  readonly registry: PersistentCapabilityRegistry;
  readonly engine: CapabilityExecutionEngine;

  constructor(
    @Inject(DatabaseService) database: DatabaseService,
    @Inject(ApiMetrics) metrics: ApiMetrics,
  ) {
    this.registry = new PersistentCapabilityRegistry(database.adapter);
    this.engine = new CapabilityExecutionEngine(this.registry, {
      authorize: ({ capability, context }) => {
        if (!capability.requiredPermissions.includes('capability.execute'))
          return Promise.resolve();
        if (context.principalId === '')
          return Promise.reject(new Error('Capability principal is required'));
        return Promise.resolve();
      },
      observe: createCapabilityMetricsObserver(metrics),
    });
  }
}
