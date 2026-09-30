import type { PluginManifest, PluginRecord } from '@handstack/plugin-sdk';
import { ValidationError } from '@handstack/shared';

export type PluginCatalog = 'OFFICIAL' | 'COMMUNITY' | 'INSTALLED' | 'UPDATES';
export type PluginSourceKind = 'NPM' | 'GITHUB' | 'LOCAL';

export interface PluginSource {
  readonly kind: PluginSourceKind;
  readonly locator: string;
  /** SHA-256 digest of the immutable artifact selected by the locator. */
  readonly checksum: string;
  /** Supply-chain identity for administrative installations. */
  readonly supplyChain?: PluginSupplyChain;
  /** Raw attestations are accepted only for verification and are never persisted with the install. */
  readonly supplyChainDocuments?: {
    readonly sbom: string;
    readonly provenance: string;
  };
}

export interface PluginRegistryEntry {
  readonly manifest: PluginManifest;
  readonly source: PluginSource;
  readonly supplyChain: PluginSupplyChain;
  readonly catalog: Exclude<PluginCatalog, 'INSTALLED' | 'UPDATES'>;
  readonly publishedAt: Date;
  readonly deprecated?: boolean;
}

export interface PluginSupplyChain {
  readonly publisher: string;
  readonly signature: string;
  readonly sbomDigest: string;
  readonly provenanceDigest: string;
}

export interface InstalledPlugin {
  readonly record: PluginRecord;
  readonly source: PluginSource;
  readonly installedAt: Date;
}

export class PluginRegistry {
  private readonly entries = new Map<string, PluginRegistryEntry>();
  private readonly installed = new Map<string, InstalledPlugin>();
  private readonly quarantined = new Set<string>();
  private readonly revokedPublishers = new Set<string>();

  publish(entry: PluginRegistryEntry): void {
    validateSource(entry.source);
    validateSupplyChain(entry.supplyChain);
    if (this.revokedPublishers.has(entry.supplyChain.publisher))
      throw new ValidationError('Plugin publisher has been revoked');
    const key = keyOf(entry.manifest);
    this.entries.set(key, entry);
  }

  install(record: PluginRecord, source: PluginSource, now = new Date()): InstalledPlugin {
    validateSource(source);
    if (this.isBlocked(record.manifest.name, record.manifest.version))
      throw new ValidationError('Plugin version is quarantined or its publisher is revoked');
    const expected = this.entries.get(keyOf(record.manifest));
    if (expected?.source.checksum !== undefined && expected.source.checksum !== record.checksum)
      throw new ValidationError('Plugin checksum does not match registry');
    const installed: InstalledPlugin = { record, source, installedAt: now };
    this.installed.set(record.manifest.name, installed);
    return installed;
  }

  list(catalog: PluginCatalog): readonly (PluginRegistryEntry | InstalledPlugin)[] {
    if (catalog === 'INSTALLED') return [...this.installed.values()];
    if (catalog === 'UPDATES')
      return [...this.entries.values()].filter((entry) => {
        const current = this.installed.get(entry.manifest.name);
        return (
          current !== undefined &&
          compareVersions(entry.manifest.version, current.record.manifest.version) > 0
        );
      });
    return [...this.entries.values()].filter(
      (entry) =>
        entry.catalog === catalog && !this.isBlocked(entry.manifest.name, entry.manifest.version),
    );
  }

  search(
    query: string,
    catalog: PluginCatalog = 'OFFICIAL',
  ): readonly (PluginRegistryEntry | InstalledPlugin)[] {
    const normalized = query.trim().toLowerCase();
    if (normalized === '') return this.list(catalog);
    return this.list(catalog).filter((item) => {
      const manifest = 'record' in item ? item.record.manifest : item.manifest;
      return [manifest.name, manifest.description ?? '', ...manifest.handstack.capabilities].some(
        (value) => value.toLowerCase().includes(normalized),
      );
    });
  }

  upgrade(record: PluginRecord, source: PluginSource): InstalledPlugin {
    const current = this.installed.get(record.manifest.name);
    if (current === undefined) throw new ValidationError('Plugin is not installed');
    if (compareVersions(record.manifest.version, current.record.manifest.version) <= 0)
      throw new ValidationError('Plugin upgrade must increase the version');
    if (record.manifest.handstack.apiVersion !== current.record.manifest.handstack.apiVersion)
      throw new ValidationError('Plugin API version is incompatible');
    return this.install(record, source);
  }

  uninstall(name: string): void {
    this.installed.delete(name);
  }

  quarantine(name: string, version: string): void {
    this.quarantined.add(`${name}@${version}`);
  }

  revokePublisher(publisher: string): void {
    if (publisher.trim() === '') throw new ValidationError('Plugin publisher is required');
    this.revokedPublishers.add(publisher);
  }

  clearQuarantine(name: string, version: string): void {
    this.quarantined.delete(`${name}@${version}`);
  }

  isBlocked(name: string, version: string): boolean {
    const entry = this.entries.get(`${name}@${version}`);
    return (
      this.quarantined.has(`${name}@${version}`) ||
      (entry !== undefined && this.revokedPublishers.has(entry.supplyChain.publisher))
    );
  }

  enable(name: string): InstalledPlugin {
    const current = this.installed.get(name);
    if (current === undefined) throw new ValidationError('Plugin is not installed');
    const enabled: InstalledPlugin = {
      ...current,
      record: { ...current.record, status: 'ENABLED' },
    };
    this.installed.set(name, enabled);
    return enabled;
  }

  get(name: string, version?: string): PluginRegistryEntry | InstalledPlugin | undefined {
    if (version === undefined)
      return (
        this.installed.get(name) ??
        [...this.entries.values()].find(
          (entry) =>
            entry.manifest.name === name &&
            !this.isBlocked(entry.manifest.name, entry.manifest.version),
        )
      );
    const entry = this.entries.get(`${name}@${version}`);
    return entry !== undefined && !this.isBlocked(name, version) ? entry : undefined;
  }
}

function keyOf(manifest: PluginManifest): string {
  return `${manifest.name}@${manifest.version}`;
}

function validateSource(source: PluginSource): void {
  if (source.locator.trim() === '') throw new ValidationError('Plugin source locator is required');
  if (!/^[a-f0-9]{64}$/u.test(source.checksum))
    throw new ValidationError('Plugin source checksum must be a SHA-256 digest');
  if (source.kind === 'NPM' && !/^(@?[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/u.test(source.locator))
    throw new ValidationError('Invalid npm plugin locator');
  if (source.kind === 'GITHUB' && !/^[\w.-]+\/[\w.-]+(?:#.+)?$/u.test(source.locator))
    throw new ValidationError('Invalid GitHub plugin locator');
}

function validateSupplyChain(supplyChain: PluginSupplyChain): void {
  if (supplyChain.publisher.trim() === '' || supplyChain.signature.trim() === '')
    throw new ValidationError('Plugin publisher and signature are required');
  for (const [name, digest] of [
    ['SBOM', supplyChain.sbomDigest],
    ['provenance', supplyChain.provenanceDigest],
  ] as const) {
    if (!/^[a-f0-9]{64}$/u.test(digest))
      throw new ValidationError(`Plugin ${name} digest must be a SHA-256 digest`);
  }
}

function compareVersions(left: string, right: string): number {
  const a = left
    .replace(/^v/u, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  const b = right
    .replace(/^v/u, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}
