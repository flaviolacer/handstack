import { AuthorizationError, ValidationError } from '@handstack/shared';
import { Body, Controller, Get, Inject, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import {
  requireAuthentication,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import { SettingsRuntimeService } from './settings-runtime.service.js';
import { IdentityAdministrationService } from '@handstack/identity-service';
import type { Branding } from '@handstack/identity';
import { z } from 'zod';

function bodyObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Request body must be an object');
  }
  return value as Record<string, unknown>;
}

const brandingSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    productName: z.string().trim().min(1).max(200),
    logo: z.string().max(2_000_000).optional(),
    favicon: z.string().max(2_000_000).optional(),
    primaryColor: z.string().regex(/^#[0-9a-f]{6}$/iu),
    secondaryColor: z.string().regex(/^#[0-9a-f]{6}$/iu),
    accentColor: z.string().regex(/^#[0-9a-f]{6}$/iu),
    backgroundColor: z.string().regex(/^#[0-9a-f]{6}$/iu),
    font: z.string().trim().max(200).optional(),
    loginBackground: z.string().max(2_000_000).optional(),
    customCss: z.string().max(100_000).optional(),
    customDomain: z.string().trim().max(253).optional(),
    welcomeMessage: z.string().max(5_000).optional(),
    legalLinks: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(100),
          url: z
            .url()
            .refine((value) => value.startsWith('https://'), 'Legal links must use HTTPS'),
        }),
      )
      .max(20)
      .optional(),
    supportUrl: z
      .url()
      .refine((value) => value.startsWith('https://'), 'Support URL must use HTTPS')
      .optional(),
  })
  .partial()
  .strict();
const themeSchema = z.enum(['light', 'dark', 'system', 'custom']);
const configurationSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => !Object.prototype.hasOwnProperty.call(value, 'database'),
    'Organization settings cannot select the primary database adapter',
  );

@Controller('api/v1/organizations/:organizationId/settings')
@UseGuards(AccessTokenGuard)
export class SettingsController {
  private readonly administration: IdentityAdministrationService;

  constructor(
    @Inject(SettingsRuntimeService) private readonly runtime: SettingsRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get()
  async get(@Param('organizationId') organizationId: string, @Req() request: AuthenticatedRequest) {
    await this.authorize(organizationId, request);
    return this.runtime.get(organizationId);
  }

  @Patch()
  async update(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = bodyObject(value);
    const branding =
      body.branding === undefined ? undefined : brandingSchema.safeParse(body.branding);
    if (branding !== undefined && !branding.success)
      throw new ValidationError(branding.error.issues[0]?.message ?? 'Invalid branding');
    const configuration =
      body.configuration === undefined
        ? undefined
        : configurationSchema.safeParse(body.configuration);
    if (configuration !== undefined && !configuration.success) {
      throw new ValidationError(
        configuration.error.issues[0]?.message ?? 'Invalid organization configuration',
      );
    }
    return this.runtime.update(organizationId, {
      ...(branding === undefined ? {} : { branding: branding.data as Partial<Branding> }),
      ...(typeof body.locale === 'string' ? { locale: body.locale } : {}),
      ...(typeof body.timezone === 'string' ? { timezone: body.timezone } : {}),
      ...(body.theme === undefined ? {} : { theme: themeSchema.parse(body.theme) }),
      ...(configuration === undefined ? {} : { configuration: configuration.data }),
    });
  }

  private async authorize(organizationId: string, request: AuthenticatedRequest): Promise<void> {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId) {
      throw new AuthorizationError('Cross-organization settings access is forbidden');
    }
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission: 'settings.manage',
    });
    if (!decision.allowed) throw new AuthorizationError('settings.manage permission is required');
  }
}
