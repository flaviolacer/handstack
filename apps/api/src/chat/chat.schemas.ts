import { z } from 'zod';

export const messagePartSchema = z
  .object({
    id: z.string().min(1).max(200),
    type: z.enum([
      'text',
      'image',
      'audio',
      'file',
      'tool_call',
      'tool_result',
      'reasoning',
      'citation',
      'artifact',
      'error',
    ]),
    mimeType: z.string().min(1).max(200).optional(),
    text: z.string().max(1_000_000).optional(),
    uri: z.string().max(2_000).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const createConversationSchema = z
  .object({ title: z.string().trim().min(1).max(300) })
  .strict();

export const chatPageQuerySchema = z
  .object({
    cursor: z.string().min(1).max(2_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const attachmentUploadQuerySchema = z
  .object({
    dataClassification: z
      .enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'])
      .default('INTERNAL'),
  })
  .strict();

export const attachmentUrlQuerySchema = z
  .object({ expiresInSeconds: z.coerce.number().int().min(1).max(3_600).default(300) })
  .strict();

export const attachmentDownloadQuerySchema = z
  .object({ token: z.string().min(20).max(8_000) })
  .strict();

export const appendMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    parts: z.array(messagePartSchema).min(1).max(500),
    parentMessageId: z.string().min(1).max(200).optional(),
  })
  .strict();

export const editMessageSchema = z
  .object({ parts: z.array(messagePartSchema).min(1).max(500) })
  .strict();

export const regenerateMessageSchema = z
  .object({
    model: z.string().min(1).max(200).optional(),
    dataClassification: z
      .enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'])
      .default('INTERNAL'),
  })
  .strict();

export const executeChatSchema = z
  .object({
    model: z.string().min(1).max(200),
    dataClassification: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']),
    parentMessageId: z.string().min(1).max(200).optional(),
    traceId: z.string().min(1).max(200).optional(),
  })
  .strict();

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type AppendMessageInput = z.infer<typeof appendMessageSchema>;
export type EditMessageInput = z.infer<typeof editMessageSchema>;
export type RegenerateMessageInput = z.infer<typeof regenerateMessageSchema>;
export type ExecuteChatInput = z.infer<typeof executeChatSchema>;
