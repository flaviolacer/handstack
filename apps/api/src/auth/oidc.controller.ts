import { randomBytes } from 'node:crypto';
import { frontendRefreshCookie, type LoginResult } from '@handstack/auth';
import { ValidationError } from '@handstack/shared';
import { Controller, Get, HttpCode, Inject, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { OidcRuntimeService } from './oidc-runtime.service.js';

const refreshCookieName = 'handstack_refresh';

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new ValidationError(`${name} is required`);
  return value;
}

function setSession(reply: FastifyReply, result: LoginResult) {
  reply.header('cache-control', 'no-store');
  reply.setCookie(refreshCookieName, result.refreshToken, {
    ...frontendRefreshCookie,
    expires: result.refreshTokenExpiresAt,
  });
  return {
    accessToken: result.accessToken,
    accessTokenExpiresAt: result.accessTokenExpiresAt,
    refreshTokenExpiresAt: result.refreshTokenExpiresAt,
  };
}

@Controller('auth/oidc')
export class OidcController {
  constructor(@Inject(OidcRuntimeService) private readonly runtime: OidcRuntimeService) {}

  @Get(':organizationId/providers')
  async providers(@Param('organizationId') organizationId: string) {
    const policy = await this.runtime.providers.loginPolicy(organizationId);
    return (await this.runtime.providers.list(organizationId))
      .filter((provider) => provider.enabled)
      .filter(
        (provider) =>
          policy.mode !== 'SPECIFIC_IDP_REQUIRED' || provider.id === policy.requiredProviderId,
      )
      .map((provider) => ({
        name: provider.name,
        slug: provider.slug,
        type: provider.type,
        priority: provider.priority,
      }));
  }

  @Get(':organizationId/:providerSlug/start')
  async start(
    @Param('organizationId') organizationId: string,
    @Param('providerSlug') providerSlug: string,
    @Res() reply: FastifyReply,
  ): Promise<FastifyReply> {
    return await this.runtime.telemetry.measure('sso.start', async () => {
      const provider = await this.runtime.providers.findEnabled(organizationId, providerSlug);
      await this.runtime.audit.record(organizationId, {
        eventType: 'SSO_LOGIN_STARTED',
        providerId: provider.id,
        details: { providerSlug: provider.slug },
      });
      try {
        await this.runtime.providers.assertProviderAllowed(organizationId, provider.id);
        const authorizationUrl = await this.runtime.plugin(provider).getAuthorizationUrl({
          organizationId,
          redirectUri: provider.configuration.redirectUri,
          state: randomBytes(32).toString('base64url'),
          nonce: randomBytes(32).toString('base64url'),
        });
        return await reply.redirect(authorizationUrl, 302);
      } catch (error) {
        await this.runtime.audit.record(organizationId, {
          eventType: 'SSO_LOGIN_FAILED',
          outcome: 'FAILURE',
          providerId: provider.id,
          details: { phase: 'start', reason: error instanceof Error ? error.name : 'UnknownError' },
        });
        throw error;
      }
    });
  }

  @Get(':organizationId/:providerSlug/callback')
  @HttpCode(200)
  async callback(
    @Param('organizationId') organizationId: string,
    @Param('providerSlug') providerSlug: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return await this.runtime.telemetry.measure('sso.callback', async () => {
      const provider = await this.runtime.providers.findEnabled(organizationId, providerSlug);
      try {
        const callback = new URL(provider.configuration.redirectUri);
        callback.search = new URLSearchParams({
          code: required(code, 'code'),
          state: required(state, 'state'),
        }).toString();
        await this.runtime.providers.assertProviderAllowed(organizationId, provider.id);
        const authenticated = await this.runtime.plugin(provider).handleCallback({
          organizationId,
          callbackUri: callback.toString(),
          state: required(state, 'state'),
        });
        const session = await this.runtime.createSession(
          organizationId,
          authenticated.identity.principalId,
        );
        await this.runtime.audit.record(organizationId, {
          eventType: 'SSO_LOGIN_SUCCEEDED',
          principalId: authenticated.identity.principalId,
          providerId: provider.id,
          details: { providerSlug: provider.slug },
        });
        return setSession(reply, session);
      } catch (error) {
        await this.runtime.audit.record(organizationId, {
          eventType: 'SSO_LOGIN_FAILED',
          outcome: 'FAILURE',
          providerId: provider.id,
          details: { reason: error instanceof Error ? error.name : 'UnknownError' },
        });
        throw error;
      }
    });
  }
}
