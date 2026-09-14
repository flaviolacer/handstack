import { randomUUID } from 'node:crypto';
import { AuthenticationError, ValidationError } from '@handstack/shared';
import { Body, Controller, Headers, Post, Get, Inject, Optional, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { GatewayRuntimeService } from './gateway-runtime.service.js';
import { ModelAdminRuntimeService } from '../models/model-admin-runtime.service.js';
import { ApiMetrics } from '../observability/api-metrics.js';

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().max(1_000_000),
});

const completionSchema = z.looseObject({
  model: z.string().trim().min(1).max(300),
  messages: z.array(messageSchema).min(1).max(10_000),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
});
const embeddingSchema = z.object({
  model: z.string().trim().min(1).max(300),
  input: z.union([z.string().max(1_000_000), z.array(z.string().max(1_000_000)).min(1).max(2_048)]),
});

function bearer(value: string | undefined): string {
  if (value?.startsWith('Bearer ') !== true || value.slice(7).trim() === '')
    throw new AuthenticationError('Bearer virtual API key is required');
  return value.slice(7).trim();
}

function estimatedInputTokens(messages: readonly { content: string }[]): number {
  return Math.max(
    1,
    Math.ceil(messages.reduce((total, item) => total + item.content.length, 0) / 4),
  );
}

function estimatedTextTokens(input: readonly string[]): number {
  return Math.max(1, Math.ceil(input.reduce((total, value) => total + value.length, 0) / 4));
}

function price(
  pricing: { inputPerMillion: number; outputPerMillion: number },
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (pricing.inputPerMillion * inputTokens + pricing.outputPerMillion * outputTokens) / 1_000_000
  );
}

@ApiTags('OpenAI-compatible Gateway')
@Controller('v1')
export class OpenAiCompatibleController {
  constructor(
    @Inject(GatewayRuntimeService) private readonly gateway: GatewayRuntimeService,
    @Inject(ModelAdminRuntimeService) private readonly models: ModelAdminRuntimeService,
    @Optional() @Inject(ApiMetrics) metrics?: ApiMetrics,
  ) {
    this.metrics = metrics ?? new ApiMetrics();
  }

  private readonly metrics: ApiMetrics;

  @Get('models')
  @ApiOperation({ summary: 'List published models allowed by a virtual API key' })
  async listModels(@Headers('authorization') authorization: string | undefined) {
    const key = await this.gateway.keys.authenticate(bearer(authorization));
    const page = await this.models.registry.listModels(key.organizationId);
    const allowed = page.items.filter(
      (model) =>
        model.lifecycle === 'PUBLISHED' &&
        (key.models.length === 0 ||
          key.models.includes(model.id) ||
          model.aliases.some((alias) => key.models.includes(alias))),
    );
    return {
      object: 'list',
      data: allowed.map((model) => ({
        id: model.aliases[0] ?? model.id,
        object: 'model',
        created: Math.floor(new Date(model.createdAt).getTime() / 1000),
        owned_by: model.providerId,
      })),
    };
  }

