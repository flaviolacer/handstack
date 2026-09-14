import { z } from 'zod';

export const providerAdapterSchema = z.enum([
  'openai',
  'anthropic',
  'gemini',
  'azure-openai',
  'aws-bedrock',
  'openrouter',
  'ollama',
  'vllm',
  'openai-compatible',
]);

export const dataClassificationSchema = z.enum([
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
]);

export const createProviderSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    adapter: providerAdapterSchema,
    enabled: z.boolean().default(true),
    baseUrl: z.url().optional(),
    secretReference: z.string().trim().min(1).max(500).optional(),
    configuration: z.record(z.string(), z.string()).default({}),
    dataClassificationAllowed: z.array(dataClassificationSchema).min(1),
  })
  .strict()
  .superRefine(({ configuration }, context) => {
    for (const key of Object.keys(configuration)) {
      if (/(secret|password|token|credential|api.?key)/i.test(key)) {
        context.addIssue({
          code: 'custom',
          path: ['configuration', key],
          message: 'Sensitive values must use secretReference',
        });
      }
    }
  });

export const modelCapabilitySchema = z.enum(['chat', 'vision', 'tools', 'embeddings', 'reasoning']);

export const createModelSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    providerId: z.string().trim().min(1).max(200),
    providerModel: z.string().trim().min(1).max(300),
    aliases: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
    capabilities: z.array(modelCapabilitySchema).min(1),
    contextWindow: z.number().int().positive().max(10_000_000),
    pricing: z
      .object({
        inputPerMillion: z.number().nonnegative(),
        outputPerMillion: z.number().nonnegative(),
        currency: z.literal('USD'),
      })
      .strict(),
  })
  .strict();

export const createPromptSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(160),
    description: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

const promptVariableSchema = z
  .object({
    name: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
      .max(100),
    required: z.boolean(),
    description: z.string().trim().min(1).max(500).optional(),
    defaultValue: z.string().max(10_000).optional(),
  })
  .strict();

export const createPromptVersionSchema = z
  .object({
    versionLabel: z.string().trim().min(1).max(100),
    content: z.string().min(1).max(1_000_000),
    variables: z.array(promptVariableSchema).max(200).default([]),
    modelDefinitionId: z.string().trim().min(1).max(200),
  })
  .strict();

export const evaluationMetricSchema = z.enum([
  'task_success',
  'schema_validity',
  'tool_selection_correctness',
  'tool_argument_correctness',
  'groundedness',
  'citation_validity',
  'hallucination_rate',
  'safety_policy_compliance',
  'prompt_injection_resistance',
  'pii_secret_leakage',
  'latency_ms',
  'token_usage',
  'cost_usd',
  'human_rating',
]);

const evaluationCaseSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    input: z.record(z.string(), z.unknown()),
    expected: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const createEvaluationDatasetSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    datasetVersion: z.string().trim().min(1).max(100),
    classification: dataClassificationSchema,
    provenance: z.string().trim().min(1).max(500),
    owner: z.string().trim().min(1).max(200),
    retentionDays: z.number().int().min(1).max(3650),
    sourceKind: z.enum(['SYNTHETIC', 'APPROVED', 'PRODUCTION']),
    approvedForEvaluation: z.literal(true),
    sanitized: z.boolean(),
    legalBasis: z.string().trim().min(1).max(500).optional(),
    cases: z.array(evaluationCaseSchema).min(1).max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sourceKind === 'PRODUCTION' && (!value.sanitized || value.legalBasis === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['legalBasis'],
        message: 'Production evaluation data requires legal basis and sanitization',
      });
    }
    if (new Set(value.cases.map(({ id }) => id)).size !== value.cases.length) {
      context.addIssue({ code: 'custom', path: ['cases'], message: 'Case IDs must be unique' });
    }
  });

export const createEvaluationSuiteSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    suiteVersion: z.string().trim().min(1).max(100),
    datasetId: z.string().trim().min(1).max(200),
    datasetVersion: z.string().trim().min(1).max(100),
    criteria: z
      .array(
        z
          .object({
            metric: evaluationMetricSchema,
            direction: z.enum(['min', 'max']),
            threshold: z.number(),
          })
          .strict(),
      )
      .min(1)
      .max(evaluationMetricSchema.options.length),
  })
  .strict();

export const createEvaluationRunSchema = z
  .object({
    modelDefinitionId: z.string().trim().min(1).max(200),
    suiteId: z.string().trim().min(1).max(200),
    suiteVersion: z.string().trim().min(1).max(100),
    promptVersionId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const recordEvaluationGateSchema = z
  .object({
    runId: z
      .string()
      .trim()
      .length(64)
      .regex(/^[a-f0-9]+$/),
  })
  .strict();

export const emptyOperationSchema = z.object({}).strict();

const chatMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().max(1_000_000),
  })
  .strict();

const toolDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();

export const createModelResponseSchema = z
  .object({
    model: z.string().trim().min(1).max(200),
    dataClassification: dataClassificationSchema,
    messages: z.array(chatMessageSchema).min(1).max(1000),
    tools: z.array(toolDefinitionSchema).max(128).optional(),
  })
  .strict();

