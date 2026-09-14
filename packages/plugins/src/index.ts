import type { PluginManifest, PluginRecord } from '@handstack/plugin-sdk';
import { ValidationError } from '@handstack/shared';

export type PluginCatalog = 'OFFICIAL' | 'COMMUNITY' | 'INSTALLED' | 'UPDATES';
export type PluginSourceKind = 'NPM' | 'GITHUB' | 'LOCAL';

export interface PluginSource {
  readonly kind: PluginSourceKind;
  readonly locator: string;
  readonly checksum?: string;
}

export interface PluginRegistryEntry {
  readonly manifest: PluginManifest;
  readonly source: PluginSource;
  readonly catalog: Exclude<PluginCatalog, 'INSTALLED' | 'UPDATES'>;
  readonly publishedAt: Date;
  readonly deprecated?: boolean;
}

export interface InstalledPlugin {
  readonly record: PluginRecord;
  readonly source: PluginSource;
  readonly installedAt: Date;
}

export class PluginRegistry {
  private readonly entries = new Map<string, PluginRegistryEntry>();
  private readonly installed = new Map<string, InstalledPlugin>();

  publish(entry: PluginRegistryEntry): void {
    validateSource(entry.source);
    const key = keyOf(entry.manifest);
    this.entries.set(key, entry);
  }

  install(record: PluginRecord, source: PluginSource, now = new Date()): InstalledPlugin {
    validateSource(source);
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
    return [...this.entries.values()].filter((entry) => entry.catalog === catalog);
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

  get(name: string, version?: string): PluginRegistryEntry | InstalledPlugin | undefined {
    if (version === undefined)
      return (
        this.installed.get(name) ??
        [...this.entries.values()].find((entry) => entry.manifest.name === name)
      );
    return this.entries.get(`${name}@${version}`);
  }
}

function keyOf(manifest: PluginManifest): string {
  return `${manifest.name}@${manifest.version}`;
}

function validateSource(source: PluginSource): void {
  if (source.locator.trim() === '') throw new ValidationError('Plugin source locator is required');
  if (source.kind === 'NPM' && !/^(@?[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/u.test(source.locator))
    throw new ValidationError('Invalid npm plugin locator');
  if (source.kind === 'GITHUB' && !/^[\w.-]+\/[\w.-]+(?:#.+)?$/u.test(source.locator))
    throw new ValidationError('Invalid GitHub plugin locator');
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