  @Post('chat/completions')
  @ApiOperation({ summary: 'OpenAI-compatible chat completion' })
  @ApiProduces('application/json', 'text/event-stream')
  async completion(
    @Headers('authorization') authorization: string | undefined,
    @Body() value: unknown,
    @Res() reply: FastifyReply,
  ) {
    const body = completionSchema.safeParse(value);
    if (!body.success)
      throw new ValidationError(body.error.issues[0]?.message ?? 'Invalid completion');
    const key = await this.gateway.keys.authenticate(bearer(authorization), body.data.model);
    const input = {
      organizationId: key.organizationId,
      model: body.data.model,
      dataClassification: 'PUBLIC' as const,
      messages: body.data.messages,
    };
    const route = await this.models.execution.resolveRoute({
      organizationId: key.organizationId,
      model: body.data.model,
      dataClassification: 'PUBLIC',
    });
    const estimatedTokens = estimatedInputTokens(body.data.messages);
    const estimatedUsd = price(route.pricing, estimatedTokens, 1024);
    await this.gateway.keys.reserveBudget(key.organizationId, key.id, estimatedUsd);
    this.metrics.llmRequest();
    if (body.data.stream) {
      reply.hijack();
      reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
      reply.raw.setHeader('cache-control', 'no-cache, no-transform');
      reply.raw.setHeader('connection', 'keep-alive');
      reply.raw.writeHead(200);
      const id = `chatcmpl-${randomUUID()}`;
      try {
        let inputTokens = estimatedTokens;
        let outputTokens = 0;
        for await (const event of this.models.execution.stream(input)) {
          if (event.type === 'content') {
            reply.raw.write(
              `data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }],
              })}\n\n`,
            );
          } else if (event.type === 'usage') {
            inputTokens = event.usage.inputTokens;
            outputTokens = event.usage.outputTokens;
          } else if (event.type === 'done') {
            reply.raw.write(
              `data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: {}, finish_reason: event.finishReason }],
              })}\n\n`,
            );
          }
        }
        await this.gateway.keys.settleBudget(
          key.organizationId,
          key.id,
          estimatedUsd,
          price(route.pricing, inputTokens, outputTokens),
        );
        this.metrics.tokens({ input: inputTokens, output: outputTokens });
        this.metrics.cost(price(route.pricing, inputTokens, outputTokens));
      } catch (error) {
        await this.gateway.keys.settleBudget(key.organizationId, key.id, estimatedUsd, 0);
        throw error;
      }
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      return;
    }
    try {
      const response = await this.models.execution.chat(input);
      await this.gateway.keys.settleBudget(
        key.organizationId,
        key.id,
        estimatedUsd,
        price(route.pricing, response.usage.inputTokens, response.usage.outputTokens),
      );
      this.metrics.tokens({
        input: response.usage.inputTokens,
        output: response.usage.outputTokens,
      });
      this.metrics.cost(
        price(route.pricing, response.usage.inputTokens, response.usage.outputTokens),
      );
      return await reply.send({
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.data.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: response.content },
            finish_reason: response.finishReason,
          },
        ],
        usage: {
          prompt_tokens: response.usage.inputTokens,
          completion_tokens: response.usage.outputTokens,
          total_tokens: response.usage.inputTokens + response.usage.outputTokens,
        },
      });
    } catch (error) {
      await this.gateway.keys.settleBudget(key.organizationId, key.id, estimatedUsd, 0);
      throw error;
    }
  }

  @Post('embeddings')
  @ApiOperation({ summary: 'OpenAI-compatible embeddings (provider capability required)' })
  async embeddings(
    @Headers('authorization') authorization: string | undefined,
    @Body() value: unknown,
  ) {
    const body = embeddingSchema.safeParse(value);
    if (!body.success)
      throw new ValidationError(body.error.issues[0]?.message ?? 'Invalid embedding request');
    const key = await this.gateway.keys.authenticate(bearer(authorization), body.data.model);
    const input = typeof body.data.input === 'string' ? [body.data.input] : body.data.input;
    const route = await this.models.execution.resolveRoute({
      organizationId: key.organizationId,
      model: body.data.model,
      dataClassification: 'PUBLIC',
    });
    const estimatedTokens = estimatedTextTokens(input);
    const estimatedUsd = price(route.pricing, estimatedTokens, 0);
    await this.gateway.keys.reserveBudget(key.organizationId, key.id, estimatedUsd);
    this.metrics.llmRequest();
    try {
      const response = await this.models.execution.embed({
        organizationId: key.organizationId,
        model: body.data.model,
        dataClassification: 'PUBLIC',
        input,
      });
      await this.gateway.keys.settleBudget(
        key.organizationId,
        key.id,
        estimatedUsd,
        price(route.pricing, response.usage.promptTokens, 0),
      );
      this.metrics.tokens({ input: response.usage.promptTokens, output: 0 });
      this.metrics.cost(price(route.pricing, response.usage.promptTokens, 0));
      return {
        object: 'list',
        data: response.vectors.map((embedding, index) => ({
          object: 'embedding',
          embedding,
          index,
        })),
        model: body.data.model,
        usage: {
          prompt_tokens: response.usage.promptTokens,
          total_tokens: response.usage.totalTokens,
        },
      };
    } catch (error) {
      await this.gateway.keys.settleBudget(key.organizationId, key.id, estimatedUsd, 0);
      throw error;
    }
  }
}
