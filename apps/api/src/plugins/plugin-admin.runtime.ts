import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readFile as readTextFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repositoryName, type Repository, type TenantEntity } from '@handstack/domain';
import { PluginRegistry, type InstalledPlugin, type PluginSource } from '@handstack/plugins';
import {
  PluginHost,
  type PluginDefinition,
  type PluginPermission,
  type PluginRecord,
} from '@handstack/plugin-sdk';
import {
  NodeProcessSandboxExecutor,
  ProcessIsolatedSandboxProvider,
  type SandboxProfile,
} from '@handstack/sandbox';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { listAllTenant } from '../database/pagination.js';
import { SecretRuntimeService } from '../secrets/secret-runtime.service.js';
import { configFromEnvironment, type HandStackConfig } from '@handstack/config';

/** Normative tenant-owned installation entity from specification section 129. */
export interface PluginInstallation extends TenantEntity {
  readonly organizationId: string;
  readonly installation: InstalledPlugin;
}
export interface PluginControl extends TenantEntity {
  readonly organizationId: string;
  readonly pluginName: string;
  readonly pluginVersion?: string;
  readonly publisher?: string;
  readonly action: 'QUARANTINE' | 'REVOKE_PUBLISHER';
  readonly actorId: string;
  readonly reason: string;
}
const installations = repositoryName('plugin-installations');
const controls = repositoryName('plugin-registry-controls');

@Injectable()
export class PluginAdminRuntimeService {
  readonly registry = new PluginRegistry();
  private readonly store: Repository<PluginInstallation>;
  private readonly controlStore: Repository<PluginControl>;
  private readonly hosts = new Map<string, PluginHost>();
  private readonly pluginConfig: HandStackConfig['plugins'];
  constructor(
    @Inject(DatabaseService) database: DatabaseService,
    @Optional() @Inject(SecretRuntimeService) private readonly secretRuntime?: SecretRuntimeService,
  ) {
    const configuredDatabase = database as Omit<DatabaseService, 'config'> & {
      config?: HandStackConfig;
    };
    this.pluginConfig =
      configuredDatabase.config?.plugins ?? configFromEnvironment(process.env).plugins;
    this.store = database.adapter.repository(installations);
    this.controlStore = database.adapter.repository(controls);
  }

  /** Reports whether the configured plugin execution boundary is available. */
  health(): boolean {
    if (!this.pluginConfig.isolationRequired) return true;
    return [
      resolve(process.cwd(), 'dist/plugins/isolated-plugin-child.js'),
      resolve(process.cwd(), 'apps/api/dist/plugins/isolated-plugin-child.js'),
    ].some((candidate) => existsSync(candidate));
  }

  async list(organizationId: string) {
    return (await listAllTenant(this.store, organizationId, 100)).map((item) => item.installation);
  }

  async install(organizationId: string, record: PluginRecord, source: PluginSource) {
    await this.assertNotBlocked(
      organizationId,
      record.manifest.name,
      record.manifest.version,
      source,
    );
    const installed = await this.loadPlugin(organizationId, record, source);
    const now = new Date();
    await this.store.insert({
      id: `${organizationId}:${record.manifest.name}`,
      tenantId: organizationId,
      organizationId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      installation: installed,
    });
    return installed;
  }

  async disable(organizationId: string, name: string) {
    const existing = (await listAllTenant(this.store, organizationId, 100)).find(
      (item) => item.installation.record.manifest.name === name,
    );
    if (existing === undefined) throw new Error('Plugin is not installed');
    const hostKeyValue = hostKey(organizationId, name);
    const host = this.hosts.get(hostKeyValue);
    let lifecycleFailed = false;
    let record: PluginRecord;
    if (existing.installation.record.status === 'ENABLED' && host !== undefined) {
      try {
        record = await host.disable(name);
      } catch {
        // A failing shutdown hook must not leave a revoked plugin marked or usable as enabled.
        lifecycleFailed = true;
        this.hosts.delete(hostKeyValue);
        record = { ...existing.installation.record, status: 'DISABLED' };
      }
    } else {
      record = { ...existing.installation.record, status: 'DISABLED' };
    }
    const installation = {
      ...existing.installation,
      record,
    };
    const updated = await this.store.update(
      { ...existing, installation, version: existing.version + 1, updatedAt: new Date() },
      existing.version,
    );
    if (lifecycleFailed) throw new Error('Plugin was disabled, but its onDisable hook failed');
    return updated.installation;
  }

