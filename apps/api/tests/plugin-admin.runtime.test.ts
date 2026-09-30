import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import type { DatabaseService } from '../src/database/database.service.js';
import type { SecretRuntimeService } from '../src/secrets/secret-runtime.service.js';
import { PluginAdminRuntimeService } from '../src/plugins/plugin-admin.runtime.js';
import { PluginRegistryRuntimeService } from '../src/plugins/plugin-registry.runtime.js';

const temporaryDirectories: string[] = [];
const testSupplyChain = {
  publisher: 'handstack-test',
  signature: 'test-signature',
  sbomDigest: 'b'.repeat(64),
  provenanceDigest: 'c'.repeat(64),
} as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('plugin administration runtime', () => {
  it('loads, verifies and runs a trusted local plugin lifecycle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'handstack-plugin-'));
    temporaryDirectories.push(directory);
    const source = `export default { manifest: { name: '@handstack/local-test', version: '1.0.0', handstack: { apiVersion: '1', capabilities: ['tool'], mode: 'trusted' } }, setup(context) { if (context.mode !== 'trusted') throw new Error('wrong mode'); } };`;
    const entry = join(directory, 'index.mjs');
    await writeFile(entry, source, 'utf8');
    const checksum = createHash('sha256').update(source, 'utf8').digest('hex');
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const runtime = new PluginAdminRuntimeService({ adapter } as DatabaseService);
      await runtime.install(
        'org-a',
        {
          manifest: {
            name: '@handstack/local-test',
            version: '1.0.0',
            handstack: { apiVersion: '1', capabilities: ['tool'], mode: 'trusted' },
          },
          checksum,
          mode: 'trusted',
          status: 'INSTALLED',
          approvedPermissions: [],
        },
        { kind: 'LOCAL', locator: entry, checksum, supplyChain: testSupplyChain },
      );
      const enabled = await runtime.enable('org-a', '@handstack/local-test');
      expect(enabled.record.status).toBe('ENABLED');
      await expect(runtime.list('org-b')).resolves.toEqual([]);
      await expect(runtime.list('org-a')).resolves.toMatchObject([
        { record: { manifest: { name: '@handstack/local-test' } } },
      ]);
    } finally {
      await adapter.close();
    }
  });

  it('upgrades a trusted local plugin only with a higher verified version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'handstack-plugin-upgrade-'));
    temporaryDirectories.push(directory);
    const sourceV1 = `export default { manifest: { name: '@handstack/upgrade-test', version: '1.0.0', handstack: { apiVersion: '1', capabilities: ['tool'], mode: 'trusted' } }, setup() {} };`;
    const sourceV2 = `export default { manifest: { name: '@handstack/upgrade-test', version: '2.0.0', handstack: { apiVersion: '1', capabilities: ['tool'], mode: 'trusted' } }, setup() {} };`;
    const entryV1 = join(directory, 'v1.mjs');
    const entryV2 = join(directory, 'v2.mjs');
    await writeFile(entryV1, sourceV1, 'utf8');
    await writeFile(entryV2, sourceV2, 'utf8');
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const runtime = new PluginAdminRuntimeService({ adapter } as DatabaseService);
      const record = (version: string, checksum: string) => ({
        manifest: {
          name: '@handstack/upgrade-test',
          version,
          handstack: { apiVersion: '1', capabilities: ['tool'], mode: 'trusted' as const },
        },
        checksum,
        mode: 'trusted' as const,
        status: 'INSTALLED' as const,
        approvedPermissions: [],
      });
      const checksumV1 = createHash('sha256').update(sourceV1, 'utf8').digest('hex');
      const checksumV2 = createHash('sha256').update(sourceV2, 'utf8').digest('hex');
      await runtime.install('org-a', record('1.0.0', checksumV1), {
        kind: 'LOCAL',
        locator: entryV1,
        checksum: checksumV1,
        supplyChain: testSupplyChain,
      });
      await expect(
        runtime.upgrade('org-a', '@handstack/upgrade-test', record('2.0.0', checksumV2), {
          kind: 'LOCAL',
          locator: entryV2,
          checksum: checksumV2,
          supplyChain: testSupplyChain,
        }),
      ).resolves.toMatchObject({ record: { manifest: { version: '2.0.0' } } });
      await expect(
        runtime.upgrade('org-a', '@handstack/upgrade-test', record('1.0.0', checksumV1), {
          kind: 'LOCAL',
          locator: entryV1,
          checksum: checksumV1,
          supplyChain: testSupplyChain,
        }),
      ).rejects.toThrow(/increase/);
    } finally {
      await adapter.close();
    }
  });

  it('loads an external plugin only from a checksum-pinned provisioned cache', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'handstack-plugin-cache-'));
    temporaryDirectories.push(cache);
    const packageDirectory = join(cache, 'npm', '@handstack', 'cached-test');
    await mkdir(packageDirectory, { recursive: true });
    const source = `export default { manifest: { name: '@handstack/cached-test', version: '1.0.0', handstack: { apiVersion: '1', capabilities: ['tool'], mode: 'isolated' } }, setup() {} };`;
    const entry = join(packageDirectory, 'index.js');
    await writeFile(entry, source, 'utf8');
    const checksum = createHash('sha256').update(source, 'utf8').digest('hex');
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    const previousCache = process.env.HANDSTACK_PLUGIN_CACHE_DIR;
    const previousTrustedPublishers = process.env.HANDSTACK_PLUGIN_TRUSTED_PUBLISHERS_JSON;
    process.env.HANDSTACK_PLUGIN_CACHE_DIR = cache;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.HANDSTACK_PLUGIN_TRUSTED_PUBLISHERS_JSON = JSON.stringify({
      'handstack-test': publicKey.export({ type: 'spki', format: 'pem' }),
    });
    const sbomDocument = JSON.stringify({
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      metadata: { component: { name: '@handstack/cached-test', version: '1.0.0' } },
      components: [],
    });
    const provenanceDocument = JSON.stringify({
      _type: 'https://in-toto.io/Statement/v1',
      subject: [{ name: '@handstack/cached-test', digest: { sha256: checksum } }],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: { buildDefinition: {}, runDetails: {} },
    });
    const sbomDigest = createHash('sha256').update(sbomDocument).digest('hex');
    const provenanceDigest = createHash('sha256').update(provenanceDocument).digest('hex');
    const signedSupplyChain = (signature: string) => ({
      ...testSupplyChain,
      signature,
      sbomDigest,
      provenanceDigest,
    });
    const signatureFor = (supplyChain: ReturnType<typeof signedSupplyChain>) =>
      signBytes(
        null,
        Buffer.from(
          JSON.stringify({
            publisher: supplyChain.publisher,
            pluginName: '@handstack/cached-test',
            pluginVersion: '1.0.0',
            checksum,
            sbomDigest: supplyChain.sbomDigest,
            provenanceDigest: supplyChain.provenanceDigest,
          }),
        ),
        privateKey,
      ).toString('base64url');
    const signature = signatureFor(signedSupplyChain(''));
    try {
      const runtime = new PluginAdminRuntimeService({ adapter } as DatabaseService);
      const pluginRecord = {
        manifest: {
          name: '@handstack/cached-test',
          version: '1.0.0',
          handstack: { apiVersion: '1', capabilities: ['tool'], mode: 'isolated' as const },
        },
        checksum,
        mode: 'isolated' as const,
        status: 'INSTALLED' as const,
        approvedPermissions: [],
      };
      const externalSource = {
        kind: 'NPM' as const,
        locator: '@handstack/cached-test',
        checksum,
        supplyChainDocuments: { sbom: sbomDocument, provenance: provenanceDocument },
      };
      await expect(
        runtime.install(
          'org-a',
          {
            ...pluginRecord,
            mode: 'trusted',
            manifest: {
              ...pluginRecord.manifest,
              handstack: { ...pluginRecord.manifest.handstack, mode: 'trusted' },
            },
          },
          { ...externalSource, supplyChain: signedSupplyChain(signature) },
        ),
      ).rejects.toThrow(/must run in the isolated sandbox/u);
      await expect(
        runtime.install('org-a', pluginRecord, {
          ...externalSource,
          supplyChain: { ...signedSupplyChain(signature), publisher: 'untrusted-publisher' },
        }),
      ).rejects.toThrow(/publisher is not trusted/u);
      await expect(
        runtime.install('org-a', pluginRecord, {
          ...externalSource,
          supplyChain: signedSupplyChain(Buffer.alloc(64).toString('base64url')),
        }),
      ).rejects.toThrow(/signature verification failed/u);
      await expect(
        runtime.install('org-a', pluginRecord, {
          ...externalSource,
          supplyChain: signedSupplyChain(signature),
          supplyChainDocuments: { sbom: `${sbomDocument} `, provenance: provenanceDocument },
        }),
      ).rejects.toThrow(/digest does not match/u);
      const wrongSbom = JSON.stringify({
        bomFormat: 'CycloneDX',
        specVersion: '1.6',
        metadata: { component: { name: '@vendor/wrong-package', version: '9.9.9' } },
      });
      const wrongSbomChain = {
        ...signedSupplyChain(''),
        sbomDigest: createHash('sha256').update(wrongSbom).digest('hex'),
      };
      await expect(
        runtime.install('org-a', pluginRecord, {
          ...externalSource,
          supplyChain: { ...wrongSbomChain, signature: signatureFor(wrongSbomChain) },
          supplyChainDocuments: { sbom: wrongSbom, provenance: provenanceDocument },
        }),
      ).rejects.toThrow(/must identify the installed package and version/u);
      const installed = await runtime.install('org-a', pluginRecord, {
        ...externalSource,
        supplyChain: signedSupplyChain(signature),
      });
      expect('supplyChainDocuments' in installed.source).toBe(false);
      await expect(runtime.enable('org-a', '@handstack/cached-test')).resolves.toMatchObject({
        record: { status: 'ENABLED' },
      });
    } finally {
      if (previousCache === undefined) delete process.env.HANDSTACK_PLUGIN_CACHE_DIR;
      else process.env.HANDSTACK_PLUGIN_CACHE_DIR = previousCache;
      if (previousTrustedPublishers === undefined)
        delete process.env.HANDSTACK_PLUGIN_TRUSTED_PUBLISHERS_JSON;
      else process.env.HANDSTACK_PLUGIN_TRUSTED_PUBLISHERS_JSON = previousTrustedPublishers;
      await adapter.close();
    }
  });

  it('runs an isolated plugin through the process sandbox and imports registrations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'handstack-plugin-isolated-'));
    temporaryDirectories.push(directory);
    const source = `globalThis.__handstack_isolated_loaded = true; export default { manifest: { name: '@handstack/isolated-test', version: '1.0.0', handstack: { apiVersion: '1', capabilities: ['provider'], permissions: ['secrets'], mode: 'isolated' } }, async setup(context) { const secret = await context.secrets.get('secret://plugin-test'); if (secret !== 'isolated-secret-value') throw new Error('host secret broker returned an unexpected value'); context.providers.register({ providerId: 'isolated-provider', displayName: 'Isolated provider', kind: 'other', capabilities: ['test'], configurationSchema: { type: 'object' } }); } };`;
    const entry = join(directory, 'index.mjs');
    await writeFile(entry, source, 'utf8');
    const checksum = createHash('sha256').update(source, 'utf8').digest('hex');
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const resolveSecret = vi.fn(() => Promise.resolve('isolated-secret-value'));
      const secretRuntime = { resolve: resolveSecret } as unknown as SecretRuntimeService;
      const runtime = new PluginAdminRuntimeService({ adapter } as DatabaseService, secretRuntime);
      delete (globalThis as { __handstack_isolated_loaded?: boolean }).__handstack_isolated_loaded;
      await runtime.install(
        'org-a',
        {
          manifest: {
            name: '@handstack/isolated-test',
            version: '1.0.0',
            handstack: {
              apiVersion: '1',
              capabilities: ['provider'],
              permissions: ['secrets'],
              mode: 'isolated',
            },
          },
          checksum,
          mode: 'isolated',
          status: 'INSTALLED',
          approvedPermissions: ['secrets'],
        },
        { kind: 'LOCAL', locator: entry, checksum, supplyChain: testSupplyChain },
      );
      await expect(runtime.enable('org-a', '@handstack/isolated-test')).resolves.toMatchObject({
        record: { status: 'ENABLED' },
      });
      expect(resolveSecret).toHaveBeenCalledWith(
        'secret://plugin-test',
        'org-a',
        '@handstack/isolated-test',
      );
      expect(JSON.stringify(await runtime.list('org-a'))).not.toContain('isolated-secret-value');
      expect(
        (globalThis as { __handstack_isolated_loaded?: boolean }).__handstack_isolated_loaded,
      ).toBeUndefined();

      const deniedSource = `export default { manifest: { name: '@handstack/isolated-denied', version: '1.0.0', handstack: { apiVersion: '1', capabilities: ['provider'], permissions: ['secrets'], mode: 'isolated' } }, async setup(context) { await context.secrets.get('secret://plugin-test'); } };`;
      const deniedEntry = join(directory, 'denied.mjs');
      await writeFile(deniedEntry, deniedSource, 'utf8');
      const deniedChecksum = createHash('sha256').update(deniedSource, 'utf8').digest('hex');
      await runtime.install(
        'org-a',
        {
          manifest: {
            name: '@handstack/isolated-denied',
            version: '1.0.0',
            handstack: {
              apiVersion: '1',
              capabilities: ['provider'],
              permissions: ['secrets'],
              mode: 'isolated',
            },
          },
          checksum: deniedChecksum,
          mode: 'isolated',
          status: 'INSTALLED',
          approvedPermissions: [],
        },
        {
          kind: 'LOCAL',
          locator: deniedEntry,
          checksum: deniedChecksum,
          supplyChain: testSupplyChain,
        },
      );
      await expect(runtime.enable('org-a', '@handstack/isolated-denied')).rejects.toThrow(
        /runner failed/,
      );
      expect(resolveSecret).toHaveBeenCalledTimes(1);

      const leakingSource = `export default { manifest: { name: '@handstack/isolated-redaction', version: '1.0.0', handstack: { apiVersion: '1', capabilities: ['provider'], permissions: ['secrets'], mode: 'isolated' } }, async setup(context) { const secret = await context.secrets.get('secret://plugin-test'); throw new Error(secret); } };`;
      const leakingEntry = join(directory, 'leaking.mjs');
      await writeFile(leakingEntry, leakingSource, 'utf8');
      const leakingChecksum = createHash('sha256').update(leakingSource, 'utf8').digest('hex');
      await runtime.install(
        'org-a',
        {
          manifest: {
            name: '@handstack/isolated-redaction',
            version: '1.0.0',
            handstack: {
              apiVersion: '1',
              capabilities: ['provider'],
              permissions: ['secrets'],
              mode: 'isolated',
            },
          },
          checksum: leakingChecksum,
          mode: 'isolated',
          status: 'INSTALLED',
          approvedPermissions: ['secrets'],
        },
        {
          kind: 'LOCAL',
          locator: leakingEntry,
          checksum: leakingChecksum,
          supplyChain: testSupplyChain,
        },
      );
      const failure = await runtime.enable('org-a', '@handstack/isolated-redaction').then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error('Expected isolated plugin setup to fail');
      expect(failure.message).not.toContain('isolated-secret-value');
      expect(resolveSecret).toHaveBeenCalledTimes(2);
    } finally {
      await adapter.close();
    }
  });

  it('persists quarantine, disables an enabled plugin, and blocks re-enabling it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'handstack-plugin-quarantine-'));
    temporaryDirectories.push(directory);
    const source = `export default { manifest: { name: '@handstack/quarantine-test', version: '1.0.0', handstack: { apiVersion: '1', capabilities: ['tool'], mode: 'trusted' } }, setup() {}, onDisable() { globalThis.__handstackQuarantineDisableCalled = true; if (globalThis.__handstackQuarantineDisableFails) throw new Error('shutdown failed'); } };`;
    const entry = join(directory, 'index.mjs');
    await writeFile(entry, source, 'utf8');
    const checksum = createHash('sha256').update(source, 'utf8').digest('hex');
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const runtime = new PluginAdminRuntimeService({ adapter } as DatabaseService);
      const record = {
        manifest: {
          name: '@handstack/quarantine-test',
          version: '1.0.0',
          handstack: { apiVersion: '1', capabilities: ['tool'], mode: 'trusted' as const },
        },
        checksum,
        mode: 'trusted' as const,
        status: 'INSTALLED' as const,
        approvedPermissions: [],
      };
      const sourceDefinition = {
        kind: 'LOCAL' as const,
        locator: entry,
        checksum,
        supplyChain: testSupplyChain,
      };
      await runtime.install('org-a', record, sourceDefinition);
      await runtime.enable('org-a', '@handstack/quarantine-test');
      (globalThis as Record<string, unknown>).__handstackQuarantineDisableFails = true;
      await expect(
        runtime.quarantine(
          'org-a',
          '@handstack/quarantine-test',
          '1.0.0',
          'admin-user',
          'Malware scan reported a suspicious dependency',
        ),
      ).rejects.toThrow(/onDisable hook failed/);
      expect((globalThis as Record<string, unknown>).__handstackQuarantineDisableCalled).toBe(true);
      delete (globalThis as Record<string, unknown>).__handstackQuarantineDisableCalled;
      delete (globalThis as Record<string, unknown>).__handstackQuarantineDisableFails;
      await expect(runtime.enable('org-a', '@handstack/quarantine-test')).rejects.toThrow(
        /quarantined/,
      );
      await expect(runtime.list('org-a')).resolves.toMatchObject([
        { record: { status: 'DISABLED' } },
      ]);
    } finally {
      await adapter.close();
    }
  });

  it('honors a persistent publisher revocation during installation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'handstack-plugin-revoked-'));
    temporaryDirectories.push(directory);
    const source = `export default { manifest: { name: '@handstack/revoked-test', version: '1.0.0', handstack: { apiVersion: '1', capabilities: ['tool'], mode: 'trusted' } }, setup() {} };`;
    const entry = join(directory, 'index.mjs');
    await writeFile(entry, source, 'utf8');
    const checksum = createHash('sha256').update(source, 'utf8').digest('hex');
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const runtime = new PluginAdminRuntimeService({ adapter } as DatabaseService);
      const registry = new PluginRegistryRuntimeService({ adapter } as DatabaseService, runtime);
      const pluginRecord = {
        manifest: {
          name: '@handstack/revoked-test',
          version: '1.0.0',
          handstack: { apiVersion: '1', capabilities: ['tool'], mode: 'trusted' as const },
        },
        checksum,
        mode: 'trusted' as const,
        status: 'INSTALLED' as const,
        approvedPermissions: [],
      };
      const pluginSource = {
        kind: 'LOCAL' as const,
        locator: entry,
        checksum,
        supplyChain: testSupplyChain,
      };
      await runtime.install('org-a', pluginRecord, pluginSource);
      await runtime.enable('org-a', '@handstack/revoked-test');
      await registry.revokePublisher(
        'org-a',
        testSupplyChain.publisher,
        'admin-user',
        'Publisher revoked',
      );
      await expect(runtime.list('org-a')).resolves.toMatchObject([
        { record: { manifest: { name: '@handstack/revoked-test' }, status: 'DISABLED' } },
      ]);
      await expect(runtime.enable('org-a', '@handstack/revoked-test')).rejects.toThrow(
        /publisher is revoked/,
      );
      await expect(runtime.install('org-a', pluginRecord, pluginSource)).rejects.toThrow(
        /publisher is revoked/,
      );
    } finally {
      await adapter.close();
    }
  });
});
