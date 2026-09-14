import { AuthenticationError } from '@handstack/shared';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from './authentication-context.js';
import { AuthRuntimeService } from './auth-runtime.service.js';

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(@Inject(AuthRuntimeService) private readonly runtime: AuthRuntimeService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ') !== true) {
      throw new AuthenticationError('Bearer access token is required');
    }
    const token = authorization.slice('Bearer '.length).trim();
    if (token.length === 0) throw new AuthenticationError('Bearer access token is required');
    request.authentication = await this.runtime.authentication.verifyAccessToken(token);
    return true;
  }
}
