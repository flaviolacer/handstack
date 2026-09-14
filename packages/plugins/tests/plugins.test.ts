import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '../src/index.js';
import type { PluginRecord } from '@handstack/plugin-sdk';

const record: PluginRecord = {
  manifest: {
    name: '@handstack/demo',
    version: '1.0.0',
    handstack: { apiVersion: '1', capabilities: ['tools'] },
  },
  checksum: 'sha',
  mode: 'trusted',
  status: 'ENABLED',
  approvedPermissions: [],
};

describe('Plugin Registry', () => {
  it('supports official/community/installed/update catalogs and checksum pinning', () => {
    const registry = new PluginRegistry();
    registry.publish({
      manifest: record.manifest,
      source: { kind: 'NPM', locator: '@handstack/demo', checksum: 'sha' },
      catalog: 'OFFICIAL',
      publishedAt: new Date(),
    });
    registry.install(record, { kind: 'NPM', locator: '@handstack/demo', checksum: 'sha' });
    expect(registry.list('OFFICIAL')).toHaveLength(1);
    expect(registry.list('INSTALLED')).toHaveLength(1);
    expect(registry.list('UPDATES')).toHaveLength(0);
    expect(() =>
      registry.install({ ...record, checksum: 'bad' }, { kind: 'NPM', locator: '@handstack/demo' }),
    ).toThrow(/checksum/);
  });

  it('detects an available update', () => {
    const registry = new PluginRegistry();
    registry.publish({
      manifest: record.manifest,
      source: { kind: 'NPM', locator: '@handstack/demo' },
      catalog: 'COMMUNITY',
      publishedAt: new Date(),
    });
    registry.install(record, { kind: 'NPM', locator: '@handstack/demo' });
    registry.publish({
      manifest: { ...record.manifest, version: '2.0.0' },
      source: { kind: 'NPM', locator: '@handstack/demo' },
      catalog: 'COMMUNITY',
      publishedAt: new Date(),
    });
    expect(registry.list('UPDATES')).toHaveLength(1);
  });

  it('searches catalogs and enforces compatible monotonic upgrades', () => {
    const registry = new PluginRegistry();
    registry.publish({
      manifest: record.manifest,
      source: { kind: 'NPM', locator: '@handstack/demo' },
      catalog: 'OFFICIAL',
      publishedAt: new Date(),
    });
    registry.install(record, { kind: 'NPM', locator: '@handstack/demo' });
    expect(registry.search('tools')).toHaveLength(1);
    expect(() => registry.upgrade(record, { kind: 'NPM', locator: '@handstack/demo' })).toThrow(
      /increase/,
    );
    expect(
      registry.upgrade(
        { ...record, manifest: { ...record.manifest, version: '2.0.0' } },
        { kind: 'NPM', locator: '@handstack/demo' },
      ).record.manifest.version,
    ).toBe('2.0.0');
  });
});
