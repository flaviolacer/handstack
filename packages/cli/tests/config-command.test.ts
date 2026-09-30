import { defineConfig } from '@handstack/config';
import { describe, expect, it } from 'vitest';
import { executeConfigValidateCommand } from '../src/config-command.js';

describe('CLI configuration validation', () => {
  it('emits a non-sensitive summary of the resolved configuration', () => {
    const output: string[] = [];
    executeConfigValidateCommand(
      ['config', 'validate'],
      defineConfig({
        database: { adapter: 'sqlite', url: 'file:./private.db' },
        privacy: { storeToolPayloads: true },
      }),
      { output: (value) => output.push(value) },
    );
    expect(JSON.parse(output[0] ?? '{}')).toEqual({
      command: 'config validate',
      valid: true,
      deploymentProfile: 'compact',
      databaseAdapter: 'sqlite',
      queueTopology: 'standalone',
      redisNatMapConfigured: false,
      vectorStoreAdapter: 'repository',
      vectorStoreCredentialConfigured: false,
      telemetryEnabled: false,
      telemetryEndpointConfigured: false,
      logLevel: 'info',
      attachments: {
        storagePath: '.handstack-data/attachments',
        maxBytes: 25 * 1024 * 1024,
      },
      webhooks: { allowedHostCount: 0 },
      knowledge: { allowedHostCount: 0 },
      plugins: {
        isolationRequired: false,
        cacheConfigured: false,
        trustedPublisherCount: 0,
      },
      security: {
        masterKeyConfigured: false,
        internalServiceTokenConfigured: false,
        internalApiKeyConfigured: false,
        gatewayKeyPepperConfigured: false,
        scimTokenPepperConfigured: false,
        oidcStatePepperConfigured: false,
        accessTokenSecretConfigured: false,
        tokenPepperConfigured: false,
        attachmentSigningSecretConfigured: false,
        webhookLegacyMasterKeyConfigured: false,
      },
      cli: {
        apiUrlConfigured: false,
        organizationConfigured: false,
        accessTokenConfigured: false,
        portableSigningKeyConfigured: false,
      },
      privacy: {
        storePrompts: true,
        storeResponses: true,
        storeToolPayloads: true,
        redactPii: true,
        sendTelemetry: false,
      },
      retentionDays: { conversation: 90, audit: 365, usage: 365, trace: 30, attachments: 30 },
      privacyRetention: {
        enabled: false,
        intervalMs: 86_400_000,
        organizationCount: 0,
        instanceIdConfigured: false,
      },
      auditIntegrity: {
        enabled: false,
        intervalMs: 86_400_000,
        organizationCount: 0,
        instanceIdConfigured: false,
      },
      knowledgeSync: {
        enabled: false,
        intervalMs: 300_000,
        organizationCount: 0,
        instanceIdConfigured: false,
      },
      workflowScheduler: {
        enabled: false,
        intervalMs: 10_000,
        organizationCount: 0,
        instanceIdConfigured: false,
        principal: 'scheduler',
      },
      worker: {
        concurrency: 1,
        timeoutConfigured: false,
        heartbeatIntervalMs: 10_000,
        maxAttempts: 3,
        retryJitterMs: 250,
        metricsPort: 9091,
      },
    });
    expect(output[0]).not.toContain('private.db');
  });

  it('rejects unexpected arguments', () => {
    expect(() => {
      executeConfigValidateCommand(['config', 'validate', '--json'], defineConfig({}), {
        output: () => {
          // Intentionally discard output for the usage error assertion.
        },
      });
    }).toThrow('Usage: handstack config validate');
  });
});
