import { IdentityAdministrationService } from '@handstack/identity-service';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { ChatRuntimeService } from '../src/chat/chat-runtime.service.js';
import { createApplication } from '../src/main.js';

const organizationId = 'chat-http-organization';
const password = 'chat http password long enough';
const attachmentStoragePath = '.handstack-data/test-chat-http-attachments';

function multipart(filename: string, mimeType: string, content: string) {
  const boundary = 'handstack-test-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n${content}\r\n--${boundary}--\r\n`,
    ),
  };
}

describe('chat HTTP contract', () => {
  let app: NestFastifyApplication;
  let runtime: ChatRuntimeService;
  let token: string;
  let readerToken: string;

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET = 'chat-http-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'chat-http-token-pepper-at-least-32-characters';
    process.env.HANDSTACK_ATTACHMENT_STORAGE_PATH = attachmentStoragePath;
    process.env.HANDSTACK_ATTACHMENT_SIGNING_SECRET =
      'chat-http-attachment-secret-at-least-32-characters';
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const auth = app.get(AuthRuntimeService);
    runtime = app.get(ChatRuntimeService);
    const administration = new IdentityAdministrationService(auth.storage);
    await administration.createUser(organizationId, {
      id: 'chat-user',
      username: 'chat.user',
      displayName: 'Chat User',
    });
    await administration.createUser(organizationId, {
      id: 'chat-reader',
      username: 'chat.reader',
      displayName: 'Chat Reader',
    });
    const role = await administration.createRole(organizationId, { name: 'Chat user' });
    const permission = await administration.createPermission(organizationId, 'chat.use');
    await administration.grantPermission(organizationId, role.id, permission.id);
    await administration.assignRole(organizationId, 'chat-user', role.id);
    await auth.authentication.setPassword(organizationId, 'chat-user', password);
    await auth.authentication.setPassword(organizationId, 'chat-reader', password);
    token = (await auth.authentication.login(organizationId, 'chat.user', password)).accessToken;
    readerToken = (await auth.authentication.login(organizationId, 'chat.reader', password))
      .accessToken;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
    delete process.env.HANDSTACK_ATTACHMENT_STORAGE_PATH;
    delete process.env.HANDSTACK_ATTACHMENT_SIGNING_SECRET;
    await rm(attachmentStoragePath, { recursive: true, force: true });
  });

  it('publishes versioned OpenAPI for conversations, execution, cancellation and events', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(response.statusCode).toBe(200);
    const paths = response.json<{ paths: Record<string, unknown> }>().paths;
    expect(paths).toHaveProperty('/api/v1/organizations/{organizationId}/conversations');
    expect(paths).toHaveProperty(
      '/api/v1/organizations/{organizationId}/conversations/{conversationId}/branches/{branchId}/messages',
    );
    expect(paths).toHaveProperty(
      '/api/v1/organizations/{organizationId}/conversations/{conversationId}/branches/{branchId}/executions',
    );
    expect(paths).toHaveProperty(
      '/api/v1/organizations/{organizationId}/messages/{messageId}/cancel',
    );
    expect(paths).toHaveProperty(
      '/api/v1/organizations/{organizationId}/messages/{messageId}/events',
    );
    expect(paths).toHaveProperty(
      '/api/v1/organizations/{organizationId}/conversations/{conversationId}/attachments',
    );
    expect(paths).toHaveProperty('/api/v1/organizations/{organizationId}/chat/models');
  });

  it('requires authentication, chat.use and exact organization scope', async () => {
    const url = `/api/v1/organizations/${organizationId}/conversations`;
    await expect(app.inject({ method: 'GET', url })).resolves.toMatchObject({ statusCode: 401 });
    await expect(
      app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${readerToken}` } }),
    ).resolves.toMatchObject({ statusCode: 403 });
    await expect(
      app.inject({
        method: 'GET',
        url: '/api/v1/organizations/other/conversations',
        headers: { authorization: `Bearer ${token}` },
      }),
    ).resolves.toMatchObject({ statusCode: 403 });
  });

  it('exposes the secret-free model catalog with chat.use', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/chat/models`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [] });
  });

  it('creates, lists and reads ordered messages, then replays committed SSE events', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/conversations`,
      headers,
      payload: { title: 'HTTP chat' },
    });
    expect(created.statusCode).toBe(201);
    const conversation = created.json<{ id: string; activeBranchId: string }>();
    const messageResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/conversations/${conversation.id}/branches/${conversation.activeBranchId}/messages`,
      headers,
      payload: {
        role: 'user',
        parts: [{ id: 'question', type: 'text', text: 'Hello' }],
      },
    });
    expect(messageResponse.statusCode).toBe(201);
    const user = messageResponse.json<{ id: string }>();
    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/conversations/${conversation.id}/branches/${conversation.activeBranchId}/messages`,
      headers,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json<{ items: unknown[] }>().items).toHaveLength(1);
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/conversations`,
      headers,
    });
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(1);

    const assistant = await runtime.chat.startStream({
      organizationId,
      conversationId: conversation.id,
      branchId: conversation.activeBranchId,
      createdBy: 'chat-user',
      parentMessageId: user.id,
      modelDefinitionId: 'model',
      providerId: 'provider',
      idempotencyKey: 'http-start',
    });
    await runtime.chat.appendStreamEvent({
      organizationId,
      messageId: assistant.id,
      type: 'DELTA',
      idempotencyKey: 'http-delta',
      part: { id: 'answer', type: 'text', text: 'Hi' },
    });
    await runtime.chat.appendStreamEvent({
      organizationId,
      messageId: assistant.id,
      type: 'COMPLETED',
      idempotencyKey: 'http-completed',
      finishReason: 'stop',
    });
    const events = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/messages/${assistant.id}/events`,
      headers: { ...headers, 'last-event-id': '1' },
    });
    expect(events.statusCode).toBe(200);
    expect(events.headers['content-type']).toContain('text/event-stream');
    expect(events.body).toContain('id: 2');
    expect(events.body).not.toContain('id: 1\n');
    expect(events.body).toContain('event: completed');
  });

  it('validates payloads and requires idempotency keys before execution/cancellation', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/conversations`,
      headers,
      payload: { title: '' },
    });
    expect(invalid.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/conversations/missing/branches/missing/executions`,
      headers,
      payload: { model: 'smart', dataClassification: 'PUBLIC' },
    });
    expect(missing.statusCode).toBe(400);
  });

  it('archives, restores and deletes only owner-scoped conversations', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const conversation = await runtime.chat.createConversation({
      organizationId,
      title: 'Lifecycle HTTP',
      createdBy: 'chat-user',
    });
    const archiveUrl = `/api/v1/organizations/${organizationId}/conversations/${conversation.id}/archive`;
    const archived = await app.inject({ method: 'PATCH', url: archiveUrl, headers });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ status: 'ARCHIVED' });
    const restored = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${organizationId}/conversations/${conversation.id}/restore`,
      headers,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ status: 'ACTIVE' });
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/conversations/${conversation.id}`,
      headers,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ status: 'DELETED', title: 'Deleted conversation' });
    expect(JSON.stringify(await runtime.chat.listAuditEvents(organizationId))).not.toContain(
      'Lifecycle HTTP',
    );
  });

  it('follows new committed events until the stream reaches a terminal state', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const conversation = await runtime.chat.createConversation({
      organizationId,
      title: 'Live SSE',
      createdBy: 'chat-user',
    });
    const message = await runtime.chat.startStream({
      organizationId,
      conversationId: conversation.id,
      branchId: conversation.activeBranchId,
      createdBy: 'chat-user',
      modelDefinitionId: 'model',
      providerId: 'provider',
      idempotencyKey: 'live-start',
    });
    const responsePromise = app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/messages/${message.id}/events`,
      headers,
    });
    await delay(30);
    await runtime.chat.appendStreamEvent({
      organizationId,
      messageId: message.id,
      type: 'DELTA',
      idempotencyKey: 'live-delta',
      part: { id: 'live-answer', type: 'text', text: 'arrived live' },
    });
    await runtime.chat.appendStreamEvent({
      organizationId,
      messageId: message.id,
      type: 'COMPLETED',
      idempotencyKey: 'live-complete',
      finishReason: 'stop',
    });
    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('arrived live');
    expect(response.body).toContain('event: completed');
  });

  it('uploads, signs and deletes an attachment while enforcing scan and conversation scope', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const conversation = await runtime.chat.createConversation({
      organizationId,
      title: 'Attachment HTTP',
      createdBy: 'chat-user',
    });
    const other = await runtime.chat.createConversation({
      organizationId,
      title: 'Other conversation',
      createdBy: 'chat-user',
    });
    const clean = multipart('note.txt', 'text/plain', 'safe attachment');
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/conversations/${conversation.id}/attachments?dataClassification=CONFIDENTIAL`,
      headers: { ...headers, ...clean.headers },
      payload: clean.payload,
    });
    expect(uploaded.statusCode).toBe(201);
    const attachment = uploaded.json<{
      id: string;
      status: string;
      dataClassification: string;
      storageKey: string;
    }>();
    expect(attachment).toMatchObject({ status: 'READY', dataClassification: 'CONFIDENTIAL' });
    expect(attachment.storageKey).not.toContain('note.txt');

    const wrongConversation = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/conversations/${other.id}/attachments/${attachment.id}/url`,
      headers,
    });
    expect(wrongConversation.statusCode).toBe(403);

    const signed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/conversations/${conversation.id}/attachments/${attachment.id}/url?expiresInSeconds=60`,
      headers,
    });
    expect(signed.statusCode).toBe(200);
    const url = signed.json<{ url: string }>().url;
    const download = await app.inject({ method: 'GET', url });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe('safe attachment');
    await expect(app.inject({ method: 'GET', url: `${url}x` })).resolves.toMatchObject({
      statusCode: 403,
    });

    const infected = multipart(
      'eicar.txt',
      'text/plain',
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    await expect(
      app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organizationId}/conversations/${conversation.id}/attachments`,
        headers: { ...headers, ...infected.headers },
        payload: infected.payload,
      }),
    ).resolves.toMatchObject({ statusCode: 400 });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/conversations/${conversation.id}/attachments/${attachment.id}`,
      headers,
    });
    expect(deleted.statusCode).toBe(204);
    await expect(app.inject({ method: 'GET', url })).resolves.toMatchObject({ statusCode: 403 });
  });
});
