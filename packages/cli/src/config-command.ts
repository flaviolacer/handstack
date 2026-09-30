import type { HandStackConfig } from '@handstack/config';

export interface ConfigValidateRuntime {
  readonly output: (value: string) => void;
}

/** Validates the resolved configuration and emits only a non-sensitive summary. */
export function executeConfigValidateCommand(
  args: readonly string[],
  config: HandStackConfig,
  runtime: ConfigValidateRuntime,
): void {
  if (args[0] !== 'config' || args[1] !== 'validate' || args.length > 2)
    throw new Error('Usage: handstack config validate');
  runtime.output(
    JSON.stringify({
      command: 'config validate',
      valid: true,
      deploymentProfile: config.deployment.profile,
      databaseAdapter: config.database.adapter,
      queueTopology: config.queue.topology,
      redisNatMapConfigured: Object.keys(config.queue.natMap).length > 0,
      vectorStoreAdapter: config.vectorStore.adapter,
      vectorStoreCredentialConfigured: config.vectorStore.credentialReference !== undefined,
      telemetryEnabled: config.telemetry.enabled,
      telemetryEndpointConfigured: config.telemetry.otlpEndpoint !== undefined,
      logLevel: config.logging.level,
      attachments: {
        storagePath: config.attachments.storagePath,
        maxBytes: config.attachments.maxBytes,
      },
      webhooks: { allowedHostCount: config.webhooks.allowedHosts.length },
      knowledge: { allowedHostCount: config.knowledge.allowedHosts.length },
      plugins: {
        isolationRequired: config.plugins.isolationRequired,
        cacheConfigured: config.plugins.cacheDir !== undefined,
        trustedPublisherCount: Object.keys(config.plugins.trustedPublishers).length,
      },
      security: {
        masterKeyConfigured: config.security.masterKey !== undefined,
        internalServiceTokenConfigured: config.security.internalServiceToken !== undefined,
        internalApiKeyConfigured: config.security.internalApiKey !== undefined,
        gatewayKeyPepperConfigured: config.security.gatewayKeyPepper !== undefined,
        scimTokenPepperConfigured: config.security.scimTokenPepper !== undefined,
        oidcStatePepperConfigured: config.security.oidcStatePepper !== undefined,
        accessTokenSecretConfigured: config.security.accessTokenSecret !== undefined,
        tokenPepperConfigured: config.security.tokenPepper !== undefined,
        attachmentSigningSecretConfigured: config.security.attachmentSigningSecret !== undefined,
        webhookLegacyMasterKeyConfigured: config.security.webhookLegacyMasterKey !== undefined,
      },
      cli: {
        apiUrlConfigured: config.cli.apiUrl !== undefined,
        organizationConfigured: config.cli.organizationId !== undefined,
        accessTokenConfigured: config.cli.accessToken !== undefined,
        portableSigningKeyConfigured: config.cli.portableSigningKey !== undefined,
      },
      privacy: config.privacy,
      retentionDays: config.retention,
      privacyRetention: {
        enabled: config.privacyRetention.enabled,
        intervalMs: config.privacyRetention.intervalMs,
        organizationCount: config.privacyRetention.organizations.length,
        instanceIdConfigured: config.privacyRetention.instanceId !== undefined,
      },
      auditIntegrity: {
        enabled: config.auditIntegrity.enabled,
        intervalMs: config.auditIntegrity.intervalMs,
        organizationCount: config.auditIntegrity.organizations.length,
        instanceIdConfigured: config.auditIntegrity.instanceId !== undefined,
      },
      knowledgeSync: {
        enabled: config.knowledgeSync.enabled,
        intervalMs: config.knowledgeSync.intervalMs,
        organizationCount: config.knowledgeSync.organizations.length,
        instanceIdConfigured: config.knowledgeSync.instanceId !== undefined,
      },
      workflowScheduler: {
        enabled: config.workflowScheduler.enabled,
        intervalMs: config.workflowScheduler.intervalMs,
        organizationCount: config.workflowScheduler.organizations.length,
        instanceIdConfigured: config.workflowScheduler.instanceId !== undefined,
        principal: config.workflowScheduler.principal,
      },
      worker: {
        concurrency: config.worker.concurrency,
        timeoutConfigured: config.worker.timeoutMs !== undefined,
        heartbeatIntervalMs: config.worker.heartbeatIntervalMs,
        maxAttempts: config.worker.maxAttempts,
        retryJitterMs: config.worker.retryJitterMs,
        metricsPort: config.worker.metricsPort,
      },
    }),
  );
}
