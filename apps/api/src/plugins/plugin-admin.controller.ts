import { IdentityAdministrationService } from '@handstack/identity-service';
import type { PluginPermission, PluginMode, PluginType } from '@handstack/plugin-sdk';
import type { PluginSupplyChain } from '@handstack/plugins';
import { AuthorizationError, ValidationError } from '@handstack/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags, type SchemaObject } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import {
  requireAuthentication,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { PluginAdminRuntimeService } from './plugin-admin.runtime.js';

const pluginInstallRequestSchema = {
  type: 'object',
  required: ['manifest', 'checksum', 'source'],
  properties: {
    manifest: {
      type: 'object',
      required: ['name', 'version', 'handstack'],
      properties: {
        name: { type: 'string' },
        version: { type: 'string' },
        description: { type: 'string' },
        handstack: {
          type: 'object',
          required: ['apiVersion', 'capabilities'],
          properties: {
            apiVersion: { type: 'string' },
            capabilities: { type: 'array', items: { type: 'string' } },
            permissions: { type: 'array', items: { type: 'string' } },
            mode: { type: 'string', enum: ['trusted', 'isolated'] },
          },
        },
      },
    },
    checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    approvedPermissions: { type: 'array', items: { type: 'string' } },
    source: {
      type: 'object',
      required: ['kind', 'locator', 'checksum', 'supplyChain'],
      properties: {
        kind: { type: 'string', enum: ['LOCAL', 'NPM', 'GITHUB'] },
        locator: { type: 'string' },
        checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        supplyChain: {
          type: 'object',
          required: ['publisher', 'signature', 'sbomDigest', 'provenanceDigest'],
          properties: {
            publisher: { type: 'string' },
            signature: {
              type: 'string',
              description: 'Ed25519 base64url signature for external sources.',
            },
            sbomDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            provenanceDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          },
        },
        supplyChainDocuments: {
          type: 'object',
          required: ['sbom', 'provenance'],
          properties: {
            sbom: {
              type: 'string',
              maxLength: 2000000,
              description: 'Raw CycloneDX or SPDX JSON.',
            },
            provenance: {
              type: 'string',
              maxLength: 1000000,
              description: 'Raw in-toto SLSA provenance JSON.',
            },
          },
        },
      },
    },
  },
} satisfies SchemaObject;

function recordBody(value: unknown): {
  record: {
    manifest: {
      name: string;
      version: string;
      description?: string;
      handstack: {
        apiVersion: string;
        capabilities: string[];
        type?: PluginType;
        permissions?: PluginPermission[];
        mode?: PluginMode;
      };
    };
    checksum: string;
    mode: PluginMode;
    status: 'INSTALLED';
    approvedPermissions: PluginPermission[];
  };
  source: {
    kind: 'NPM' | 'GITHUB' | 'LOCAL';
    locator: string;
    checksum: string;
    supplyChain: PluginSupplyChain;
    supplyChainDocuments?: { readonly sbom: string; readonly provenance: string };
  };
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ValidationError('Plugin installation body must be an object');
  const body = value as Record<string, unknown>;
  const manifest = body.manifest;
  const source = body.source;
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    Array.isArray(manifest) ||
    typeof source !== 'object' ||
    source === null ||
    Array.isArray(source)
  )
    throw new ValidationError('manifest and source are required');
  const m = manifest as Record<string, unknown>;
  const h = m.handstack;
  const s = source as Record<string, unknown>;
  if (
    typeof m.name !== 'string' ||
    typeof m.version !== 'string' ||
    (typeof m.description !== 'undefined' && typeof m.description !== 'string') ||
    typeof h !== 'object' ||
    h === null ||
    Array.isArray(h) ||
    typeof s.kind !== 'string' ||
    typeof s.locator !== 'string' ||
    typeof s.checksum !== 'string' ||
    typeof body.checksum !== 'string'
  )
    throw new ValidationError('Plugin manifest, source and checksum are invalid');
  const hs = h as Record<string, unknown>;
  const supplyChain = sourceSupplyChain(s);
  if (
    typeof hs.apiVersion !== 'string' ||
    !Array.isArray(hs.capabilities) ||
    !hs.capabilities.every((item) => typeof item === 'string')
  )
    throw new ValidationError('Plugin handstack metadata is invalid');
  const permissions = Array.isArray(hs.permissions)
    ? hs.permissions.filter((item): item is PluginPermission => typeof item === 'string')
    : [];
  const approvedPermissions = Array.isArray(body.approvedPermissions)
    ? body.approvedPermissions.filter((item): item is PluginPermission => typeof item === 'string')
    : [];
  if (approvedPermissions.some((permission) => !permissions.includes(permission)))
    throw new ValidationError('Approved permission was not requested');
  if (!['NPM', 'GITHUB', 'LOCAL'].includes(s.kind) || s.locator.trim() === '')
    throw new ValidationError('Plugin source is invalid');
  return {
    record: {
      manifest: {
        name: m.name,
        version: m.version,
        ...(typeof m.description === 'string' ? { description: m.description } : {}),
        handstack: {
          apiVersion: hs.apiVersion,
          capabilities: hs.capabilities,
          ...(Array.isArray(hs.permissions) ? { permissions } : {}),
        },
      },
      checksum: body.checksum,
      mode: hs.mode === 'trusted' ? 'trusted' : 'isolated',
      status: 'INSTALLED',
      approvedPermissions,
    },
    source: {
      kind: s.kind as 'NPM' | 'GITHUB' | 'LOCAL',
      locator: s.locator,
      checksum: s.checksum,
      supplyChain,
      ...(typeof s.supplyChainDocuments === 'object' &&
      s.supplyChainDocuments !== null &&
      !Array.isArray(s.supplyChainDocuments)
        ? {
            supplyChainDocuments: parseSupplyChainDocuments(
              s.supplyChainDocuments as Record<string, unknown>,
            ),
          }
        : {}),
    },
  };
}

