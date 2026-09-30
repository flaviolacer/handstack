import { CapabilityExecutionEngine, PersistentCapabilityRegistry } from '@handstack/capabilities';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { ApiMetrics } from '../observability/api-metrics.js';
import { createCapabilityMetricsObserver } from '@handstack/telemetry';
import { PolicyRuntimeService } from '../policy/policy-runtime.service.js';
import { AuthorizationError } from '@handstack/shared';
import { PrivacyRuntimeService } from '../privacy/privacy-runtime.service.js';

@Injectable()
export class CapabilityRuntimeService {
  readonly registry: PersistentCapabilityRegistry;
  readonly engine: CapabilityExecutionEngine;

  constructor(
    @Inject(DatabaseService) database: DatabaseService,
    @Inject(ApiMetrics) metrics: ApiMetrics,
    @Inject(PolicyRuntimeService) policy: PolicyRuntimeService,
    @Inject(PrivacyRuntimeService) privacy: PrivacyRuntimeService,
  ) {
    this.registry = new PersistentCapabilityRegistry(database.adapter);
    this.engine = new CapabilityExecutionEngine(this.registry, {
      authorize: async ({ capability, context }) => {
        const externalProvider =
          context.externalProvider === true || capability.metadata.externalProvider === 'true';
        const dataClassification =
          context.dataClassification ?? parseClassification(capability.metadata.dataClassification);
        const providerId = context.providerId ?? capability.metadata.providerId;
        const destinationRegion =
          context.destinationRegion ?? capability.metadata.destinationRegion;
        const consentPurposeId = capability.metadata.consentPurposeId;
        if (consentPurposeId !== undefined) {
          if (context.principalId.trim() === '')
            throw new AuthorizationError('Consent-bound capability requires a principal');
          const consent = await privacy.authorizeConsent(
            context.organizationId,
            context.principalId,
            consentPurposeId,
          );
          if (!consent.allowed)
            throw new AuthorizationError(consent.reason ?? 'Consent is not granted');
        }
        if (externalProvider) {
          if (
            dataClassification === undefined ||
            providerId === undefined ||
            destinationRegion === undefined
          )
            throw new AuthorizationError(
              'External capability execution requires privacy destination metadata',
            );
          const placement = await privacy.authorizePlacement(
            context.organizationId,
            dataClassification,
            destinationRegion,
          );
          if (!placement.allowed)
            throw new AuthorizationError(placement.reason ?? 'Privacy placement denied');
        }
        if (!capability.requiredPermissions.includes('capability.execute')) return;
        if (context.principalId === '') throw new Error('Capability principal is required');
        const decision = await policy.authorize({
          organizationId: context.organizationId,
          principalId: context.principalId,
          resource: 'capability',
          action: 'execute',
          groupIds: [],
          evaluatedAt: new Date(),
        });
        if (!decision.allowed && decision.reason === 'explicit deny')
          throw new AuthorizationError('Capability execution denied by policy');
      },
      observe: createCapabilityMetricsObserver(metrics),
      executionTimeoutMs: () => database.config.timeouts.tool,
    });
  }
}

type DataClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
function parseClassification(value: string | undefined): DataClassification | undefined {
  return value === 'PUBLIC' ||
    value === 'INTERNAL' ||
    value === 'CONFIDENTIAL' ||
    value === 'RESTRICTED'
    ? value
    : undefined;
}
