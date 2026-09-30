import { afterAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApplication } from '../src/main.js';
import { DatabaseService } from '../src/database/database.service.js';
import { SettingsRuntimeService } from '../src/settings/settings-runtime.service.js';

const mongodbUrl = process.env.HANDSTACK_TEST_MONGODB_URL?.trim();

describe.skipIf(mongodbUrl === undefined || mongodbUrl === '')('API MongoDB-only startup', () => {
  let app: NestFastifyApplication | undefined;

  afterAll(async () => {
    if (app !== undefined) await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
  });

  it('starts without SQL, reports MongoDB replication and persists organization settings', async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'mongodb';
    process.env.HANDSTACK_DATABASE_URL = mongodbUrl;
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET =
      'mongodb-startup-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'mongodb-startup-token-pepper-at-least-32-characters';
    app = await createApplication();
    await app.init();

    const database = app.get(DatabaseService);
    expect(database.config.database.adapter).toBe('mongodb');
    expect(database.config.database.url).toBe(mongodbUrl);
    expect(database.status()).toBe('up');
    expect(await database.replicationHealth()).toBe('up');
    expect((await database.health()).healthy).toBe(true);

    const settings = app.get(SettingsRuntimeService);
    const organizationId = `mongodb-startup-${String(Date.now())}`;
    const saved = await settings.update(organizationId, {
      locale: 'pt-BR',
      configuration: { telemetry: { enabled: false } },
    });
    const loaded = await settings.get(organizationId);
    expect(saved.locale).toBe('pt-BR');
    expect(loaded.locale).toBe('pt-BR');
    expect((await settings.resolveForOrganization(organizationId)).database.adapter).toBe(
      'mongodb',
    );
  }, 30_000);
});
