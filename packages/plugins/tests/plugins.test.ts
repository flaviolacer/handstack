import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '../src/index.js';
import type { PluginRecord } from '@handstack/plugin-sdk';

const record: PluginRecord = {
  manifest: {
    name: '@handstack/demo',
    version: '1.0.0',
    handstack: { apiVersion: '1', capabilities: ['tools'] },
  },
  checksum: 'a'.repeat(64),
  mode: 'trusted',
  status: 'ENABLED',
  approvedPermissions: [],
};

describe('Plugin Registry', () => {
  it('supports official/community/installed/update catalogs and checksum pinning', () => {
    const registry = new PluginRegistry();
    registry.publish({
      manifest: record.manifest,
      source: { kind: 'NPM', locator: '@handstack/demo', checksum: 'a'.repeat(64) },
      supplyChain: {
        publisher: 'handstack',
        signature: 'sig',
        sbomDigest: 'b'.repeat(64),
        provenanceDigest: 'c'.repeat(64),
      },
      catalog: 'OFFICIAL',
      publishedAt: new Date(),
    });
    registry.install(record, { kind: 'NPM', locator: '@handstack/demo', checksum: 'a'.repeat(64) });
    expect(registry.list('OFFICIAL')).toHaveLength(1);
    expect(registry.list('INSTALLED')).toHaveLength(1);
    expect(registry.list('UPDATES')).toHaveLength(0);
    expect(() =>
      registry.install(
        { ...record, checksum: 'bad' },
        { kind: 'NPM', locator: '@handstack/demo', checksum: 'a'.repeat(64) },
      ),
    ).toThrow(/checksum/);
  });

  it('detects an available update', () => {
    const registry = new PluginRegistry();
    registry.publish({
      manifest: record.manifest,
      source: { kind: 'NPM', locator: '@handstack/demo', checksum: 'a'.repeat(64) },
      supplyChain: {
        publisher: 'handstack',
        signature: 'sig',
        sbomDigest: 'b'.repeat(64),
        provenanceDigest: 'c'.repeat(64),
      },
      catalog: 'COMMUNITY',
      publishedAt: new Date(),
    });
    registry.install(record, { kind: 'NPM', locator: '@handstack/demo', checksum: 'a'.repeat(64) });
    registry.publish({
      manifest: { ...record.manifest, version: '2.0.0' },
      source: { kind: 'NPM', locator: '@handstack/demo', checksum: 'a'.repeat(64) },
      supplyChain: {
        publisher: 'handstack',
        signature: 'sig',
        sbomDigest: 'b'.repeat(64),
        provenanceDigest: 'c'.repeat(64),
      },
      catalog: 'COMMUNITY',
      publishedAt: new Date(),
    });
    expect(registry.list('UPDATES')).toHaveLength(1);
  });

  it('searches catalogs and enforces compatible monotonic upgrades', () => {
    const registry = new PluginRegistry();
    registry.publish({
      manifest: record.manifest,
      source: { kind: 'NPM', locator: '@handstack/demo', checksum: 'a'.repeat(64) },
      supplyChain: {
        publisher: 'handstack',
        signature: 'sig',
        sbomDigest: 'b'.repeat(64),
        provenanceDigest: 'c'.repeat(64),
      },
      catalog: 'OFFICIAL',
      publishedAt: new Date(),
    });
    registry.install(record, { kind: 'NPM', locator: '@handstack/demo', checksum: 'a'.repeat(64) });
    expect(registry.search('tools')).toHaveLength(1);
    expect(() =>
      registry.upgrade(record, {
        kind: 'NPM',
        locator: '@handstack/demo',
        checksum: 'a'.repeat(64),
      }),
    ).toThrow(/increase/);
    expect(
      registry.upgrade(
        { ...record, manifest: { ...record.manifest, version: '2.0.0' } },
        { kind: 'NPM', locator: '@handstack/demo', checksum: 'a'.repeat(64) },
      ).record.manifest.version,
    ).toBe('2.0.0');
  });

  it('fails closed for quarantined versions and revoked publishers', () => {
    const registry = new PluginRegistry();
    const entry = {
      manifest: record.manifest,
      source: { kind: 'NPM' as const, locator: '@handstack/demo', checksum: 'a'.repeat(64) },
      supplyChain: {
        publisher: 'community-publisher',
        signature: 'sig',
        sbomDigest: 'b'.repeat(64),
        provenanceDigest: 'c'.repeat(64),
      },
      catalog: 'COMMUNITY' as const,
      publishedAt: new Date(),
    };
    registry.publish(entry);
    registry.quarantine(record.manifest.name, record.manifest.version);
    expect(registry.list('COMMUNITY')).toHaveLength(0);
    expect(() => registry.install(record, entry.source)).toThrow(/quarantined/);
    registry.clearQuarantine(record.manifest.name, record.manifest.version);
    registry.revokePublisher('community-publisher');
    expect(registry.get(record.manifest.name, record.manifest.version)).toBeUndefined();
    expect(() => registry.install(record, entry.source)).toThrow(/quarantined|revoked/);
  });
});