  /** Disable every installed plugin attributed to a revoked publisher. */
  async disablePublisher(organizationId: string, publisher: string): Promise<void> {
    const installed = await listAllTenant(this.store, organizationId, 100);
    const failed: string[] = [];
    for (const item of installed) {
      if (
        item.installation.record.status === 'ENABLED' &&
        item.installation.source.supplyChain?.publisher === publisher
      ) {
        const name = item.installation.record.manifest.name;
        try {
          await this.disable(organizationId, name);
        } catch {
          failed.push(name);
        }
      }
    }
    if (failed.length > 0)
      throw new Error(`Publisher was revoked; disable hooks failed for: ${failed.join(', ')}`);
  }

  async enable(organizationId: string, name: string) {
    const existing = (await listAllTenant(this.store, organizationId, 100)).find(
      (item) => item.installation.record.manifest.name === name,
    );
    if (existing === undefined) throw new Error('Plugin is not installed');
    await this.assertNotBlocked(
      organizationId,
      name,
      existing.installation.record.manifest.version,
      existing.installation.source,
    );
    const host = await this.ensureHost(organizationId, existing.installation);
    const enabledRecord = await host.enable(name);
    const installation = { ...existing.installation, record: enabledRecord };
    const updated = await this.store.update(
      { ...existing, installation, version: existing.version + 1, updatedAt: new Date() },
      existing.version,
    );
    return updated.installation;
  }

  async upgrade(organizationId: string, name: string, record: PluginRecord, source: PluginSource) {
    if (record.manifest.name !== name)
      throw new Error('Plugin upgrade name does not match the installed plugin');
    const existing = (await listAllTenant(this.store, organizationId, 100)).find(
      (item) => item.installation.record.manifest.name === name,
    );
    if (existing === undefined) throw new Error('Plugin is not installed');
    await this.assertNotBlocked(organizationId, name, record.manifest.version, source);
    const currentVersion = versionNumber(existing.installation.record.manifest.version);
    if (versionNumber(record.manifest.version) <= currentVersion)
      throw new Error('Plugin upgrade must increase the version');
    const installed = await this.loadPlugin(organizationId, record, source);
    const updated = await this.store.update(
      {
        ...existing,
        installation: installed,
        version: existing.version + 1,
        updatedAt: new Date(),
      },
      existing.version,
    );
    return updated.installation;
  }

  async uninstall(organizationId: string, name: string): Promise<void> {
    const existing = (await listAllTenant(this.store, organizationId, 100)).find(
      (item) => item.installation.record.manifest.name === name,
    );
    if (existing === undefined) throw new Error('Plugin is not installed');
    const host = this.hosts.get(hostKey(organizationId, name));
    await host?.uninstall(name);
    this.hosts.delete(hostKey(organizationId, name));
    await this.store.delete(organizationId, existing.id, existing.version);
    this.registry.uninstall(name);
  }

  async quarantine(
    organizationId: string,
    name: string,
    version: string,
    actorId: string,
    reason: string,
  ): Promise<PluginControl> {
    if (reason.trim() === '') throw new Error('Quarantine reason is required');
    const existing = (await listAllTenant(this.store, organizationId, 100)).find(
      (item) =>
        item.installation.record.manifest.name === name &&
        item.installation.record.manifest.version === version,
    );
    const now = new Date();
    const control = await this.controlStore.insert({
      id: `${organizationId}:QUARANTINE:${name}:${version}:${String(now.getTime())}`,
      tenantId: organizationId,
      organizationId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      pluginName: name,
      pluginVersion: version,
      action: 'QUARANTINE',
      actorId,
      reason: reason.trim(),
    });
    if (existing?.installation.record.status === 'ENABLED')
      await this.disable(organizationId, name);
    return control;
  }

