import { IdentityAdministrationService } from '@handstack/identity-service';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { CapabilityRuntimeService } from '../src/capabilities/capability-runtime.service.js';
import { PolicyRuntimeService } from '../src/policy/policy-runtime.service.js';
import { PrivacyRuntimeService } from '../src/privacy/privacy-runtime.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { createApplication } from '../src/main.js';

describe('capability HTTP contract', () => {
  let app: NestFastifyApplication;
  let token: string;
  let consentToken: string;
  const organizationId = 'capability-http-organization';
  const password = 'capability administrator password long enough';

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET =
      'capability-http-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'capability-http-token-pepper-at-least-32-characters';
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const auth = app.get(AuthRuntimeService);
    const administration = new IdentityAdministrationService(auth.storage);
    await administration.createUser(organizationId, {
      id: 'capability-admin',
      username: 'capability.admin',
      displayName: 'Capability Admin',
    });
    await administration.createUser(organizationId, {
      id: 'capability-consent',
      username: 'capability.consent',
      displayName: 'Capability Consent Principal',
    });
    const role = await administration.createRole(organizationId, {
      name: 'Capability administrator',
    });
    const permission = await administration.createPermission(organizationId, 'capability.execute');
    await administration.grantPermission(organizationId, role.id, permission.id);
    await administration.assignRole(organizationId, 'capability-admin', role.id);
    await administration.assignRole(organizationId, 'capability-consent', role.id);
    await auth.authentication.setPassword(organizationId, 'capability-admin', password);
    await auth.authentication.setPassword(organizationId, 'capability-consent', password);
    token = (await auth.authentication.login(organizationId, 'capability.admin', password))
      .accessToken;
    consentToken = (await auth.authentication.login(organizationId, 'capability.consent', password))
      .accessToken;
    await app.get(CapabilityRuntimeService).registry.register({
      organizationId,
      slug: 'echo',
      name: 'Echo',
      description: 'Echo',
      type: 'CUSTOM',
      inputSchema: {},
      outputSchema: {},
      requiredPermissions: ['capability.execute'],
      allowedChannels: ['API'],
      timeoutMs: 1000,
      visibility: 'ORGANIZATION',
      ownerId: 'capability-admin',
      metadata: {},
      handler: (input) => Promise.resolve({ echoed: input }),
    });
    await app.get(PrivacyRuntimeService).setResidency(organizationId, 'br-south-1', 'RESTRICTED');
    await app.get(PrivacyRuntimeService).createPurpose({
      organizationId,
      name: 'External capability execution',
      description: 'Allows the test principal to send restricted data to the configured provider',
      lawfulBasis: 'consent',
    });
    const purpose = (await app.get(PrivacyRuntimeService).listPurposes(organizationId))[0];
    if (purpose === undefined) throw new Error('Expected persisted consent purpose');
    await app.get(PrivacyRuntimeService).createConsent({
      organizationId,
      subjectId: 'capability-consent',
      purposeId: purpose.id,
    });
    await app.get(CapabilityRuntimeService).registry.register({
      organizationId,
      slug: 'external-echo',
      name: 'External Echo',
      description: 'External Echo',
      type: 'CUSTOM',
      inputSchema: {},
      outputSchema: {},
      requiredPermissions: ['capability.execute'],
      allowedChannels: ['API'],
      timeoutMs: 1000,
      visibility: 'ORGANIZATION',
      ownerId: 'capability-admin',
      metadata: {
        externalProvider: 'true',
        providerId: 'external-test',
        dataClassification: 'RESTRICTED',
        destinationRegion: 'us-east-1',
      },
      handler: (input) => Promise.resolve({ echoed: input }),
    });
    await app.get(CapabilityRuntimeService).registry.register({
      organizationId,
      slug: 'consent-echo',
      name: 'Consent Echo',
      description: 'Consent-bound external echo',
      type: 'CUSTOM',
      inputSchema: {},
      outputSchema: {},
      requiredPermissions: ['capability.execute'],
      allowedChannels: ['API'],
      timeoutMs: 1000,
      visibility: 'ORGANIZATION',
      ownerId: 'capability-admin',
      metadata: {
        externalProvider: 'true',
        providerId: 'external-test',
        dataClassification: 'RESTRICTED',
        destinationRegion: 'br-south-1',
        consentPurposeId: purpose.id,
      },
      handler: (input) => Promise.resolve({ echoed: input }),
    });
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
  });

  it('lists and executes the same registered capability through the API authorization path', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/capabilities`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ items: { slug: string }[] }>().items.map((item) => item.slug)).toContain(
      'echo',
    );
    const executed = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/capabilities/echo/run`,
      headers,
      payload: { hello: 'world' },
    });
    expect(executed.statusCode).toBe(201);
    expect(executed.json()).toEqual({ echoed: { hello: 'world' } });
    const cross = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations/other/capabilities/echo/run',
      headers,
      payload: {},
    });
    expect(cross.statusCode).toBe(403);
  });

  it('enforces an explicit persisted capability deny policy', async () => {
    await app.get(PolicyRuntimeService).create(organizationId, {
      principalIds: ['capability-admin'],
      resource: 'capability',
      action: 'execute',
      effect: 'deny',
    });
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/capabilities/echo/run`,
      headers: { authorization: `Bearer ${token}` },
      payload: { hello: 'blocked' },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('blocks external capability destinations outside the persisted residency policy', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/capabilities/external-echo/run`,
      headers: { authorization: `Bearer ${token}` },
      payload: { hello: 'restricted' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ detail?: string }>().detail).toContain('Region us-east-1 is not allowed');
  });

  it('denies placement when no residency policy registers the classification', async () => {
    await expect(
      app
        .get(PrivacyRuntimeService)
        .authorizePlacement('org-without-residency-policy', 'RESTRICTED', 'br-south-1'),
    ).resolves.toEqual({
      allowed: false,
      reason: 'No residency policy registers this classification',
    });
  });

  it('enforces the latest consent for consent-bound capability execution', async () => {
    const headers = { authorization: `Bearer ${consentToken}` };
    const allowed = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/capabilities/consent-echo/run`,
      headers,
      payload: { hello: 'consented' },
    });
    expect(allowed.statusCode).toBe(201);

    const purposes = await app.get(PrivacyRuntimeService).listPurposes(organizationId);
    const purpose = purposes.find((item) => item.name === 'External capability execution');
    if (purpose === undefined) throw new Error('Expected consent purpose');
    const consents = await app.get(PrivacyRuntimeService).listConsents(organizationId);
    const consent = consents.find((item) => item.purposeId === purpose.id);
    if (consent === undefined) throw new Error('Expected consent record');
    await app.get(PrivacyRuntimeService).withdrawConsent(organizationId, consent.id);

    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/capabilities/consent-echo/run`,
      headers,
      payload: { hello: 'withdrawn' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ detail?: string }>().detail).toContain('Consent is not granted');
  });

  it('uses the effective platform tool timeout and cancels the capability handler', async () => {
    const database = app.get(DatabaseService);
    const originalConfig = database.config;
    database.config = {
      ...originalConfig,
      timeouts: { ...originalConfig.timeouts, tool: 10 },
    };
    let handlerSignal: AbortSignal | undefined;
    try {
      await app.get(CapabilityRuntimeService).registry.register({
        organizationId,
        slug: 'slow-tool',
        name: 'Slow tool',
        description: 'Waits until timeout cancellation',
        type: 'TOOL',
        inputSchema: {},
        outputSchema: {},
        requiredPermissions: ['capability.execute'],
        allowedChannels: ['API'],
        timeoutMs: 10_000,
        visibility: 'ORGANIZATION',
        ownerId: 'capability-admin',
        metadata: {},
        handler: (_input, context) =>
          new Promise((_resolve, reject) => {
            handlerSignal = context.signal;
            context.signal?.addEventListener(
              'abort',
              () => {
                reject(new Error('handler cancelled'));
              },
              { once: true },
            );
          }),
      });
      await expect(
        app.get(CapabilityRuntimeService).engine.execute(
          'slow-tool',
          {},
          {
            organizationId,
            principalId: 'timeout-principal',
            channel: 'API',
          },
        ),
      ).rejects.toThrow('Capability execution timed out');
      expect(handlerSignal?.aborted).toBe(true);
    } finally {
      database.config = originalConfig;
    }
  });
});