const entityMetadataSchema = {
  id: z.string(),
  organizationId: z.string(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
} as const;

export const publicProviderSchema = z.object({
  ...entityMetadataSchema,
  name: z.string(),
  adapter: providerAdapterSchema,
  enabled: z.boolean(),
  baseUrl: z.url().optional(),
  configuration: z.record(z.string(), z.string()),
  hasSecret: z.boolean(),
  dataClassificationAllowed: z.array(dataClassificationSchema),
});

export const publicModelSchema = z.object({
  ...entityMetadataSchema,
  displayName: z.string(),
  providerId: z.string(),
  providerModel: z.string(),
  aliases: z.array(z.string()),
  capabilities: z.array(modelCapabilitySchema),
  contextWindow: z.number().int().positive(),
  pricing: z.object({
    inputPerMillion: z.number().nonnegative(),
    outputPerMillion: z.number().nonnegative(),
    currency: z.literal('USD'),
  }),
  lifecycle: z.enum(['DRAFT', 'EVALUATED', 'APPROVED', 'PUBLISHED', 'DEPRECATED', 'RETIRED']),
  evaluationSuiteVersion: z.string().optional(),
});

export const publicPromptSchema = z.object({
  ...entityMetadataSchema,
  name: z.string(),
  slug: z.string(),
  description: z.string().optional(),
});

export const publicPromptVersionSchema = z.object({
  ...entityMetadataSchema,
  promptId: z.string(),
  versionLabel: z.string(),
  content: z.string(),
  contentDigest: z.string(),
  variables: z.array(promptVariableSchema),
  modelDefinitionId: z.string(),
  lifecycle: z.enum(['DRAFT', 'EVALUATED', 'APPROVED', 'PUBLISHED', 'DEPRECATED', 'RETIRED']),
  evaluationSuiteVersion: z.string().optional(),
});

export const promptPageSchema = z.object({
  items: z.array(publicPromptSchema),
  nextCursor: z.string().optional(),
  previousCursor: z.string().optional(),
});

export const promptVersionPageSchema = z.object({ items: z.array(publicPromptVersionSchema) });

export const providerPageSchema = z.object({
  items: z.array(publicProviderSchema),
  nextCursor: z.string().optional(),
  previousCursor: z.string().optional(),
});

export const modelPageSchema = z.object({
  items: z.array(publicModelSchema),
  nextCursor: z.string().optional(),
  previousCursor: z.string().optional(),
});

export const publicEvaluationDatasetSchema = z.object({
  ...entityMetadataSchema,
  name: z.string(),
  datasetVersion: z.string(),
  classification: dataClassificationSchema,
  provenance: z.string(),
  owner: z.string(),
  retentionDays: z.number().int().positive(),
  sourceKind: z.enum(['SYNTHETIC', 'APPROVED', 'PRODUCTION']),
  approvedForEvaluation: z.boolean(),
  sanitized: z.boolean(),
  hasLegalBasis: z.boolean(),
  caseCount: z.number().int().nonnegative(),
});

export const publicEvaluationSuiteSchema = z.object({
  ...entityMetadataSchema,
  name: z.string(),
  suiteVersion: z.string(),
  datasetId: z.string(),
  datasetVersion: z.string(),
  criteria: z.array(
    z.object({
      metric: evaluationMetricSchema,
      direction: z.enum(['min', 'max']),
      threshold: z.number(),
    }),
  ),
});

export const evaluationDatasetPageSchema = z.object({
  items: z.array(publicEvaluationDatasetSchema),
  nextCursor: z.string().optional(),
  previousCursor: z.string().optional(),
});

export const evaluationSuitePageSchema = z.object({
  items: z.array(publicEvaluationSuiteSchema),
  nextCursor: z.string().optional(),
  previousCursor: z.string().optional(),
});

export const evaluationRunResultSchema = z.object({
  runId: z.string(),
  datasetVersion: z.string(),
  passed: z.boolean(),
  scores: z.record(z.string(), z.number()),
});

export const evaluationGateRecordResponseSchema = z.object({
  run: evaluationRunResultSchema,
  model: publicModelSchema,
});

export const promptEvaluationGateRecordResponseSchema = z.object({
  run: evaluationRunResultSchema,
  promptVersion: publicPromptVersionSchema,
});

export const modelResponseSchema = z.object({
  content: z.string(),
  finishReason: z.enum(['stop', 'length', 'tool_call', 'error']),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
});

export type CreateProviderInput = z.infer<typeof createProviderSchema>;
export type CreateModelInput = z.infer<typeof createModelSchema>;
export type CreatePromptInput = z.infer<typeof createPromptSchema>;
export type CreatePromptVersionInput = z.infer<typeof createPromptVersionSchema>;
export type CreateEvaluationDatasetInput = z.infer<typeof createEvaluationDatasetSchema>;
export type CreateEvaluationSuiteInput = z.infer<typeof createEvaluationSuiteSchema>;
export type CreateEvaluationRunInput = z.infer<typeof createEvaluationRunSchema>;
export type CreateModelResponseInput = z.infer<typeof createModelResponseSchema>;
