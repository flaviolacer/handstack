import { IdentityAdministrationService } from '@handstack/identity-service';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '../src/main.js';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { PluginRegistryRuntimeService } from '../src/plugins/plugin-registry.runtime.js';
import { DatabaseService } from '../src/database/database.service.js';
import { repositoryName, type TenantEntity } from '@handstack/domain';

const organizationId = 'registry-organization';
const otherOrganizationId = 'registry-other';

describe('plugin registry HTTP contract', () => {
  let app: NestFastifyApplication;
  let token: string;

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET = 'registry-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'registry-token-pepper-at-least-32-characters';
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const auth = app.get(AuthRuntimeService);
    const administration = new IdentityAdministrationService(auth.storage);
    await administration.createUser(organizationId, {
      id: 'registry-admin',
      username: 'registry.admin',
      displayName: 'Registry Admin',
    });
    const role = await administration.createRole(organizationId, { name: 'Plugin administrator' });
    const permission = await administration.createPermission(organizationId, 'plugins.manage');
    await administration.grantPermission(organizationId, role.id, permission.id);
    await administration.assignRole(organizationId, 'registry-admin', role.id);
    await auth.authentication.setPassword(
      organizationId,
      'registry-admin',
      'registry admin password long enough',
    );
    token = (
      await auth.authentication.login(
        organizationId,
        'registry.admin',
        'registry admin password long enough',
      )
    ).accessToken;

    const runtime = app.get(PluginRegistryRuntimeService);
    runtime.registry.publish({
      manifest: {
        name: '@handstack/registry-demo',
        version: '1.0.0',
        handstack: { apiVersion: '1', capabilities: ['tool'] },
      },
      source: { kind: 'NPM', locator: '@handstack/registry-demo', checksum: 'a'.repeat(64) },
      supplyChain: {
        publisher: 'handstack',
        signature: 'sig',
        sbomDigest: 'b'.repeat(64),
        provenanceDigest: 'c'.repeat(64),
      },
      catalog: 'OFFICIAL',
      publishedAt: new Date(),
    });
    runtime.registry.publish({
      manifest: {
        name: '@handstack/registry-demo',
        version: '2.0.0',
        handstack: { apiVersion: '1', capabilities: ['tool'] },
      },
      source: { kind: 'NPM', locator: '@handstack/registry-demo', checksum: 'a'.repeat(64) },
      supplyChain: {
        publisher: 'handstack',
        signature: 'sig',
        sbomDigest: 'b'.repeat(64),
        provenanceDigest: 'c'.repeat(64),
      },
      catalog: 'OFFICIAL',
      publishedAt: new Date(),
    });
    await app
      .get(DatabaseService)
      .adapter.repository<
        TenantEntity & { readonly organizationId: string; readonly installation: unknown }
      >(repositoryName('plugin-installations'))
      .insert({
        id: 'registry-installation',
        tenantId: organizationId,
        organizationId,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        installation: {
          record: {
            manifest: {
              name: '@handstack/registry-demo',
              version: '1.0.0',
              handstack: { apiVersion: '1', capabilities: ['tool'] },
            },
            checksum: 'a'.repeat(64),
            mode: 'isolated',
            status: 'ENABLED',
            approvedPermissions: [],
          },
          source: {
            kind: 'NPM',
            locator: '@handstack/registry-demo',
            checksum: 'a'.repeat(64),
            supplyChain: {
              publisher: 'handstack',
              signature: 'sig',
              sbomDigest: 'b'.repeat(64),
              provenanceDigest: 'c'.repeat(64),
            },
          },
          installedAt: new Date(),
        },
      });
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
  });

  it('lists public catalogs and tenant-scoped installed/update catalogs', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const direct = await app
      .get(PluginRegistryRuntimeService)
      .search('', 'INSTALLED', organizationId);
    expect(direct).toHaveLength(1);
    await expect(
      app.inject({ method: 'GET', url: '/registry/plugins?catalog=OFFICIAL', headers }),
    ).resolves.toMatchObject({ statusCode: 200 });
    const installed = await app.inject({
      method: 'GET',
      url: `/registry/plugins?catalog=INSTALLED&organizationId=${organizationId}`,
      headers,
    });
    expect(installed.statusCode, installed.body).toBe(200);
    expect(jsonRecord(installed).items).toHaveLength(1);
    const updates = await app.inject({
      method: 'GET',
      url: `/registry/plugins?catalog=UPDATES&organizationId=${organizationId}`,
      headers,
    });
    expect(updates.statusCode).toBe(200);
    expect(jsonRecord(updates).items).toMatchObject([{ manifest: { version: '2.0.0' } }]);
    const crossTenant = await app.inject({
      method: 'GET',
      url: `/registry/plugins?catalog=INSTALLED&organizationId=${otherOrganizationId}`,
      headers,
    });
    expect(crossTenant.statusCode).toBe(403);
  });

  it('resolves a registry entry without executing its artifact', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/registry/plugins/%40handstack%2Fregistry-demo?version=2.0.0',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      manifest: { name: '@handstack/registry-demo', version: '2.0.0' },
    });
  });

  it('validates bounded external SBOM/provenance request fields before resolving an artifact', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/plugins`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        manifest: {
          name: '@handstack/document-limit',
          version: '1.0.0',
          handstack: { apiVersion: '1', capabilities: ['tool'], mode: 'isolated' },
        },
        checksum: 'a'.repeat(64),
        approvedPermissions: [],
        source: {
          kind: 'LOCAL',
          locator: 'not-resolved-because-the-document-is-invalid',
          checksum: 'a'.repeat(64),
          supplyChain: {
            publisher: 'handstack',
            signature: 'test-signature',
            sbomDigest: 'b'.repeat(64),
            provenanceDigest: 'c'.repeat(64),
          },
          supplyChainDocuments: { sbom: {}, provenance: '{}' },
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('SBOM and provenance documents are required and size-limited');
  });

  it('persists tenant-scoped quarantine and publisher revocation controls', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const quarantine = await app.inject({
      method: 'PATCH',
      url: `/registry/plugins/%40handstack%2Fregistry-demo/quarantine?organizationId=${organizationId}`,
      headers,
      payload: { version: '1.0.0', reason: 'Compromised release under investigation' },
    });
    expect(quarantine.statusCode, quarantine.body).toBe(200);
    const afterQuarantine = await app.inject({
      method: 'GET',
      url: `/registry/plugins?catalog=OFFICIAL&organizationId=${organizationId}`,
      headers,
    });
    expect(afterQuarantine.statusCode).toBe(200);
    expect(jsonRecord(afterQuarantine).items).toHaveLength(1);
    const installedAfterQuarantine = await app
      .get(PluginRegistryRuntimeService)
      .search('', 'INSTALLED', organizationId);
    expect(installedAfterQuarantine).toMatchObject([
      { record: { manifest: { version: '1.0.0' }, status: 'DISABLED' } },
    ]);
    const revoke = await app.inject({
      method: 'PATCH',
      url: '/registry/plugins/handstack/revoke-publisher?organizationId=' + organizationId,
      headers,
      payload: { reason: 'Publisher credentials revoked' },
    });
    expect(revoke.statusCode, revoke.body).toBe(200);
    const afterRevoke = await app.inject({
      method: 'GET',
      url: `/registry/plugins?catalog=OFFICIAL&organizationId=${organizationId}`,
      headers,
    });
    expect(jsonRecord(afterRevoke).items).toHaveLength(0);
  });
});

function jsonRecord(response: { json(): unknown }): { readonly items: readonly unknown[] } {
  const value = response.json();
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('items' in value) ||
    !Array.isArray(value.items)
  )
    throw new Error('Expected registry items');
  return value as { readonly items: readonly unknown[] };
}