function sourceSupplyChain(source: Record<string, unknown>): PluginSupplyChain {
  const value = source.supplyChain;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ValidationError('Plugin supply-chain metadata is required');
  const metadata = value as Record<string, unknown>;
  if (
    typeof metadata.publisher !== 'string' ||
    typeof metadata.signature !== 'string' ||
    typeof metadata.sbomDigest !== 'string' ||
    typeof metadata.provenanceDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(metadata.sbomDigest) ||
    !/^[a-f0-9]{64}$/u.test(metadata.provenanceDigest) ||
    metadata.publisher.trim() === '' ||
    metadata.signature.trim() === ''
  )
    throw new ValidationError('Plugin supply-chain metadata is invalid');
  return {
    publisher: metadata.publisher,
    signature: metadata.signature,
    sbomDigest: metadata.sbomDigest,
    provenanceDigest: metadata.provenanceDigest,
  };
}

function parseSupplyChainDocuments(value: Record<string, unknown>) {
  if (
    typeof value.sbom !== 'string' ||
    value.sbom.length === 0 ||
    value.sbom.length > 2_000_000 ||
    typeof value.provenance !== 'string' ||
    value.provenance.length === 0 ||
    value.provenance.length > 1_000_000
  )
    throw new ValidationError('Plugin SBOM and provenance documents are required and size-limited');
  return { sbom: value.sbom, provenance: value.provenance };
}

@ApiTags('Plugin administration')
@ApiBearerAuth()
@Controller('api/v1/organizations/:organizationId/plugins')
@UseGuards(AccessTokenGuard)
export class PluginAdminController {
  private readonly administration: IdentityAdministrationService;
  constructor(
    @Inject(PluginAdminRuntimeService) private readonly runtime: PluginAdminRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }
  @Get()
  @ApiOperation({ summary: 'List installed tenant plugins' })
  async list(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.runtime.list(organizationId) };
  }
  @Post()
  @ApiOperation({ summary: 'Install a tenant plugin with approved permissions' })
  @ApiBody({ schema: pluginInstallRequestSchema })
  async install(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = recordBody(value);
    return this.runtime.install(organizationId, body.record, body.source);
  }
  @Patch(':pluginName/disable')
  @ApiOperation({ summary: 'Disable an installed tenant plugin' })
  async disable(
    @Param('organizationId') organizationId: string,
    @Param('pluginName') pluginName: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.runtime.disable(organizationId, pluginName);
  }
  @Patch(':pluginName/enable')
  @ApiOperation({ summary: 'Enable an installed tenant plugin' })
  async enable(
    @Param('organizationId') organizationId: string,
    @Param('pluginName') pluginName: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.runtime.enable(organizationId, pluginName);
  }
  @Patch(':pluginName/quarantine')
  @ApiOperation({ summary: 'Quarantine and disable an installed plugin version' })
  async quarantine(
    @Param('organizationId') organizationId: string,
    @Param('pluginName') pluginName: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new ValidationError('Quarantine body must be an object');
    const body = value as Record<string, unknown>;
    if (typeof body.version !== 'string' || typeof body.reason !== 'string')
      throw new ValidationError('Quarantine version and reason are required');
    const authentication = requireAuthentication(request);
    return this.runtime.quarantine(
      organizationId,
      pluginName,
      body.version,
      authentication.subject,
      body.reason,
    );
  }
  @Patch(':pluginName/upgrade')
  @ApiOperation({ summary: 'Upgrade a tenant plugin from a verified local artifact' })
  @ApiBody({ schema: pluginInstallRequestSchema })
  async upgrade(
    @Param('organizationId') organizationId: string,
    @Param('pluginName') pluginName: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = recordBody(value);
    return this.runtime.upgrade(organizationId, pluginName, body.record, body.source);
  }
  @Delete(':pluginName')
  @ApiOperation({ summary: 'Uninstall an installed tenant plugin' })
  async uninstall(
    @Param('organizationId') organizationId: string,
    @Param('pluginName') pluginName: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    await this.runtime.uninstall(organizationId, pluginName);
    return { deleted: true };
  }
  private async authorize(organizationId: string, request: AuthenticatedRequest) {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization plugin access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission: 'plugins.manage',
    });
    if (!decision.allowed) throw new AuthorizationError('plugins.manage permission is required');
  }
}