  private async assertNotBlocked(
    organizationId: string,
    name: string,
    version: string,
    source: PluginSource,
  ): Promise<void> {
    const page = await this.controlStore.list(organizationId, { limit: 200 });
    const blocked = page.items.find(
      (control) =>
        (control.action === 'QUARANTINE' &&
          control.pluginName === name &&
          control.pluginVersion === version) ||
        (control.action === 'REVOKE_PUBLISHER' &&
          source.supplyChain?.publisher === control.publisher),
    );
    if (blocked?.action === 'QUARANTINE') throw new Error('Plugin version is quarantined');
    if (blocked?.action === 'REVOKE_PUBLISHER') throw new Error('Plugin publisher is revoked');
  }

  private async loadPlugin(
    organizationId: string,
    record: PluginRecord,
    source: PluginSource,
  ): Promise<InstalledPlugin> {
    validateSupplyChain(source.supplyChain);
    const artifact = await pluginArtifact(source, this.pluginConfig.cacheDir);
    const digest = createHash('sha256').update(artifact.bytes).digest('hex');
    if (digest !== record.checksum || source.checksum !== digest)
      throw new Error('Plugin checksum does not match the submitted artifact');
    if (source.kind !== 'LOCAL') {
      if (record.mode !== 'isolated' || record.manifest.handstack.mode !== 'isolated')
        throw new Error('External plugins must run in the isolated sandbox');
      verifyExternalPluginSignature(
        record.manifest.name,
        record.manifest.version,
        source,
        this.pluginConfig.trustedPublishers,
      );
      verifyExternalPluginAttestations(
        record.manifest.name,
        record.manifest.version,
        source,
        digest,
      );
    }
    let definition: PluginDefinition;
    if (record.mode === 'isolated') {
      // Never import untrusted code in the API process. The child runner loads
      // the verified bytes after the sandbox has been prepared.
      if (record.manifest.handstack.mode !== 'isolated')
        throw new Error('Isolated plugin record must declare isolated mode');
      definition = {
        manifest: record.manifest,
        setup: () => undefined,
        onInstall: () =>
          this.runIsolatedPlugin(
            organizationId,
            { manifest: record.manifest },
            undefined,
            artifact.bytes,
            'onInstall',
          ),
        onEnable: () =>
          this.runIsolatedPlugin(
            organizationId,
            { manifest: record.manifest },
            undefined,
            artifact.bytes,
            'onEnable',
          ),
        onDisable: () =>
          this.runIsolatedPlugin(
            organizationId,
            { manifest: record.manifest },
            undefined,
            artifact.bytes,
            'onDisable',
          ),
        onUninstall: () =>
          this.runIsolatedPlugin(
            organizationId,
            { manifest: record.manifest },
            undefined,
            artifact.bytes,
            'onUninstall',
          ),
      };
    } else {
      const loaded = (await import(pathToFileURL(artifact.entry).href)) as {
        readonly default?: unknown;
      };
      const candidate = loaded.default;
      if (
        !isPluginDefinition(candidate) ||
        candidate.manifest.name !== record.manifest.name ||
        candidate.manifest.version !== record.manifest.version
      )
        throw new Error('Local plugin entrypoint does not match its manifest');
      definition = candidate;
    }
    const host = this.createHost(record.approvedPermissions, organizationId);
    const installedRecord = await host.install(definition, artifact.bytes);
    this.hosts.set(hostKey(organizationId, record.manifest.name), host);
    const persistedSource = { ...source };
    delete persistedSource.supplyChainDocuments;
    return { record: installedRecord, source: persistedSource, installedAt: new Date() };
  }

  private async ensureHost(
    organizationId: string,
    installation: InstalledPlugin,
  ): Promise<PluginHost> {
    const key = hostKey(organizationId, installation.record.manifest.name);
    const current = this.hosts.get(key);
    if (current !== undefined) return current;
    await this.loadPlugin(organizationId, installation.record, installation.source);
    const host = this.hosts.get(key);
    if (host === undefined) throw new Error('Plugin runtime is unavailable');
    return host;
  }

