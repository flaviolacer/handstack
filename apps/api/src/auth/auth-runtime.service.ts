import { AuthenticationService } from '@handstack/auth-service';
import { IdentityStorage } from '@handstack/identity-storage';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

const developmentAccessSecret = 'handstack-development-access-secret-change-me';
const developmentTokenPepper = 'handstack-development-token-pepper-change-me';

function authenticationSecret(name: string, developmentValue: string): string {
  const value = process.env[name];
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
        developmentAccessSecret,
      ),
      tokenPepper: authenticationSecret('HANDSTACK_TOKEN_PEPPER', developmentTokenPepper),
    });
  }
}
