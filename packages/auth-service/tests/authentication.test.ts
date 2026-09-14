import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import {
  IdentityAdministrationService,
  IdentityProviderAdministrationService,
} from '@handstack/identity-service';
import { IdentityStorage } from '@handstack/identity-storage';
import { AuthenticationService } from '../src/index.js';
import { describe, expect, it } from 'vitest';

const accessTokenSecret = 'access-token-secret-that-is-at-least-32-bytes';
const tokenPepper = 'token-pepper-that-is-at-least-thirty-two-bytes';

describe('local authentication', () => {
  it('hashes passwords with Argon2id and rotates refresh tokens with reuse detection', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const storage = new IdentityStorage(adapter);
      const admin = new IdentityAdministrationService(storage);
      const user = await admin.createUser('organization-a', {
        id: 'user-a',
        username: 'ana.silva',
        displayName: 'Ana Silva',
      });
      const auth = new AuthenticationService(storage, { accessTokenSecret, tokenPepper });
      await auth.setPassword('organization-a', user.id, 'correct horse battery staple');
      const credential = await storage
        .forOrganization('organization-a')
        .credentials.findById(user.id);
      expect(credential?.passwordHash).toMatch(/^\$argon2id\$/);
      expect(credential?.passwordHash).not.toContain('correct horse');

      await expect(auth.login('organization-a', 'ana.silva', 'wrong password')).rejects.toThrow(
        'Invalid credentials',
      );
      const login = await auth.login('organization-a', 'ANA.SILVA', 'correct horse battery staple');
      await expect(auth.verifyAccessToken(login.accessToken)).resolves.toMatchObject({
        subject: user.id,
        organizationId: 'organization-a',
      });

      const refreshed = await auth.refresh(login.refreshToken);
      expect(refreshed.refreshToken).not.toBe(login.refreshToken);
      await expect(auth.refresh(login.refreshToken)).rejects.toThrow('reuse detected');
      await expect(auth.refresh(refreshed.refreshToken)).rejects.toThrow('Invalid session');
      await expect(auth.verifyAccessToken(refreshed.accessToken)).rejects.toThrow(
        'Session is not active',
      );

      const activeLogin = await auth.login(
        'organization-a',
        'ana.silva',
        'correct horse battery staple',
      );
      const storedUser = await storage.forOrganization('organization-a').users.findById(user.id);
      if (storedUser === undefined) throw new Error('Test user disappeared');
      await storage.forOrganization('organization-a').users.update(
        {
          ...storedUser,
          version: storedUser.version + 1,
          updatedAt: new Date(),
          status: 'DISABLED',
        },
        storedUser.version,
      );
      await expect(auth.verifyAccessToken(activeLogin.accessToken)).rejects.toThrow(
        'Session is not active',
      );
    } finally {
      await adapter.close();
    }
  });

  it('stores only a hash of API keys and returns the secret once', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const storage = new IdentityStorage(adapter);
      const user = await new IdentityAdministrationService(storage).createUser('organization-a', {
        id: 'user-a',
        username: 'ana.silva',
        displayName: 'Ana Silva',
      });
      const auth = new AuthenticationService(storage, { accessTokenSecret, tokenPepper });
      const federated = await auth.createFederatedSession('organization-a', user.id);
      await expect(auth.verifyAccessToken(federated.accessToken)).resolves.toMatchObject({
        subject: user.id,
        organizationId: 'organization-a',
      });
      const issued = await auth.issueApiKey('organization-a', user.id, 'Automation');
      expect(issued.secret).toMatch(/^hsk\./);
      expect(issued.apiKey.secretHash).not.toContain(issued.secret);
      await expect(auth.authenticateApiKey(issued.secret)).resolves.toMatchObject({
        id: issued.apiKey.id,
        principalId: user.id,
      });
      await expect(auth.authenticateApiKey(`${issued.secret}tampered`)).rejects.toThrow(
        'Invalid API key',
      );
      await auth.revokeApiKey('organization-a', issued.apiKey.id);
      await expect(auth.authenticateApiKey(issued.secret)).rejects.toThrow('Invalid API key');
    } finally {
      await adapter.close();
    }
  });

  it('enforces SSO policy and permits only limited explicit break-glass accounts', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const storage = new IdentityStorage(adapter);
      const administration = new IdentityAdministrationService(storage);
      const first = await administration.createUser('organization-a', {
        id: 'break-glass-a',
        username: 'emergency.admin',
        displayName: 'Emergency Admin',
      });
      const second = await administration.createUser('organization-a', {
        id: 'break-glass-b',
        username: 'backup.admin',
        displayName: 'Backup Admin',
      });
      const auth = new AuthenticationService(storage, { accessTokenSecret, tokenPepper });
      await auth.setPassword('organization-a', first.id, 'initial local password value');
      await new IdentityProviderAdministrationService(storage).setLoginPolicy('organization-a', {
        mode: 'SSO_REQUIRED',
        breakGlassEnabled: true,
        maxBreakGlassAccounts: 1,
      });

      await expect(
        auth.login('organization-a', first.username, 'initial local password value'),
      ).rejects.toThrow('disabled by organization policy');
      const emergencyPassword = 'unique emergency password with 20+ chars';
      await auth.enableBreakGlass('organization-a', first.id, emergencyPassword);
      await expect(
        auth.login('organization-a', first.username, emergencyPassword),
      ).resolves.toHaveProperty('accessToken');
      await expect(
        auth.enableBreakGlass(
          'organization-a',
          second.id,
          'another emergency password with 20+ chars',
        ),
      ).rejects.toThrow('limit reached');

      const events = (
        await storage.forOrganization('organization-a').auditEvents.list({ limit: 20 })
      ).items;
      const eventTypes = events.map((event) => event.eventType);
      expect(eventTypes).toContain('LOGIN_POLICY_UPDATED');
      expect(eventTypes).toContain('LOCAL_LOGIN_FAILED');
      expect(eventTypes).toContain('BREAK_GLASS_ENABLED');
      expect(eventTypes).toContain('BREAK_GLASS_LOGIN');
      expect(JSON.stringify(events)).not.toContain(emergencyPassword);
      await auth.disableBreakGlass('organization-a', first.id);
      await expect(auth.login('organization-a', first.username, emergencyPassword)).rejects.toThrow(
        'disabled by organization policy',
      );
    } finally {
      await adapter.close();
    }
  });

  it('deprovisions a user atomically and revokes every authentication path', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const storage = new IdentityStorage(adapter);
      const administration = new IdentityAdministrationService(storage);
      const user = await administration.createUser('organization-a', {
        id: 'departing-user',
        username: 'departing.user',
        displayName: 'Departing User',
      });
      await administration.createUser('organization-b', {
        id: 'departing-user',
        username: 'still.active',
        displayName: 'Still Active',
      });
      const auth = new AuthenticationService(storage, { accessTokenSecret, tokenPepper });
      await auth.setPassword('organization-a', user.id, 'departing user password value');
      const first = await auth.login(
        'organization-a',
        user.username,
        'departing user password value',
      );
      const second = await auth.login(
        'organization-a',
        user.username,
        'departing user password value',
      );
      const apiKey = await auth.issueApiKey('organization-a', user.id, 'departing automation');

      await expect(administration.deprovisionUser('organization-a', user.id)).resolves.toEqual({
        sessionsRevoked: 2,
        apiKeysRevoked: 1,
      });
      await expect(auth.verifyAccessToken(first.accessToken)).rejects.toThrow(
        'Session is not active',
      );
      await expect(auth.refresh(second.refreshToken)).rejects.toThrow('Invalid session');
      await expect(auth.authenticateApiKey(apiKey.secret)).rejects.toThrow('Invalid API key');
      await expect(
        auth.login('organization-a', user.username, 'departing user password value'),
      ).rejects.toThrow('Invalid credentials');
      await expect(administration.deprovisionUser('organization-a', user.id)).resolves.toEqual({
        sessionsRevoked: 0,
        apiKeysRevoked: 0,
      });

      expect(
        await storage.forOrganization('organization-b').users.findById('departing-user'),
      ).toMatchObject({ status: 'ACTIVE' });
      const events = (
        await storage.forOrganization('organization-a').auditEvents.list({ limit: 100 })
      ).items.filter(({ eventType }) => eventType === 'USER_DEPROVISIONED');
      expect(events).toHaveLength(1);
      expect(events[0]?.details).toEqual({ sessionsRevoked: 2, apiKeysRevoked: 1 });
    } finally {
      await adapter.close();
    }
  });
});
