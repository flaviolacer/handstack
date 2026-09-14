import { frontendRefreshCookie, type LoginResult } from '@handstack/auth';
import { AuthenticationError, AuthorizationError, ValidationError } from '@handstack/shared';
import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AccessTokenGuard } from './access-token.guard.js';
import { requireAuthentication, type AuthenticatedRequest } from './authentication-context.js';
import { AuthRuntimeService } from './auth-runtime.service.js';

const refreshCookieName = 'handstack_refresh';
const csrfHeaderName = 'x-handstack-csrf';

interface LoginBody {
  readonly organizationId: string;
  readonly username: string;
  readonly password: string;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${key} must be a non-empty string`);
  }
  return value;
}

function loginBody(value: unknown): LoginBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Request body must be an object');
  }
  const record = value as Record<string, unknown>;
  return {
    organizationId: requiredString(record, 'organizationId'),
    username: requiredString(record, 'username'),
    password: requiredString(record, 'password'),
  };
}

function requireCsrf(request: FastifyRequest): void {
  if (request.headers[csrfHeaderName] !== '1') {
    throw new AuthorizationError('CSRF header is required');
  }
}

function publicLoginResult(result: LoginResult) {
  return {
    accessToken: result.accessToken,
    accessTokenExpiresAt: result.accessTokenExpiresAt,
    refreshTokenExpiresAt: result.refreshTokenExpiresAt,
  };
}

function setRefreshCookie(reply: FastifyReply, result: LoginResult): void {
  reply.header('cache-control', 'no-store');
  reply.setCookie(refreshCookieName, result.refreshToken, {
    ...frontendRefreshCookie,
    expires: result.refreshTokenExpiresAt,
  });
}

function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(refreshCookieName, frontendRefreshCookie);
}

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthRuntimeService) private readonly runtime: AuthRuntimeService) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ReturnType<typeof publicLoginResult>> {
    const input = loginBody(body);
    const result = await this.runtime.authentication.login(
      input.organizationId,
      input.username,
      input.password,
    );
    setRefreshCookie(reply, result);
    return publicLoginResult(result);
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ReturnType<typeof publicLoginResult>> {
    requireCsrf(request);
    const token = request.cookies[refreshCookieName];
    if (token === undefined) throw new AuthenticationError('Refresh cookie is required');
    clearRefreshCookie(reply);
    const result = await this.runtime.authentication.refresh(token);
    setRefreshCookie(reply, result);
    return publicLoginResult(result);
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ readonly revoked: true }> {
    const authentication = requireAuthentication(request);
    await this.runtime.authentication.revoke(
      authentication.organizationId,
      authentication.sessionId,
    );
    clearRefreshCookie(reply);
    return { revoked: true };
  }

  @Get('session')
  @UseGuards(AccessTokenGuard)
  session(@Req() request: AuthenticatedRequest) {
    return requireAuthentication(request);
  }
}
