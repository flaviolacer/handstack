import { describe, expect, it } from 'vitest';
import {
  assertOfficialBuiltInImplementations,
  assertOfficialPluginContractCoverage,
  PluginContractError,
  verifyOfficialBuiltInImplementations,
  verifyIdentityPluginContract,
} from '../src/index.js';

const manifest = {
  id: 'handstack.test-idp',
  apiVersion: '1.0',
  permissions: ['identity.login'],
  configurationSchema: { type: 'object' },
  capabilities: ['identity.saml'],
} as const;
const passingProbe = {
  validateTenantIsolation: () => Promise.resolve(true),
  validateTimeout: () => Promise.resolve(true),
  validateFailClosed: () => Promise.resolve(true),
  validateSecretLeakage: () => Promise.resolve(true),
  validateProtocol: () => Promise.resolve(true),
};

describe('identity plugin test kit', () => {
  it('reports manifest, security and protocol contract checks', async () => {
    const report = await verifyIdentityPluginContract(manifest, passingProbe);
    expect(report.pluginId).toBe(manifest.id);
    expect(report.checks).toContain('tenantIsolation');
    expect(report.checks).toContain('protocol');
  });
  it('fails closed when a required security probe fails', async () => {
    await expect(
      verifyIdentityPluginContract(manifest, {
        ...passingProbe,
        validateSecretLeakage: () => Promise.resolve(false),
      }),
    ).rejects.toBeInstanceOf(PluginContractError);
  });
  it('rejects incomplete manifests', async () => {
    await expect(
      verifyIdentityPluginContract({ ...manifest, apiVersion: 'v1' }, passingProbe),
    ).rejects.toMatchObject({ check: 'apiVersion' });
  });
  it('returns a typed failure for malformed manifests', async () => {
    await expect(verifyIdentityPluginContract({} as never, passingProbe)).rejects.toMatchObject({
      check: 'manifest',
    });
  });
  it('rejects non-string permission and capability entries', async () => {
    await expect(
      verifyIdentityPluginContract(
        { ...manifest, permissions: ['identity.login', ''] },
        passingProbe,
      ),
    ).rejects.toMatchObject({ check: 'permissions' });
    await expect(
      verifyIdentityPluginContract(
        { ...manifest, capabilities: ['identity.saml', null] } as never,
        passingProbe,
      ),
    ).rejects.toMatchObject({ check: 'capabilities' });
  });
  it('normalizes rejected probes to a typed failure', async () => {
    await expect(
      verifyIdentityPluginContract(manifest, {
        ...passingProbe,
        validateTimeout: () => Promise.reject(new Error('transport failure')),
      }),
    ).rejects.toMatchObject({ check: 'timeout' });
  });
  it('returns a typed failure for incomplete probes', async () => {
    await expect(verifyIdentityPluginContract(manifest, {} as never)).rejects.toMatchObject({
      check: 'validateTenantIsolation',
    });
  });
  it('requires the official cross-cutting plugin contract suites', () => {
    expect(
      assertOfficialPluginContractCoverage([
        'policy-provider',
        'guardrail-provider',
        'evaluation-provider',
        'privacy-data-lifecycle',
        'sandbox-provider',
        'audit-sink-siem-exporter',
        'knowledge-connector-rag-policy',
        'workflow-node-compensation',
        'webhook-transport',
        'incident-management-status-page',
      ]),
    ).toHaveLength(10);
    expect(() => assertOfficialPluginContractCoverage(['policy-provider'])).toThrow(
      /Missing plugin contract suites/,
    );
  });
  it('maps every official suite to a built-in implementation', () => {
    const implementations = assertOfficialBuiltInImplementations();
    expect(Object.keys(implementations)).toHaveLength(10);
    expect(implementations['policy-provider'].builtIn).toBe(true);
  });
  it('fails closed when a built-in package cannot be resolved', () => {
    expect(() => verifyOfficialBuiltInImplementations({ hasPackage: () => true })).not.toThrow();
    expect(() => verifyOfficialBuiltInImplementations({ hasPackage: () => false })).toThrow(
      /Built-in package is unavailable/,
    );
  });
});
