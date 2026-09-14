import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import type { ChatEvent } from '@handstack/models';
import { describe, expect, it } from 'vitest';
import { ChatExecutionService, ChatService, type ConversationModelRuntime } from '../src/index.js';

const organizationId = 'execution-organization';

function runtime(events: readonly ChatEvent[] | Error): ConversationModelRuntime {
  return {
    resolveRoute: () =>
      Promise.resolve({
        modelDefinitionId: 'model-definition',
        providerId: 'provider-definition',
        pricing: { inputPerMillion: 2, outputPerMillion: 4, currency: 'USD' },
      }),
    async *stream() {
      await Promise.resolve();
      if (events instanceof Error) throw events;
      for (const event of events) yield event;
    },
  };
}

describe('chat model execution', () => {
  it('returns a streaming handle before the provider completes', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const chat = new ChatService(adapter);
      const conversation = await chat.createConversation({
        organizationId,
        title: 'Async execution',
        createdBy: 'owner',
      });
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const execution = new ChatExecutionService(chat, {
        ...runtime([]),
        async *stream() {
          await gate;
          yield { type: 'content', delta: 'later' };
          yield { type: 'done', finishReason: 'stop' };
        },
      });
      const handle = await execution.start({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        createdBy: 'owner',
        model: 'smart',
        dataClassification: 'PUBLIC',
        idempotencyKey: 'execution-async',
      });
      expect(handle.message.status).toBe('STREAMING');
      release?.();
      await expect(handle.completion).resolves.toMatchObject({ status: 'COMPLETED' });
    } finally {
      await adapter.close();
    }
  });

  it('persists provider deltas, tool calls, usage, cost, latency and trace', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      let tick = 1_000;
      const chat = new ChatService(adapter, () => new Date(tick++));
      const conversation = await chat.createConversation({
        organizationId,
        title: 'Runtime stream',
        createdBy: 'owner',
      });
      const user = await chat.appendMessage({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        role: 'user',
        createdBy: 'owner',
        parts: [{ id: 'question', type: 'text', text: 'Hello' }],
      });
      const execution = new ChatExecutionService(
        chat,
        runtime([
          { type: 'content', delta: 'Hi ' },
          {
            type: 'tool_call',
            toolCall: { id: 'tool-1', name: 'clock', arguments: { zone: 'UTC' } },
          },
          { type: 'content', delta: 'there' },
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
          { type: 'done', finishReason: 'stop' },
        ]),
        () => tick++,
      );
      const result = await execution.execute({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        createdBy: 'owner',
        parentMessageId: user.id,
        model: 'smart',
        dataClassification: 'INTERNAL',
        idempotencyKey: 'execution-1',
        traceId: 'trace-1',
      });
      expect(result).toMatchObject({
        status: 'COMPLETED',
        modelDefinitionId: 'model-definition',
        providerId: 'provider-definition',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.00004,
        traceId: 'trace-1',
      });
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.parts).toMatchObject([
        { type: 'text', text: '' },
        { type: 'text', text: 'Hi ' },
        { type: 'tool_call', data: { id: 'tool-1', name: 'clock' } },
        { type: 'text', text: 'there' },
      ]);
      const replay = await chat.replayStream(organizationId, result.id);
      expect(replay.events.map(({ type }) => type)).toEqual([
        'STARTED',
        'DELTA',
        'DELTA',
        'DELTA',
        'USAGE',
        'COMPLETED',
      ]);
      await expect(
        execution.execute({
          organizationId,
          conversationId: conversation.id,
          branchId: conversation.activeBranchId,
          createdBy: 'owner',
          parentMessageId: user.id,
          model: 'smart',
          dataClassification: 'INTERNAL',
          idempotencyKey: 'execution-1',
        }),
      ).resolves.toMatchObject({ id: result.id, status: 'COMPLETED' });
    } finally {
      await adapter.close();
    }
  });

  it('persists a redacted terminal failure when the provider stream fails', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const chat = new ChatService(adapter);
      const conversation = await chat.createConversation({
        organizationId,
        title: 'Failed stream',
        createdBy: 'owner',
      });
      const execution = new ChatExecutionService(chat, runtime(new Error('secret vendor detail')));
      await expect(
        execution.execute({
          organizationId,
          conversationId: conversation.id,
          branchId: conversation.activeBranchId,
          createdBy: 'owner',
          model: 'smart',
          dataClassification: 'PUBLIC',
          idempotencyKey: 'execution-failure',
        }),
      ).rejects.toThrow('secret vendor detail');
      const history = await chat.history(
        organizationId,
        conversation.id,
        conversation.activeBranchId,
      );
      expect(history).toMatchObject([{ status: 'FAILED' }]);
      const failed = history[0];
      if (failed === undefined) throw new Error('Expected a failed message');
      const replay = await chat.replayStream(organizationId, failed.id);
      expect(replay.events.at(-1)).toMatchObject({
        type: 'FAILED',
        errorCode: 'PROVIDER_STREAM_FAILED',
      });
      expect(JSON.stringify(replay)).not.toContain('secret vendor detail');
    } finally {
      await adapter.close();
    }
  });

  it('executes a replacement in its pending message without sending the placeholder', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const chat = new ChatService(adapter);
      const conversation = await chat.createConversation({
        organizationId,
        title: 'Regenerate',
        createdBy: 'owner',
      });
      const user = await chat.appendMessage({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        role: 'user',
        createdBy: 'owner',
        parts: [{ id: 'question', type: 'text', text: 'Try again' }],
      });
      const original = await chat.appendMessage({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        role: 'assistant',
        status: 'COMPLETED',
        createdBy: 'owner',
        modelDefinitionId: 'model-definition',
        providerId: 'provider-definition',
        parentMessageId: user.id,
        parts: [{ id: 'old-answer', type: 'text', text: 'Old answer' }],
      });
      const revision = await chat.regenerateMessage({
        organizationId,
        conversationId: conversation.id,
        messageId: original.id,
        createdBy: 'owner',
      });
      let modelMessages: readonly { role: string; content: string }[] = [];
      const execution = new ChatExecutionService(chat, {
        ...runtime([]),
        async *stream(input) {
          await Promise.resolve();
          modelMessages = input.messages;
          yield { type: 'content', delta: 'New answer' };
          yield { type: 'done', finishReason: 'stop' };
        },
      });
      const result = await execution.execute({
        organizationId,
        conversationId: conversation.id,
        branchId: revision.branch.id,
        createdBy: 'owner',
        model: 'model-definition',
        dataClassification: 'INTERNAL',
        idempotencyKey: 'regenerate-execution',
        pendingMessageId: revision.message.id,
        parentMessageId: user.id,
      });
      expect(result).toMatchObject({ id: revision.message.id, status: 'COMPLETED' });
      expect(modelMessages).toEqual([{ role: 'user', content: 'Try again' }]);
      const history = await chat.history(organizationId, conversation.id, revision.branch.id);
      expect(history).toHaveLength(2);
      expect(history[1]).toMatchObject({ id: revision.message.id, status: 'COMPLETED' });
    } finally {
      await adapter.close();
    }
  });

  it('propagates cancellation to the provider signal and keeps one cancelled terminal state', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const chat = new ChatService(adapter);
      const conversation = await chat.createConversation({
        organizationId,
        title: 'Cancelled execution',
        createdBy: 'owner',
      });
      let announceStart: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        announceStart = resolve;
      });
      const blockingRuntime: ConversationModelRuntime = {
        resolveRoute: () =>
          Promise.resolve({
            modelDefinitionId: 'model-definition',
            providerId: 'provider-definition',
            pricing: { inputPerMillion: 1, outputPerMillion: 1, currency: 'USD' },
          }),
        async *stream(input) {
          yield { type: 'content', delta: 'partial' };
          announceStart?.();
          await new Promise<void>((resolve) => {
            input.signal?.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
          });
          throw new Error('provider aborted');
        },
      };
      const execution = new ChatExecutionService(chat, blockingRuntime);
      const running = execution.execute({
        organizationId,
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        createdBy: 'owner',
        model: 'smart',
        dataClassification: 'PUBLIC',
        idempotencyKey: 'execution-cancel',
      });
      await started;
      const active = await chat.history(
        organizationId,
        conversation.id,
        conversation.activeBranchId,
      );
      const streaming = active[0];
      if (streaming === undefined) throw new Error('Expected a streaming message');
      await chat.cancelStream({
        organizationId,
        messageId: streaming.id,
        idempotencyKey: 'external-cancel',
      });
      await expect(running).rejects.toThrow('provider aborted');
      await expect(chat.getMessage(organizationId, streaming.id)).resolves.toMatchObject({
        status: 'CANCELLED',
      });
      const replay = await chat.replayStream(organizationId, streaming.id);
      expect(replay.events.filter(({ type }) => type === 'CANCELLED')).toHaveLength(1);
      expect(replay.events.some(({ type }) => type === 'FAILED')).toBe(false);
    } finally {
      await adapter.close();
    }
  });
});
