import { IdentityAdministrationService } from '@handstack/identity-service';
import { rm } from 'node:fs/promises';
import { ChatService, type ChatAuditEvent } from '@handstack/chat';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { LocalAttachmentStorage } from '../src/chat/attachment-storage.js';
import { SettingsRuntimeService } from '../src/settings/settings-runtime.service.js';
import { PrivacyRuntimeService } from '../src/privacy/privacy-runtime.service.js';
import { repositoryName, type TenantEntity } from '@handstack/domain';
import { createApplication } from '../src/main.js';

const organizationId = 'settings-organization';
const password = 'settings admin password long enough';
const attachmentStoragePath = '.handstack-data/test-settings-attachments';

describe('organization settings HTTP contract', () => {
  let app: NestFastifyApplication;
  let token: string;

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET = 'settings-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'settings-token-pepper-at-least-32-characters';
    process.env.HANDSTACK_ATTACHMENT_STORAGE_PATH = attachmentStoragePath;
    await rm(attachmentStoragePath, { recursive: true, force: true });
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const auth = app.get(AuthRuntimeService);
    const administration = new IdentityAdministrationService(auth.storage);
    await administration.createUser(organizationId, {
      id: 'settings-admin-user',
      username: 'settings.admin',
      displayName: 'Settings Admin',
    });
    const role = await administration.createRole(organizationId, { name: 'Settings admin' });
    const permission = await administration.createPermission(organizationId, 'settings.manage');
    const privacyPermission = await administration.createPermission(
      organizationId,
      'privacy.manage',
    );
    await administration.grantPermission(organizationId, role.id, permission.id);
    await administration.grantPermission(organizationId, role.id, privacyPermission.id);
    await administration.assignRole(organizationId, 'settings-admin-user', role.id);
    await auth.authentication.setPassword(organizationId, 'settings-admin-user', password);
    token = (await auth.authentication.login(organizationId, 'settings.admin', password))
      .accessToken;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
    delete process.env.HANDSTACK_ATTACHMENT_STORAGE_PATH;
    await rm(attachmentStoragePath, { recursive: true, force: true });
  });

  it('persists tenant-scoped organization and branding settings', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const globalInitial = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings/database',
      headers,
    });
    expect(globalInitial.statusCode).toBe(200);
    expect(globalInitial.json()).toEqual({});

    const globalUpdated = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/settings/database',
      headers,
      payload: {
        server: { apiPort: 3020 },
        telemetry: { enabled: true },
        timeouts: { http: 12_345 },
        retention: { conversation: 365 },
      },
    });
    expect(globalUpdated.statusCode).toBe(200);
    expect(globalUpdated.json()).toMatchObject({
      server: { apiPort: 3020 },
      telemetry: { enabled: true },
      timeouts: { http: 12_345 },
      retention: { conversation: 365 },
    });

    const globalReloaded = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings/database',
      headers,
    });
    expect(globalReloaded.json()).toMatchObject({ server: { apiPort: 3020 } });
    expect(app.get(DatabaseService).config.server.apiPort).toBe(3020);
    await expect(
      app.get(SettingsRuntimeService).resolveForOrganization(organizationId),
    ).resolves.toMatchObject({
      server: { apiPort: 3020 },
      timeouts: { http: 12_345 },
      retention: { conversation: 365 },
    });
    await expect(
      app.get(PrivacyRuntimeService).runConversationRetention(organizationId, 'test-admin'),
    ).resolves.toMatchObject({ retentionDays: 365 });

    const globalPrimaryDatabaseChange = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/settings/database',
      headers,
      payload: { database: { adapter: 'mongodb', url: 'mongodb://example.test' } },
    });
    expect(globalPrimaryDatabaseChange.statusCode).toBe(400);

    const initial = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/settings`,
      headers,
    });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toMatchObject({
      theme: 'system',
      branding: { displayName: 'HandStack' },
    });

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${organizationId}/settings`,
      headers,
      payload: {
        locale: 'pt-BR',
        theme: 'dark',
        configuration: {
          server: { apiPort: 3010 },
          telemetry: { enabled: true },
          retention: { conversation: 30 },
        },
        branding: { displayName: 'Acme AI', primaryColor: '#112233' },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      locale: 'pt-BR',
      theme: 'dark',
      configuration: {
        server: { apiPort: 3010 },
        telemetry: { enabled: true },
        retention: { conversation: 30 },
      },
      branding: { displayName: 'Acme AI', primaryColor: '#112233' },
    });

    const reloaded = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/settings`,
      headers,
    });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json()).toMatchObject({
      configuration: { server: { apiPort: 3010 }, telemetry: { enabled: true } },
    });
    await expect(
      app.get(SettingsRuntimeService).resolveForOrganization(organizationId),
    ).resolves.toMatchObject({
      server: { apiPort: 3010 },
      telemetry: { enabled: true },
      timeouts: { http: 12_345 },
      retention: { conversation: 30 },
    });
    await expect(
      app.get(PrivacyRuntimeService).runConversationRetention(organizationId, 'test-admin'),
    ).resolves.toMatchObject({ retentionDays: 30 });

    const primaryDatabaseChange = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${organizationId}/settings`,
      headers,
      payload: {
        configuration: { database: { adapter: 'mongodb', url: 'mongodb://example.test' } },
      },
    });
    expect(primaryDatabaseChange.statusCode).toBe(400);

    const crossTenant = await app.inject({
      method: 'GET',
      url: '/api/v1/organizations/other/settings',
      headers,
    });
    expect(crossTenant.statusCode).toBe(403);
  });

  it('persists the complete white-label surface and rejects insecure legal links', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${organizationId}/settings`,
      headers,
      payload: {
        branding: {
          logo: 'data:image/svg+xml;base64,abc',
          favicon: 'data:image/x-icon;base64,abc',
          font: 'Inter',
          loginBackground: 'https://cdn.example.test/login.png',
          customCss: ':root { --hs-primary: #112233; }',
          customDomain: 'acme.example.test',
          welcomeMessage: 'Welcome',
          legalLinks: [{ label: 'Privacy', url: 'https://acme.example.test/privacy' }],
          supportUrl: 'https://acme.example.test/support',
        },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      branding: {
        font: 'Inter',
        customDomain: 'acme.example.test',
        legalLinks: [{ label: 'Privacy' }],
      },
    });

    const insecure = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${organizationId}/settings`,
      headers,
      payload: { branding: { supportUrl: 'http://insecure.example.test/support' } },
    });
    expect(insecure.statusCode).toBe(400);
  });

  it('manages persistent privacy governance and creates a sanitized subject export', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const retention = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/retention`,
      headers,
      payload: { resourceType: 'conversation-messages', retentionDays: 30 },
    });
    expect(retention.statusCode).toBe(201);
    const hold = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/legal-holds`,
      headers,
      payload: { resourceType: 'conversation-messages', reason: 'Legal review' },
    });
    expect(hold.statusCode).toBe(201);
    const inventory = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/inventory`,
      headers,
      payload: {
        resourceType: 'conversation-messages',
        resourceId: 'message-1',
        classification: 'CONFIDENTIAL',
        subjectIds: ['settings-admin-user'],
        region: 'br-south-1',
      },
    });
    expect(inventory.statusCode).toBe(201);
    const request = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/subject-requests`,
      headers,
      payload: { subjectId: 'settings-admin-user', type: 'EXPORT' },
    });
    expect(request.statusCode).toBe(201);
    const requestId = String(jsonRecord(request).id);
    const approved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${organizationId}/privacy/subject-requests/${requestId}`,
      headers,
      payload: { status: 'APPROVED' },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const executed = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/subject-requests/${requestId}/execute`,
      headers,
    });
    expect(executed.statusCode, executed.body).toBe(201);
    const executedBody = jsonRecord(executed);
    expect(executedBody.status).toBe('COMPLETED');
    expect(typeof executedBody.exportId).toBe('string');
    const exported = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/privacy/subject-requests/${requestId}/export`,
      headers,
    });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.json()).toMatchObject({ requestId, subjectId: 'settings-admin-user' });
    expect(
      (jsonRecord(exported).records as Record<string, unknown>[]).some(
        (item) => item.repository === 'data-inventory',
      ),
    ).toBe(true);
    const purpose = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/purposes`,
      headers,
      payload: { name: 'Support', description: 'Provide support', lawfulBasis: 'contract' },
    });
    expect(purpose.statusCode).toBe(201);
    const consent = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/consents`,
      headers,
      payload: { subjectId: 'settings-admin-user', purposeId: String(jsonRecord(purpose).id) },
    });
    expect(consent.statusCode).toBe(201);
    const withdrawn = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${organizationId}/privacy/consents/${String(jsonRecord(consent).id)}/withdraw`,
      headers,
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    const processor = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/processors`,
      headers,
      payload: { name: 'Support Vendor', purpose: 'Support', regions: ['br-south-1'] },
    });
    expect(processor.statusCode).toBe(201);
    const incident = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/incidents`,
      headers,
      payload: {
        title: 'Test incident',
        severity: 'LOW',
        affectedResources: ['conversation-messages:message-1'],
      },
    });
    expect(incident.statusCode).toBe(201);
    await app
      .get(DatabaseService)
      .adapter.repository(repositoryName('conversation-messages'))
      .insert({
        id: 'privacy-held-message',
        tenantId: organizationId,
        subjectId: 'privacy-subject',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as TenantEntity & { readonly subjectId: string });
    const deletion = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/subject-requests`,
      headers,
      payload: { subjectId: 'privacy-subject', type: 'DELETION' },
    });
    expect(deletion.statusCode).toBe(201);
    const deletionId = String(jsonRecord(deletion).id);
    const approvedDeletion = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${organizationId}/privacy/subject-requests/${deletionId}`,
      headers,
      payload: { status: 'APPROVED' },
    });
    expect(approvedDeletion.statusCode, approvedDeletion.body).toBe(200);
    const executedDeletion = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/subject-requests/${deletionId}/execute`,
      headers,
    });
    expect(executedDeletion.statusCode).toBe(201);
    expect(jsonRecord(executedDeletion).status).toBe('COMPLETED');
    expect(
      (jsonRecord(executedDeletion).evidence as string[]).some(
        (item) => item.startsWith('CACHE:') && item.includes('cache'),
      ),
    ).toBe(true);
    const deletionJobs = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/privacy/deletion-jobs`,
      headers,
    });
    expect(deletionJobs.statusCode, deletionJobs.body).toBe(200);
    const jobId = String(
      (jsonRecord(deletionJobs).items as Record<string, unknown>[]).find(
        (item) => item.requestId === deletionId,
      )?.id,
    );
    const deletionEvidence = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/privacy/deletion-jobs/${jobId}/evidence`,
      headers,
    });
    expect(deletionEvidence.statusCode, deletionEvidence.body).toBe(200);
    expect(
      (jsonRecord(deletionEvidence).items as Record<string, unknown>[]).some(
        (item) => item.action === 'RETAINED',
      ),
    ).toBe(true);
    const released = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${organizationId}/privacy/legal-holds/${String(jsonRecord(hold).id)}/release`,
      headers,
    });
    expect(released.statusCode, released.body).toBe(200);
  });

  it('executes conversation retention through the cascade path and honors legal holds', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const policy = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/retention`,
      headers,
      payload: { resourceType: 'conversations', retentionDays: 0 },
    });
    expect(policy.statusCode).toBe(201);
    const chatService = new ChatService(app.get(DatabaseService).adapter, undefined, {
      attachmentStorage: app.get(LocalAttachmentStorage),
    });
    const deletable = await chatService.createConversation({
      organizationId,
      title: 'Expired conversation',
      createdBy: 'settings-admin-user',
    });
    const held = await chatService.createConversation({
      organizationId,
      title: 'Held conversation',
      createdBy: 'settings-admin-user',
    });
    const heldMessageId = 'retention-held-message';
    await app
      .get(DatabaseService)
      .adapter.repository<TenantEntity & { conversationId: string }>(
        repositoryName('conversation-messages'),
      )
      .insert({
        id: heldMessageId,
        tenantId: organizationId,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        conversationId: held.id,
      });
    const hold = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/legal-holds`,
      headers,
      payload: {
        resourceType: 'conversation-messages',
        resourceId: heldMessageId,
        reason: 'Legal hold on a child message',
      },
    });
    expect(hold.statusCode).toBe(201);

    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/retention/run`,
      headers,
    });
    expect(run.statusCode, run.body).toBe(201);
    const runResult = run.json<{ runId: string }>();
    expect(runResult).toMatchObject({ retentionDays: 0, deleted: 1, retained: 1 });
    const evidence = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/privacy/deletion-jobs/${runResult.runId}/evidence`,
      headers,
    });
    expect(evidence.json<{ readonly items: readonly unknown[] }>().items).toHaveLength(2);
    const jobs = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/privacy/deletion-jobs`,
      headers,
    });
    expect(jobs.json<{ readonly items: readonly TenantEntity[] }>().items).toContainEqual(
      expect.objectContaining({
        id: runResult.runId,
        subjectId: 'settings-admin-user',
        status: 'COMPLETED',
        evidenceCount: 2,
      }),
    );
    const conversations = app
      .get(DatabaseService)
      .adapter.repository<TenantEntity & { status: string }>(repositoryName('conversations'));
    await expect(conversations.findById(organizationId, deletable.id)).resolves.toMatchObject({
      status: 'DELETED',
    });
    await expect(conversations.findById(organizationId, held.id)).resolves.toMatchObject({
      status: 'ACTIVE',
    });
    const audit = await app
      .get(DatabaseService)
      .adapter.repository<ChatAuditEvent>(repositoryName('chat-audit-events'))
      .list(organizationId, { limit: 50 });
    expect(
      audit.items.find(
        (event) =>
          event.conversationId === deletable.id && event.operation === 'CONVERSATION_DELETED',
      ),
    ).toMatchObject({ actorId: 'settings-admin-user', operation: 'CONVERSATION_DELETED' });
  });

  it('applies usage retention tenant-scoped with holds and deletion evidence', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const policy = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/retention`,
      headers,
      payload: { resourceType: 'usage-records', retentionDays: 1 },
    });
    expect(policy.statusCode).toBe(201);
    const repository = app
      .get(DatabaseService)
      .adapter.repository<TenantEntity & { organizationId: string; costUsd: number }>(
        repositoryName('usage-records'),
      );
    const now = new Date();
    const old = new Date(now.getTime() - 5 * 86_400_000);
    const records = [
      { id: 'usage-expired', tenantId: organizationId, organizationId, createdAt: old },
      { id: 'usage-held', tenantId: organizationId, organizationId, createdAt: old },
      {
        id: 'usage-other-tenant',
        tenantId: 'other-organization',
        organizationId: 'other-organization',
        createdAt: old,
      },
      { id: 'usage-recent', tenantId: organizationId, organizationId, createdAt: now },
    ] as const;
    for (const record of records)
      await repository.insert({
        ...record,
        version: 1,
        updatedAt: record.createdAt,
        costUsd: 1,
      });
    const hold = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/legal-holds`,
      headers,
      payload: {
        resourceType: 'usage-records',
        resourceId: 'usage-held',
        reason: 'Preserve usage for review',
      },
    });
    expect(hold.statusCode).toBe(201);

    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/retention/usage/run`,
      headers,
    });
    expect(run.statusCode, run.body).toBe(201);
    const result = run.json<{
      runId: string;
      retentionDays: number;
      scanned: number;
      deleted: number;
      retained: number;
    }>();
    expect(result).toMatchObject({ retentionDays: 1 });
    expect(result.scanned).toBeGreaterThanOrEqual(3);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(result.retained).toBeGreaterThanOrEqual(1);
    await expect(repository.findById(organizationId, 'usage-expired')).resolves.toBeUndefined();
    await expect(repository.findById(organizationId, 'usage-held')).resolves.toBeDefined();
    await expect(repository.findById(organizationId, 'usage-recent')).resolves.toBeDefined();
    await expect(
      repository.findById('other-organization', 'usage-other-tenant'),
    ).resolves.toBeDefined();
    const evidence = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/privacy/deletion-jobs/${result.runId}/evidence`,
      headers,
    });
    expect(evidence.json<{ readonly items: readonly Record<string, unknown>[] }>().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repository: 'usage-records',
          resourceId: 'usage-expired',
          action: 'DELETED',
        }),
        expect.objectContaining({
          repository: 'usage-records',
          resourceId: 'usage-held',
          action: 'RETAINED',
        }),
      ]),
    );
  });

  it('removes expired attachment blobs while preserving held metadata', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const policy = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/retention`,
      headers,
      payload: { resourceType: 'conversation-attachments', retentionDays: 1 },
    });
    expect(policy.statusCode).toBe(201);
    const storage = app.get(LocalAttachmentStorage);
    const repository = app
      .get(DatabaseService)
      .adapter.repository<
        TenantEntity & { organizationId: string; status: string; storageKey: string }
      >(repositoryName('conversation-attachments'));
    const old = new Date(Date.now() - 5 * 86_400_000);
    const records = [
      { id: 'attachment-expired', storageKey: 'retention/expired.txt', status: 'READY' },
      { id: 'attachment-held', storageKey: 'retention/held.txt', status: 'READY' },
      { id: 'attachment-recent', storageKey: 'retention/recent.txt', status: 'READY' },
    ] as const;
    for (const record of records) {
      await storage.put(record.storageKey, new TextEncoder().encode(record.id));
      await repository.insert({
        ...record,
        tenantId: organizationId,
        organizationId,
        version: 1,
        createdAt: record.id === 'attachment-recent' ? new Date() : old,
        updatedAt: old,
      });
    }
    const hold = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/legal-holds`,
      headers,
      payload: {
        resourceType: 'conversation-attachments',
        resourceId: 'attachment-held',
        reason: 'Preserve attachment for review',
      },
    });
    expect(hold.statusCode).toBe(201);
    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/retention/attachments/run`,
      headers,
    });
    expect(run.statusCode, run.body).toBe(201);
    const result = run.json<{ runId: string; deleted: number; retained: number }>();
    expect(result).toMatchObject({ retentionDays: 1, deleted: 1, retained: 1 });
    await expect(repository.findById(organizationId, 'attachment-expired')).resolves.toMatchObject({
      status: 'DELETED',
    });
    await expect(repository.findById(organizationId, 'attachment-held')).resolves.toMatchObject({
      status: 'READY',
    });
    const heldUrl = await storage.signedUrl('retention/held.txt', 60);
    const heldToken = heldUrl.split('token=')[1];
    if (heldToken === undefined) throw new Error('Expected held attachment token');
    await expect(storage.readSigned(heldToken)).resolves.toEqual(Buffer.from('attachment-held'));
    const expiredUrl = await storage.signedUrl('retention/expired.txt', 60);
    const expiredToken = expiredUrl.split('token=')[1];
    if (expiredToken === undefined) throw new Error('Expected expired attachment token');
    await expect(storage.readSigned(expiredToken)).rejects.toThrow();
  });

  it('removes expired trace correlation while preserving message content and holds', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const policy = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/retention`,
      headers,
      payload: { resourceType: 'traces', retentionDays: 1 },
    });
    expect(policy.statusCode).toBe(201);
    const repository = app
      .get(DatabaseService)
      .adapter.repository<
        TenantEntity & { organizationId: string; traceId?: string; content?: string }
      >(repositoryName('conversation-messages'));
    const old = new Date(Date.now() - 5 * 86_400_000);
    await repository.insert({
      id: 'trace-expired',
      tenantId: organizationId,
      organizationId,
      version: 1,
      createdAt: old,
      updatedAt: old,
      traceId: 'trace-to-remove',
      content: 'message content remains',
    });
    await repository.insert({
      id: 'trace-held',
      tenantId: organizationId,
      organizationId,
      version: 1,
      createdAt: old,
      updatedAt: old,
      traceId: 'trace-to-retain',
      content: 'held message content remains',
    });
    const hold = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/legal-holds`,
      headers,
      payload: {
        resourceType: 'traces',
        resourceId: 'trace-held',
        reason: 'Preserve trace correlation for review',
      },
    });
    expect(hold.statusCode).toBe(201);
    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/privacy/retention/traces/run`,
      headers,
    });
    expect(run.statusCode, run.body).toBe(201);
    expect(run.json()).toMatchObject({ retentionDays: 1, deleted: 1, retained: 1 });
    await expect(repository.findById(organizationId, 'trace-expired')).resolves.toMatchObject({
      content: 'message content remains',
    });
    await expect(repository.findById(organizationId, 'trace-expired')).resolves.not.toHaveProperty(
      'traceId',
    );
    await expect(repository.findById(organizationId, 'trace-held')).resolves.toMatchObject({
      traceId: 'trace-to-retain',
      content: 'held message content remains',
    });
  });
});

function jsonRecord(response: { json(): unknown }): Record<string, unknown> {
  const value = response.json();
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}
