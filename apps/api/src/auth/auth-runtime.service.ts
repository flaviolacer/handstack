import { AuthenticationService } from '@handstack/auth-service';
import { IdentityStorage } from '@handstack/identity-storage';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

const developmentAccessSecret = 'handstack-development-access-secret-change-me';
const developmentTokenPepper = 'handstack-development-token-pepper-change-me';

function authenticationSecret(
  name: string,
  value: string | undefined,
  developmentValue: string,
): string {
  if (value !== undefined) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${name} is required in production`);
  }
  return developmentValue;
}

@Injectable()
export class AuthRuntimeService {
  readonly storage: IdentityStorage;
  readonly authentication: AuthenticationService;

  constructor(@Inject(DatabaseService) database: DatabaseService) {
    this.storage = new IdentityStorage(database.adapter);
    this.authentication = new AuthenticationService(this.storage, {
      accessTokenSecret: authenticationSecret(
        'HANDSTACK_ACCESS_TOKEN_SECRET',
        database.config.security.accessTokenSecret,
        developmentAccessSecret,
      ),
      tokenPepper: authenticationSecret(
        'HANDSTACK_TOKEN_PEPPER',
        database.config.security.tokenPepper,
        developmentTokenPepper,
      ),
    });
  }
}