  private createHost(
    approvedPermissions: readonly PluginPermission[],
    organizationId: string,
  ): PluginHost {
    return new PluginHost({
      approve: () => Promise.resolve(approvedPermissions),
      resolveSecret: (reference, pluginName) =>
        this.secretRuntime === undefined
          ? Promise.resolve(undefined)
          : this.secretRuntime.resolve(reference, organizationId, pluginName),
      isolatedRpc: (plugin, context, sourceBytes) =>
        this.runIsolatedPlugin(organizationId, plugin, context, sourceBytes),
    });
  }

  private async runIsolatedPlugin(
    organizationId: string,
    plugin: Pick<PluginDefinition, 'manifest'>,
    context:
      | Parameters<NonNullable<ConstructorParameters<typeof PluginHost>[0]['isolatedRpc']>>[1]
      | undefined,
    sourceBytes: Uint8Array,
    operation: 'setup' | 'onInstall' | 'onEnable' | 'onDisable' | 'onUninstall' = 'setup',
  ): Promise<void> {
    const runnerCandidates = [
      resolve(process.cwd(), 'dist/plugins/isolated-plugin-child.js'),
      resolve(process.cwd(), 'apps/api/dist/plugins/isolated-plugin-child.js'),
    ];
    const runner = runnerCandidates.find((candidate) => existsSync(candidate));
    if (runner === undefined) throw new Error('Isolated plugin runner is not built');
    const directory = await mkdtemp(join(process.cwd(), '.handstack-plugin-'));
    const artifact = join(directory, 'plugin.mjs');
    await writeFile(artifact, sourceBytes);
    const profile: SandboxProfile = {
      id: `plugin-${plugin.manifest.name}-${plugin.manifest.version}`,
      organizationId,
      executionIdentity: plugin.manifest.name,
      resourceLimits: {
        executionTimeoutMs: 10_000,
        maxOutputBytes: 1_000_000,
        maxLogBytes: 100_000,
        maxProcesses: 1,
      },
      readOnlyRootFilesystem: true,
      writableMounts: [directory],
      network: { policy: 'deny-all', allowlist: [] },
      secretHandles: [],
      capabilities: [],
      artifactPolicy: { ingress: 'none', egress: 'none', allowedPaths: [directory] },
    };
    const provider = new ProcessIsolatedSandboxProvider(new NodeProcessSandboxExecutor());
    let handle;
    const resolvedSecretValues: string[] = [];
    try {
      handle = await provider.prepare(profile);
      const result = await provider.execute(handle, {
        command: [process.execPath, runner, artifact, operation],
        rpcHandler: async (request) => {
          if (
            typeof request !== 'object' ||
            request === null ||
            Array.isArray(request) ||
            (request as Record<string, unknown>).method !== 'secrets.get'
          )
            throw new Error('Unsupported isolated plugin host capability');
          const params = (request as Record<string, unknown>).params;
          if (
            typeof params !== 'object' ||
            params === null ||
            Array.isArray(params) ||
            typeof (params as Record<string, unknown>).reference !== 'string'
          )
            throw new Error('Invalid isolated plugin secret request');
          if (context === undefined) throw new Error('Plugin host context is unavailable');
          const value = await context.secrets.get((params as { reference: string }).reference);
          if (value !== undefined && value !== '') resolvedSecretValues.push(value);
          return value;
        },
      });
      const redact = (value: string): string =>
        resolvedSecretValues.reduce(
          (sanitized, secret) => sanitized.replaceAll(secret, '[REDACTED]'),
          value,
        );
      const stdout = redact(result.stdout);
      const stderr = redact(result.stderr);
      if (result.exitCode !== 0 || result.timedOut)
        throw new Error(`Isolated plugin runner failed: ${stderr.slice(0, 500)}`);
      for (const line of stdout.split(/\r?\n/u).filter((value) => value.trim() !== '')) {
        const message = JSON.parse(line) as { readonly type?: string; readonly value?: unknown };
        if (message.type === 'tool')
          context?.tools.register(
            message.value as Parameters<NonNullable<typeof context>['tools']['register']>[0],
          );
        else if (message.type === 'provider')
          context?.providers.register(
            message.value as Parameters<NonNullable<typeof context>['providers']['register']>[0],
          );
        else if (message.type === 'capability') {
          if (context !== undefined)
            await context.capabilities.register(
              message.value as Parameters<typeof context.capabilities.register>[0],
            );
        } else if (message.type === 'ui')
          context?.ui.register(
            message.value as Parameters<NonNullable<typeof context>['ui']['register']>[0],
          );
        else if (message.type === 'identity')
          context?.identity.register(
            message.value as Parameters<NonNullable<typeof context>['identity']['register']>[0],
          );
        else if (message.type !== 'ready')
          throw new Error('Isolated plugin emitted an unknown registration message');
      }
    } finally {
      if (handle !== undefined) await provider.terminate(handle);
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function validateSupplyChain(value: PluginSource['supplyChain']): void {
  if (
    value === undefined ||
    value.publisher.trim() === '' ||
    value.signature.trim() === '' ||
    !/^[a-f0-9]{64}$/u.test(value.sbomDigest) ||
    !/^[a-f0-9]{64}$/u.test(value.provenanceDigest)
  )
    throw new Error('Plugin supply-chain metadata is required and invalid');
}

function verifyExternalPluginSignature(
  pluginName: string,
  pluginVersion: string,
  source: PluginSource,
  trustedPublishers: Readonly<Record<string, string>>,
): void {
  const publisher = source.supplyChain?.publisher;
  if (Object.keys(trustedPublishers).length === 0)
    throw new Error('External plugin publisher trust store is not configured');
  const publicKey = trustedPublishers[publisher ?? ''];
  const signature = source.supplyChain?.signature ?? '';
  if (typeof publicKey !== 'string' || publicKey.trim() === '')
    throw new Error('External plugin publisher is not trusted');
  if (!/^[A-Za-z0-9_-]{86}$/u.test(signature))
    throw new Error('External plugin signature must be an Ed25519 base64url signature');
  const payload = JSON.stringify({
    publisher,
    pluginName,
    pluginVersion,
    checksum: source.checksum,
    sbomDigest: source.supplyChain?.sbomDigest,
    provenanceDigest: source.supplyChain?.provenanceDigest,
  });
  try {
    const key = createPublicKey(publicKey);
    const valid = verifySignature(
      null,
      Buffer.from(payload, 'utf8'),
      key,
      Buffer.from(signature, 'base64url'),
    );
    if (!valid) throw new Error('invalid');
  } catch {
    throw new Error('External plugin publisher signature verification failed');
  }
}

function verifyExternalPluginAttestations(
  pluginName: string,
  pluginVersion: string,
  source: PluginSource,
  artifactDigest: string,
): void {
  const documents = source.supplyChainDocuments;
  const supplyChain = source.supplyChain;
  if (documents === undefined || supplyChain === undefined)
    throw new Error('External plugin SBOM and provenance documents are required');
  if (
    documents.sbom.length === 0 ||
    documents.sbom.length > 2_000_000 ||
    documents.provenance.length === 0 ||
    documents.provenance.length > 1_000_000
  )
    throw new Error('External plugin SBOM/provenance documents exceed the allowed size');
  if (
    createHash('sha256').update(documents.sbom, 'utf8').digest('hex') !== supplyChain.sbomDigest ||
    createHash('sha256').update(documents.provenance, 'utf8').digest('hex') !==
      supplyChain.provenanceDigest
  )
    throw new Error('External plugin SBOM/provenance digest does not match its document');
  const sbom = parseAttestationDocument(documents.sbom, 'SBOM');
  const isCycloneDx =
    sbom.bomFormat === 'CycloneDX' &&
    typeof sbom.specVersion === 'string' &&
    sbom.metadata !== undefined &&
    typeof sbom.metadata === 'object' &&
    sbom.metadata !== null &&
    'component' in sbom.metadata &&
    componentMatches(sbom.metadata.component, pluginName, pluginVersion);
  const isSpdx =
    typeof sbom.spdxVersion === 'string' &&
    Array.isArray(sbom.packages) &&
    sbom.packages.some((item: unknown) => spdxPackageMatches(item, pluginName, pluginVersion));
  if (!isCycloneDx && !isSpdx)
    throw new Error('External plugin SBOM must identify the installed package and version');

  const attestation = parseAttestationDocument(documents.provenance, 'provenance');
  const subjects = attestation.subject;
  const subjectMatches =
    Array.isArray(subjects) &&
    subjects.some((item: unknown) => {
      if (!isRecord(item)) return false;
      const digests = item.digest;
      return (
        isRecord(digests) && typeof digests.sha256 === 'string' && digests.sha256 === artifactDigest
      );
    });
  if (
    attestation._type !== 'https://in-toto.io/Statement/v1' ||
    typeof attestation.predicateType !== 'string' ||
    !attestation.predicateType.startsWith('https://slsa.dev/provenance/') ||
    !subjectMatches ||
    typeof attestation.predicate !== 'object' ||
    attestation.predicate === null
  )
    throw new Error('External plugin provenance must be a matching in-toto SLSA attestation');
}

function parseAttestationDocument(value: string, name: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // Return one sanitized validation error below.
  }
  throw new Error(`External plugin ${name} document must be a JSON object`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function componentMatches(value: unknown, name: string, version: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    value.name === name &&
    'version' in value &&
    value.version === version
  );
}

function spdxPackageMatches(value: unknown, name: string, version: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    value.name === name &&
    'versionInfo' in value &&
    value.versionInfo === version
  );
}

interface LocalArtifact {
  readonly entry: string;
  readonly bytes: Uint8Array;
}

/** Resolves only pre-provisioned plugin artifacts; this boundary never installs packages or follows URLs. */
async function pluginArtifact(
  source: PluginSource,
  configuredCache?: string,
): Promise<LocalArtifact> {
  if (!/^[a-f0-9]{64}$/u.test(source.checksum))
    throw new Error('Plugin checksum is required and must be a SHA-256 digest');
  if (source.kind === 'LOCAL') return localArtifact(source.locator);
  const cache = configuredCache?.trim();
  if (cache === undefined || cache === '')
    throw new Error('External plugin cache is not configured; refusing network installation');
  const relative =
    source.kind === 'NPM'
      ? join('npm', safeLocator(source.locator))
      : join('github', safeLocator(source.locator));
  return localArtifact(resolve(cache, relative));
}

function safeLocator(locator: string): string {
  if (locator.includes('..') || locator.includes('\\') || locator.startsWith('/'))
    throw new Error('Plugin locator contains an unsafe path segment');
  return locator.replace(/[:#]/gu, '_');
}

async function localArtifact(locator: string): Promise<LocalArtifact> {
  const path = resolve(locator);
  const details = await stat(path);
  const entry = details.isDirectory() ? await directoryEntry(path) : path;
  return { entry, bytes: await readFile(entry) };
}

async function directoryEntry(directory: string): Promise<string> {
  try {
    const packageJson = JSON.parse(await readTextFile(join(directory, 'package.json'), 'utf8')) as {
      main?: unknown;
    };
    if (typeof packageJson.main === 'string' && packageJson.main.trim() !== '')
      return resolve(directory, packageJson.main);
  } catch {
    // Use the conventional entrypoint when package metadata is absent.
  }
  return join(directory, 'index.js');
}

function hostKey(organizationId: string, name: string): string {
  return `${organizationId}:${name}`;
}

function versionNumber(value: string): number {
  const parts = value
    .replace(/^v/u, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  return (parts[0] ?? 0) * 1_000_000 + (parts[1] ?? 0) * 1_000 + (parts[2] ?? 0);
}

function isPluginDefinition(value: unknown): value is PluginDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    'manifest' in value &&
    'setup' in value &&
    typeof value.setup === 'function'
  );
}
