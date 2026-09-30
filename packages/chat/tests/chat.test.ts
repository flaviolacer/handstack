import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/index.js';

const organizationId = 'chat-organization';

function attachmentOptions() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    options: {
      attachmentStorage: {
        put(key: string, content: Uint8Array) {
          objects.set(key, content);
          return Promise.resolve();
        },
        delete(key: string) {
          objects.delete(key);
          return Promise.resolve();
        },
        signedUrl(key: string, expiresInSeconds: number) {
          return Promise.resolve(
            `https://files.example/${key}?expires=${String(expiresInSeconds)}`,
          );
        },
      },
      malwareScanner: { scan: () => Promise.resolve('CLEAN' as const) },
    },
  };
}

describe('chat persistence', () => {
  it('redacts email, CPF and phone values before persistence and model execution', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const chat = new ChatService(adapter, () => new Date(), {
        redactPii: true,
        storePrompts: true,
        storeResponses: true,
      });
      const conversation = await chat.createConversation({
        organizationId,
        title: 'PII redaction',
        createdBy: 'privacy-owner',
      });
      const originalPrompt =
        'Email person@example.com, CPF 123.456.789-09, phone +55 11 91234-5678';
      const prompt = await chat.appendMessage({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        role: 'user',
        createdBy: 'privacy-owner',
        parts: [
          {
            id: 'pii-prompt',
            type: 'text',
            text: originalPrompt,
            uri: 'mailto:person@example.com',
            data: { contact: { email: 'person@example.com' } },
          },
        ],
      });
      expect(prompt.parts).toEqual([
        {
          id: 'pii-prompt',
          type: 'text',
          text: 'Email [REDACTED_EMAIL], CPF [REDACTED_CPF], phone [REDACTED_PHONE]',
          uri: 'mailto:[REDACTED_EMAIL]',
          data: { contact: { email: '[REDACTED_EMAIL]' } },
        },
      ]);
      const executionHistory = await chat.historyForExecution(
        organizationId,
        conversation.id,
        conversation.activeBranchId,
      );
      expect(executionHistory[0]?.parts[0]?.text).toBe(
        'Email [REDACTED_EMAIL], CPF [REDACTED_CPF], phone [REDACTED_PHONE]',
      );

      const response = await chat.startStream({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        createdBy: 'privacy-owner',
        modelDefinitionId: 'model-private',
        providerId: 'provider-private',
        idempotencyKey: 'pii-response-stream',
      });
      const delta = await chat.appendStreamEvent({
        organizationId,
        messageId: response.id,
        type: 'DELTA',
        idempotencyKey: 'pii-response-delta',
        part: { id: 'pii-response', type: 'text', text: 'Contact other@example.com' },
      });
      expect(delta.part?.text).toBe('Contact [REDACTED_EMAIL]');
    } finally {
      await adapter.close();
    }
  });

  it('omits prompt and response content when privacy storage is disabled', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const chat = new ChatService(adapter, () => new Date(), {
        storePrompts: false,
        storeResponses: false,
      });
      const conversation = await chat.createConversation({
        organizationId,
        title: 'Private prompt and response',
        createdBy: 'privacy-owner',
      });
      const prompt = await chat.appendMessage({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        role: 'user',
        createdBy: 'privacy-owner',
        parts: [{ id: 'prompt', type: 'text', text: 'private prompt text' }],
      });
      expect(prompt.parts).toEqual([{ id: 'prompt', type: 'text' }]);
      expect(
        (await chat.history(organizationId, conversation.id, conversation.activeBranchId))[0]
          ?.parts,
      ).toEqual([{ id: 'prompt', type: 'text' }]);
      expect(
        (
          await chat.historyForExecution(
            organizationId,
            conversation.id,
            conversation.activeBranchId,
          )
        )[0]?.parts,
      ).toEqual([{ id: 'prompt', type: 'text', text: 'private prompt text' }]);

      const response = await chat.startStream({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        createdBy: 'privacy-owner',
        modelDefinitionId: 'model-private',
        providerId: 'provider-private',
        idempotencyKey: 'privacy-response-stream',
      });
      const delta = await chat.appendStreamEvent({
        organizationId,
        messageId: response.id,
        type: 'DELTA',
        idempotencyKey: 'privacy-response-delta',
        part: { id: 'response', type: 'text', text: 'private response text' },
      });
      expect(delta.part).toEqual({ id: 'response', type: 'text' });
      const persisted = await chat.getMessage(organizationId, response.id);
      expect(persisted.parts).toContainEqual({ id: 'response', type: 'text' });
      expect(
        JSON.stringify(
          await chat.history(organizationId, conversation.id, conversation.activeBranchId),
        ),
      ).not.toContain('private prompt text');
      expect(JSON.stringify(persisted)).not.toContain('private response text');
    } finally {
      await adapter.close();
    }
  });

  it('omits tool-call and tool-result payloads when privacy storage is disabled', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const chat = new ChatService(adapter, () => new Date(), { storeToolPayloads: false });
      const conversation = await chat.createConversation({
        organizationId,
        title: 'Private tool payloads',
        createdBy: 'privacy-owner',
      });
      const message = await chat.startStream({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        createdBy: 'privacy-owner',
        modelDefinitionId: 'model-private',
        providerId: 'provider-private',
        idempotencyKey: 'privacy-tool-stream',
      });
      const payload = { arguments: { accountNumber: 'sensitive-value' } };
      const event = await chat.appendStreamEvent({
        organizationId,
        messageId: message.id,
        type: 'DELTA',
        idempotencyKey: 'privacy-tool-call',
        part: { id: 'call-1', type: 'tool_call', data: payload },
      });
      expect(event.part).toEqual({ id: 'call-1', type: 'tool_call' });
      expect(JSON.stringify(await chat.getMessage(organizationId, message.id))).not.toContain(
        'sensitive-value',
      );

      const stored = await chat.appendMessage({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        role: 'assistant',
        createdBy: 'privacy-owner',
        parts: [{ id: 'result-1', type: 'tool_result', text: 'sensitive-value', data: payload }],
      });
      expect(stored.parts).toEqual([{ id: 'result-1', type: 'tool_result' }]);
      expect(
        JSON.stringify(
          await chat.history(organizationId, conversation.id, conversation.activeBranchId),
        ),
      ).not.toContain('sensitive-value');
    } finally {
      await adapter.close();
    }
  });

  it('paginates visible conversations with an opaque validated cursor', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      let tick = 0;
      const chat = new ChatService(adapter, () => new Date(Date.UTC(2026, 8, 4, 12, 0, tick++)));
      for (const title of ['First', 'Second', 'Third'])
        await chat.createConversation({ organizationId, title, createdBy: 'user-1' });

      const first = await chat.listConversationsPage(organizationId, 'user-1', undefined, 2);
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toBeTypeOf('string');
      const second = await chat.listConversationsPage(
        organizationId,
        'user-1',
        first.nextCursor,
        2,
      );
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeUndefined();
      await expect(
        chat.listConversationsPage(organizationId, 'user-1', 'not-a-cursor', 2),
      ).rejects.toThrow('Invalid cursor');
    } finally {
      await adapter.close();
    }
  });

  it('creates a tenant-owned conversation and preserves ordered multimodal branch history', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      let tick = 0;
      const support = attachmentOptions();
      const chat = new ChatService(
        adapter,
        () => new Date(Date.UTC(2026, 8, 4, 12, 0, tick++)),
        support.options,
      );
      const conversation = await chat.createConversation({
        organizationId,
        title: '  Multimodal support  ',
        createdBy: 'user-1',
      });
      const attachment = await chat.storeAttachment({
        organizationId,
        conversationId: conversation.id,
        createdBy: 'user-1',
        filename: 'diagram.png',
        mimeType: 'image/png',
        content: new Uint8Array([137, 80, 78, 71]),
      });
      expect(conversation).toMatchObject({ title: 'Multimodal support', status: 'ACTIVE' });
      const first = await chat.appendMessage({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        role: 'user',
        createdBy: 'user-1',
        parts: [
          { id: 'part-text', type: 'text', text: 'Explain this image' },
          {
            id: 'part-image',
            type: 'image',
            mimeType: 'image/png',
            uri: `attachment://${attachment.id}`,
          },
        ],
      });
      const citation = await chat.createCitation({
        organizationId,
        conversationId: conversation.id,
        createdBy: 'user-1',
        sourceUri: 'https://example.com/source',
        title: 'Source',
      });
      const second = await chat.appendMessage({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        role: 'assistant',
        createdBy: 'user-1',
        modelDefinitionId: 'model-1',
        providerId: 'provider-1',
        parentMessageId: first.id,
        parts: [
          { id: 'part-answer', type: 'text', text: 'Answer' },
          { id: 'part-citation', type: 'citation', data: { citationId: citation.id } },
        ],
      });
      await expect(
        chat.history(organizationId, conversation.id, conversation.activeBranchId),
      ).resolves.toMatchObject([{ sequence: 1 }, { id: second.id, sequence: 2 }]);

      const branch = await chat.createBranch({
        organizationId,
        conversationId: conversation.id,
        fromMessageId: first.id,
        name: 'alternative',
        createdBy: 'user-1',
      });
      await chat.appendMessage({
        organizationId,
        conversationId: conversation.id,
        branchId: branch.id,
        role: 'assistant',
        createdBy: 'user-1',
        parentMessageId: first.id,
        parts: [{ id: 'part-alternative', type: 'reasoning', text: 'Alternative summary' }],
      });
      await expect(chat.history(organizationId, conversation.id, branch.id)).resolves.toMatchObject(
        [
          { sequence: 1, branchId: conversation.activeBranchId },
          { sequence: 2, branchId: branch.id },
        ],
      );
      await expect(chat.history('other-organization', conversation.id, branch.id)).rejects.toThrow(
        /branch not found/,
      );
    } finally {
      await adapter.close();
    }
  });

  it('rejects empty parts, foreign writers and cross-conversation branch sources', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const chat = new ChatService(adapter);
      const conversation = await chat.createConversation({
        organizationId,
        title: 'Secure chat',
        createdBy: 'owner',
      });
      await expect(
        chat.appendMessage({
          organizationId,
          conversationId: conversation.id,
          branchId: conversation.activeBranchId,
          role: 'user',
          createdBy: 'owner',
          parts: [],
        }),
      ).rejects.toThrow(/parts/);
      await expect(
        chat.appendMessage({
          organizationId,
          conversationId: conversation.id,
          branchId: conversation.activeBranchId,
          role: 'user',
          createdBy: 'intruder',
          parts: [{ id: 'text', type: 'text', text: 'unauthorized' }],
        }),
      ).rejects.toThrow(/permission/);
    } finally {
      await adapter.close();
    }
  });

  it('persists idempotent stream events, replays cursors and completes durably', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      let tick = 0;
      const chat = new ChatService(adapter, () => new Date(Date.UTC(2026, 8, 8, 12, 0, tick++)));
      const conversation = await chat.createConversation({
        organizationId,
        title: 'Streaming',
        createdBy: 'owner',
      });
      const message = await chat.startStream({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        createdBy: 'owner',
        modelDefinitionId: 'model-1',
        providerId: 'provider-1',
        idempotencyKey: 'start-1',
      });
      await expect(
        chat.startStream({
          organizationId,
          conversationId: conversation.id,
          branchId: conversation.activeBranchId,
          createdBy: 'owner',
          modelDefinitionId: 'model-1',
          providerId: 'provider-1',
          idempotencyKey: 'start-1',
        }),
      ).resolves.toEqual(message);
      const delta = {
        organizationId,
        messageId: message.id,
        type: 'DELTA' as const,
        idempotencyKey: 'delta-1',
        part: { id: 'delta-part-1', type: 'text' as const, text: 'Hello' },
      };
      const first = await chat.appendStreamEvent(delta);
      await expect(chat.appendStreamEvent(delta)).resolves.toEqual(first);
      await expect(
        chat.appendStreamEvent({ ...delta, part: { ...delta.part, text: 'Conflict' } }),
      ).rejects.toThrow(/conflicts/);
      await chat.appendStreamEvent({
        organizationId,
        messageId: message.id,
        type: 'DELTA',
        idempotencyKey: 'delta-2',
        part: { id: 'delta-part-2', type: 'citation', data: { sourceId: 'source-1' } },
      });
      await chat.appendStreamEvent({
        organizationId,
        messageId: message.id,
        type: 'COMPLETED',
        idempotencyKey: 'complete-1',
      });

      await expect(chat.replayStream(organizationId, message.id, 1, 2)).resolves.toMatchObject({
        events: [{ sequence: 2 }, { sequence: 3 }],
        nextCursor: 3,
      });
      await expect(chat.replayStream(organizationId, message.id, 3)).resolves.toMatchObject({
        events: [{ sequence: 4, type: 'COMPLETED' }],
      });
      const history = await chat.history(
        organizationId,
        conversation.id,
        conversation.activeBranchId,
      );
      expect(history[0]).toMatchObject({
        id: message.id,
        status: 'COMPLETED',
        parts: [{ text: '' }, { text: 'Hello' }, { type: 'citation' }],
      });
      await expect(chat.appendStreamEvent(delta)).resolves.toEqual(first);
      await expect(
        chat.appendStreamEvent({
          organizationId,
          messageId: message.id,
          type: 'DELTA',
          idempotencyKey: 'late-delta',
          part: { id: 'late', type: 'text', text: 'late' },
        }),
      ).rejects.toThrow(/terminal/);
      await expect(chat.replayStream('other-organization', message.id)).rejects.toThrow(
        /not found/,
      );
    } finally {
      await adapter.close();
    }
  });

  it('propagates cancellation and persists cancelled and failed terminal states', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const chat = new ChatService(adapter);
      const conversation = await chat.createConversation({
        organizationId,
        title: 'Cancellation',
        createdBy: 'owner',
      });
      const start = (idempotencyKey: string) =>
        chat.startStream({
          organizationId,
          conversationId: conversation.id,
          branchId: conversation.activeBranchId,
          createdBy: 'owner',
          modelDefinitionId: 'model-1',
          providerId: 'provider-1',
          idempotencyKey,
        });
      const cancelled = await start('start-cancel');
      let observedSignal: AbortSignal | undefined;
      const running = chat.runStream(cancelled.id, async (signal) => {
        observedSignal = signal;
        await new Promise((resolve) => {
          signal.addEventListener('abort', resolve, { once: true });
        });
      });
      await chat.cancelStream({
        organizationId,
        messageId: cancelled.id,
        idempotencyKey: 'cancel-1',
      });
      await running;
      expect(observedSignal?.aborted).toBe(true);

      const failed = await start('start-fail');
      await chat.appendStreamEvent({
        organizationId,
        messageId: failed.id,
        type: 'FAILED',
        idempotencyKey: 'fail-1',
        errorCode: 'PROVIDER_TIMEOUT',
      });
      const history = await chat.history(
        organizationId,
        conversation.id,
        conversation.activeBranchId,
      );
      expect(history.map(({ status }) => status)).toEqual(['CANCELLED', 'FAILED']);
    } finally {
      await adapter.close();
    }
  });

  it('projects terminal assistant usage without exposing message content', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const chat = new ChatService(adapter);
      const conversation = await chat.createConversation({
        organizationId,
        title: 'Usage projection',
        createdBy: 'owner',
      });
      const completed = await chat.startStream({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        createdBy: 'owner',
        modelDefinitionId: 'model-1',
        providerId: 'provider-1',
        idempotencyKey: 'usage-start',
      });
      await chat.appendStreamEvent({
        organizationId,
        messageId: completed.id,
        type: 'USAGE',
        idempotencyKey: 'usage-metadata',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.25,
        latencyMs: 120,
      });
      await chat.appendStreamEvent({
        organizationId,
        messageId: completed.id,
        type: 'DELTA',
        idempotencyKey: 'usage-delta',
        part: { id: 'secret-answer', type: 'text', text: 'private answer' },
      });
      await chat.appendStreamEvent({
        organizationId,
        messageId: completed.id,
        type: 'COMPLETED',
        idempotencyKey: 'usage-complete',
      });

      const failed = await chat.startStream({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        createdBy: 'owner',
        modelDefinitionId: 'model-2',
        providerId: 'provider-2',
        idempotencyKey: 'usage-failed-start',
      });
      await chat.appendStreamEvent({
        organizationId,
        messageId: failed.id,
        type: 'FAILED',
        idempotencyKey: 'usage-failed',
        errorCode: 'PROVIDER_TIMEOUT',
      });

      await chat.appendMessage({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        role: 'user',
        createdBy: 'owner',
        parts: [{ id: 'user-content', type: 'text', text: 'private prompt' }],
      });

      const usage = await chat.listUsage(organizationId);
      expect(usage).toHaveLength(2);
      expect(usage).toContainEqual({
        id: completed.id,
        organizationId,
        principalId: 'owner',
        scopeType: 'USER',
        scopeKey: 'owner',
        provider: 'provider-1',
        model: 'model-1',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.25,
        latencyMs: 120,
        outcome: 'SUCCESS',
      });
      expect(usage.find((record) => record.id === failed.id)).toMatchObject({
        outcome: 'ERROR',
        inputTokens: 0,
        outputTokens: 0,
      });
      expect(JSON.stringify(usage)).not.toContain('private answer');
      expect(JSON.stringify(usage)).not.toContain('private prompt');
    } finally {
      await adapter.close();
    }
  });

  it('edits, regenerates and retries through immutable replacement branches', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const chat = new ChatService(adapter);
      const conversation = await chat.createConversation({
        organizationId,
        title: 'Revisions',
        createdBy: 'owner',
      });
      const user = await chat.appendMessage({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        role: 'user',
        createdBy: 'owner',
        parts: [{ id: 'original-user', type: 'text', text: 'Original' }],
      });
      const assistant = await chat.appendMessage({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        role: 'assistant',
        createdBy: 'owner',
        parentMessageId: user.id,
        modelDefinitionId: 'model-1',
        providerId: 'provider-1',
        parts: [{ id: 'original-answer', type: 'text', text: 'Answer' }],
      });

      const edited = await chat.editMessage({
        organizationId,
        conversationId: conversation.id,
        messageId: user.id,
        createdBy: 'owner',
        parts: [{ id: 'edited-user', type: 'text', text: 'Edited' }],
      });
      await expect(
        chat.history(organizationId, conversation.id, edited.branch.id),
      ).resolves.toMatchObject([
        { id: edited.message.id, sequence: 1, parts: [{ text: 'Edited' }] },
      ]);

      const regenerated = await chat.regenerateMessage({
        organizationId,
        conversationId: conversation.id,
        messageId: assistant.id,
        createdBy: 'owner',
        modelDefinitionId: 'model-2',
      });
      await expect(
        chat.history(organizationId, conversation.id, regenerated.branch.id),
      ).resolves.toMatchObject([
        { id: user.id, sequence: 1 },
        {
          id: regenerated.message.id,
          sequence: 2,
          status: 'PENDING',
          modelDefinitionId: 'model-2',
        },
      ]);

      const failed = await chat.startStream({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        createdBy: 'owner',
        parentMessageId: assistant.id,
        modelDefinitionId: 'model-1',
        providerId: 'provider-1',
        idempotencyKey: 'retry-start',
      });
      await chat.appendStreamEvent({
        organizationId,
        messageId: failed.id,
        type: 'FAILED',
        idempotencyKey: 'retry-failed',
        errorCode: 'NETWORK_ERROR',
      });
      const retried = await chat.retryMessage({
        organizationId,
        conversationId: conversation.id,
        messageId: failed.id,
        createdBy: 'owner',
      });
      expect(retried.message).toMatchObject({ status: 'PENDING', modelDefinitionId: 'model-1' });
      await expect(
        chat.retryMessage({
          organizationId,
          conversationId: conversation.id,
          messageId: assistant.id,
          createdBy: 'owner',
        }),
      ).rejects.toThrow(/failed or cancelled/);

      const original = await chat.history(
        organizationId,
        conversation.id,
        conversation.activeBranchId,
      );
      expect(original.slice(0, 2).map(({ id }) => id)).toEqual([user.id, assistant.id]);
    } finally {
      await adapter.close();
    }
  });

  it('archives, restores and privacy-deletes conversations with content-free audit evidence', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const chat = new ChatService(adapter);
      const conversation = await chat.createConversation({
        organizationId,
        title: 'Sensitive title',
        createdBy: 'owner',
      });
      await chat.appendMessage({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        role: 'user',
        createdBy: 'owner',
        parts: [{ id: 'secret-part', type: 'text', text: 'private prompt' }],
      });
      await expect(
        chat.archiveConversation({
          organizationId,
          conversationId: conversation.id,
          actorId: 'outsider',
        }),
      ).rejects.toThrow(/owner permission/);
      await expect(
        chat.archiveConversation({
          organizationId,
          conversationId: conversation.id,
          actorId: 'owner',
        }),
      ).resolves.toMatchObject({ status: 'ARCHIVED' });
      await expect(
        chat.restoreConversation({
          organizationId,
          conversationId: conversation.id,
          actorId: 'owner',
        }),
      ).resolves.toMatchObject({ status: 'ACTIVE' });
      await expect(
        chat.deleteConversation({
          organizationId,
          conversationId: conversation.id,
          actorId: 'owner',
        }),
      ).resolves.toMatchObject({
        status: 'DELETED',
        title: 'Deleted conversation',
        createdBy: 'deleted',
      });
      await expect(chat.listConversations(organizationId, 'owner')).resolves.toEqual([]);
      const audit = await chat.listAuditEvents(organizationId);
      expect(audit.map(({ operation }) => operation)).toEqual([
        'CONVERSATION_CREATED',
        'CONVERSATION_ARCHIVED',
        'CONVERSATION_RESTORED',
        'CONVERSATION_DELETED',
      ]);
      expect(JSON.stringify(audit)).not.toContain('Sensitive title');
      expect(JSON.stringify(audit)).not.toContain('private prompt');
    } finally {
      await adapter.close();
    }
  });

  it('validates and isolates attachment, citation and artifact references', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const support = attachmentOptions();
      const chat = new ChatService(adapter, () => new Date(), support.options);
      const conversation = await chat.createConversation({
        organizationId,
        title: 'Assets',
        createdBy: 'owner',
      });
      const attachment = await chat.storeAttachment({
        organizationId,
        conversationId: conversation.id,
        createdBy: 'owner',
        filename: 'notes.txt',
        mimeType: 'text/plain',
        content: new TextEncoder().encode('safe content'),
        dataClassification: 'CONFIDENTIAL',
      });
      expect(attachment).toMatchObject({
        originalName: 'notes.txt',
        status: 'READY',
        dataClassification: 'CONFIDENTIAL',
        sizeBytes: 12,
      });
      expect(attachment.storageKey).not.toContain('notes');
      await expect(chat.attachmentUrl(organizationId, attachment.id, 60)).resolves.toContain(
        'expires=60',
      );
      const citation = await chat.createCitation({
        organizationId,
        conversationId: conversation.id,
        createdBy: 'owner',
        sourceUri: 'https://example.com/reference',
        title: 'Reference',
        locator: 'p. 4',
      });
      const artifact = await chat.createArtifact({
        organizationId,
        conversationId: conversation.id,
        createdBy: 'owner',
        title: 'Generated report',
        kind: 'document',
        storageKey: 'artifacts/report-1',
        mimeType: 'text/markdown',
      });
      await expect(
        chat.appendMessage({
          organizationId,
          conversationId: conversation.id,
          branchId: conversation.activeBranchId,
          role: 'user',
          createdBy: 'owner',
          parts: [
            { id: 'file', type: 'file', uri: `attachment://${attachment.id}` },
            { id: 'citation', type: 'citation', data: { citationId: citation.id } },
            { id: 'artifact', type: 'artifact', data: { artifactId: artifact.id } },
          ],
        }),
      ).resolves.toMatchObject({ sequence: 1 });
      await expect(
        chat.storeAttachment({
          organizationId,
          conversationId: conversation.id,
          createdBy: 'owner',
          filename: 'payload.exe',
          mimeType: 'application/octet-stream',
          content: new Uint8Array([1]),
        }),
      ).rejects.toThrow(/not allowed/);
      await expect(chat.attachmentUrl('other-organization', attachment.id)).rejects.toThrow(
        /not found/,
      );
      const otherConversation = await chat.createConversation({
        organizationId,
        title: 'Other assets',
        createdBy: 'owner',
      });
      await expect(
        chat.appendMessage({
          organizationId,
          conversationId: otherConversation.id,
          branchId: otherConversation.activeBranchId,
          role: 'user',
          createdBy: 'owner',
          parts: [{ id: 'foreign-citation', type: 'citation', data: { citationId: citation.id } }],
        }),
      ).rejects.toThrow(/citation reference/);

      const infectedSupport = attachmentOptions();
      const rejectingChat = new ChatService(adapter, () => new Date(), {
        ...infectedSupport.options,
        malwareScanner: { scan: () => Promise.resolve('INFECTED') },
      });
      await expect(
        rejectingChat.storeAttachment({
          organizationId,
          conversationId: conversation.id,
          createdBy: 'owner',
          filename: 'infected.txt',
          mimeType: 'text/plain',
          content: new Uint8Array([1]),
        }),
      ).rejects.toThrow(/malware scanner/);
      expect(infectedSupport.objects.size).toBe(0);
      expect(support.objects.size).toBe(1);
      await expect(
        chat.deleteAttachment({
          organizationId,
          conversationId: conversation.id,
          attachmentId: attachment.id,
          deletedBy: 'owner',
        }),
      ).resolves.toMatchObject({ status: 'DELETED', version: 2 });
      expect(support.objects.size).toBe(0);
      await expect(chat.getAttachment(organizationId, attachment.id)).rejects.toThrow(/not found/);
    } finally {
      await adapter.close();
    }
  });

  it('records retention deletion as its actual system actor instead of impersonating the owner', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const chat = new ChatService(adapter);
      const conversation = await chat.createConversation({
        organizationId,
        title: 'Expired conversation',
        createdBy: 'conversation-owner',
      });
      await expect(
        chat.deleteConversationForRetention({
          organizationId,
          conversationId: conversation.id,
          actorId: 'system:privacy-retention-scheduler',
        }),
      ).resolves.toMatchObject({ status: 'DELETED' });
      const audit = await chat.listAuditEvents(organizationId);
      expect(audit.at(-1)).toMatchObject({
        actorId: 'system:privacy-retention-scheduler',
        operation: 'CONVERSATION_DELETED',
      });
    } finally {
      await adapter.close();
    }
  });
});
