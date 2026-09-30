import { Inject, Injectable } from '@nestjs/common';
import { repositoryName, uuidV7 } from '@handstack/domain';
import {
  configLayerFromEnvironment,
  resolveConfigLayers,
  type HandStackConfig,
  type HandStackConfigLayer,
} from '@handstack/config';
import { DatabaseService } from '../database/database.service.js';
import { loadConfigFile } from '../database/config-file.js';
import type { Branding, OrganizationSettings } from '@handstack/identity';

const DEFAULT_BRANDING: Branding = {
  displayName: 'HandStack',
  productName: 'HandStack',
  primaryColor: '#2563eb',
  secondaryColor: '#0f172a',
  accentColor: '#14b8a6',
  backgroundColor: '#f8fafc',
  legalLinks: [],
};
const SETTINGS_REPOSITORY = repositoryName('identity-organization-settings');

@Injectable()
export class SettingsRuntimeService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async get(organizationId: string): Promise<OrganizationSettings> {
    const page = await this.database.adapter
      .repository<OrganizationSettings>(SETTINGS_REPOSITORY)
      .list(organizationId, { limit: 1 });
    const existing = page.items[0];
    if (existing !== undefined) return existing;
    return {
      id: uuidV7(),
      tenantId: organizationId,
      organizationId,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      branding: DEFAULT_BRANDING,
      locale: 'en-US',
      timezone: 'UTC',
      theme: 'system',
    };
  }

  /** Resolves the effective tenant runtime configuration after the primary adapter is connected. */
  async resolveForOrganization(organizationId: string): Promise<HandStackConfig> {
    const settings = await this.get(organizationId);
    const organizationLayer = settings.configuration as HandStackConfigLayer | undefined;
    return resolveConfigLayers(
      configLayerFromEnvironment(process.env),
      loadConfigFile(),
      await this.database.getDatabaseSettings(),
      organizationLayer ?? {},
    );
  }

  async update(
    organizationId: string,
    input: Partial<Omit<OrganizationSettings, 'branding'>> & {
      readonly branding?: Partial<Branding>;
    },
  ): Promise<OrganizationSettings> {
    const repository = this.database.adapter.repository<OrganizationSettings>(SETTINGS_REPOSITORY);
    const page = await repository.list(organizationId, { limit: 1 });
    const current = page.items[0];
    const now = new Date();
    if (current === undefined) {
      return repository.insert({
        id: uuidV7(),
        tenantId: organizationId,
        organizationId,
        version: 1,
        createdAt: now,
        updatedAt: now,
        branding: { ...DEFAULT_BRANDING, ...(input.branding ?? {}) },
        locale: input.locale ?? 'en-US',
        timezone: input.timezone ?? 'UTC',
        theme: input.theme ?? 'system',
        ...(input.configuration === undefined ? {} : { configuration: input.configuration }),
      });
    }
    return repository.update(
      {
        ...current,
        version: current.version + 1,
        branding: { ...current.branding, ...(input.branding ?? {}) },
        ...(input.locale === undefined ? {} : { locale: input.locale }),
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
        ...(input.theme === undefined ? {} : { theme: input.theme }),
        ...(input.configuration === undefined ? {} : { configuration: input.configuration }),
        updatedAt: now,
      },
      current.version,
    );
  }
}
