import {
  PluginRegistry,
  type InstalledPlugin,
  type PluginCatalog,
  type PluginRegistryEntry,
} from '@handstack/plugins';
import { repositoryName, type Repository, type TenantEntity } from '@handstack/domain';
import { Injectable, Inject, Optional } from '@nestjs/common';
import { ValidationError } from '@handstack/shared';
import { DatabaseService } from '../database/database.service.js';
import { PluginAdminRuntimeService } from './plugin-admin.runtime.js';

@Injectable()
export class PluginRegistryRuntimeService {
  readonly registry = new PluginRegistry();
  private readonly installations: Repository<PluginInstallation>;
  private readonly controls: Repository<PluginRegistryControl>;

  constructor(
    @Inject(DatabaseService) database: DatabaseService,
    @Optional()
    @Inject(PluginAdminRuntimeService)
    private readonly pluginAdmin?: PluginAdminRuntimeService,
  ) {
    this.installations = database.adapter.repository<PluginInstallation>(
      repositoryName('plugin-installations'),
    );
    this.controls = database.adapter.repository<PluginRegistryControl>(
      repositoryName('plugin-registry-controls'),
    );
  }

  async search(
    query: string,
    catalog: PluginCatalog,
    organizationId?: string,
  ): Promise<readonly unknown[]> {
    if (catalog === 'INSTALLED' || catalog === 'UPDATES') {
      if (organizationId === undefined || organizationId.trim() === '')
        throw new ValidationError('organizationId is required for tenant plugin catalogs');
      const installed: InstalledPlugin[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.installations.list(organizationId, {
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        });
        installed.push(...page.items.map((item) => item.installation));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      if (catalog === 'INSTALLED') return filterPlugins(installed, query);
      const current = new Map(
        installed.map((plugin) => [plugin.record.manifest.name, plugin.record.manifest.version]),
      );
      const published = [
        ...this.registry.list('OFFICIAL'),
        ...this.registry.list('COMMUNITY'),
      ].filter((entry): entry is PluginRegistryEntry => 'manifest' in entry);
      const blocked = await this.blockedControls(organizationId);
      return filterPlugins(
        published.filter((entry) => {
          const version = current.get(entry.manifest.name);
          return (
            version !== undefined &&
            compareVersions(entry.manifest.version, version) > 0 &&
            !isBlocked(entry, blocked)
          );
        }),
        query,
      );
    }
    const entries = this.registry.search(query, catalog);
    if (organizationId === undefined) return entries;
    const blocked = await this.blockedControls(organizationId);
    return entries.filter((entry): boolean => !('manifest' in entry) || !isBlocked(entry, blocked));
  }

  async quarantine(
    organizationId: string,
    pluginName: string,
    version: string,
    actorId: string,
    reason: string,
  ): Promise<PluginRegistryControl> {
    if (this.pluginAdmin !== undefined)
      return this.pluginAdmin.quarantine(organizationId, pluginName, version, actorId, reason);
    return this.createControl({
      organizationId,
      pluginName,
      version,
      actorId,
      reason,
      action: 'QUARANTINE',
    });
  }

  async revokePublisher(
    organizationId: string,
    publisher: string,
    actorId: string,
    reason: string,
  ): Promise<PluginRegistryControl> {
    const control = await this.createControl({
      organizationId,
      pluginName: '*',
      publisher,
      actorId,
      reason,
      action: 'REVOKE_PUBLISHER',
    });
    await this.pluginAdmin?.disablePublisher(organizationId, publisher);
    return control;
  }

  private async createControl(input: {
    organizationId: string;
    pluginName: string;
    version?: string;
    publisher?: string;
    actorId: string;
    reason: string;
    action: PluginRegistryControl['action'];
  }): Promise<PluginRegistryControl> {
    if (input.reason.trim() === '') throw new ValidationError('Control reason is required');
    if (input.actorId.trim() === '') throw new ValidationError('Control actor is required');
    const now = new Date();
    return this.controls.insert({
      id: `${input.organizationId}:${input.action}:${input.pluginName}:${input.version ?? input.publisher ?? 'all'}:${String(now.getTime())}`,
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      pluginName: input.pluginName,
      ...(input.version === undefined ? {} : { pluginVersion: input.version }),
      ...(input.publisher === undefined ? {} : { publisher: input.publisher }),
      action: input.action,
      actorId: input.actorId,
      reason: input.reason.trim(),
    });
  }

  private async blockedControls(organizationId: string): Promise<readonly PluginRegistryControl[]> {
    const page = await this.controls.list(organizationId, { limit: 200 });
    return page.items;
  }
}

interface PluginInstallation extends TenantEntity {
  readonly organizationId: string;
  readonly installation: InstalledPlugin;
}

export interface PluginRegistryControl extends TenantEntity {
  readonly organizationId: string;
  readonly pluginName: string;
  readonly pluginVersion?: string;
  readonly publisher?: string;
  readonly action: 'QUARANTINE' | 'REVOKE_PUBLISHER';
  readonly actorId: string;
  readonly reason: string;
}

function isBlocked(
  entry: PluginRegistryEntry,
  controls: readonly PluginRegistryControl[],
): boolean {
  return controls.some(
    (control) =>
      (control.action === 'QUARANTINE' &&
        control.pluginName === entry.manifest.name &&
        control.pluginVersion === entry.manifest.version) ||
      (control.action === 'REVOKE_PUBLISHER' && control.publisher === entry.supplyChain.publisher),
  );
}

function filterPlugins(items: readonly unknown[], query: string): readonly unknown[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === '') return items;
  return items.filter((item) => {
    const manifest =
      'record' in (item as object)
        ? (item as InstalledPlugin).record.manifest
        : (
            item as {
              manifest: {
                name: string;
                description?: string;
                handstack: { capabilities: readonly string[] };
              };
            }
          ).manifest;
    return [manifest.name, manifest.description ?? '', ...manifest.handstack.capabilities].some(
      (value) => value.toLowerCase().includes(normalized),
    );
  });
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
