import { z } from 'zod';

export const databaseAdapterSchema = z.enum([
  'postgresql',
  'mysql',
  'mariadb',
  'sqlite',
  'sqlserver',
  'mongodb',
]);

export const deploymentProfileSchema = z.enum(['compact', 'distributed']);
export const redisTopologySchema = z.enum(['standalone', 'sentinel', 'cluster']);

export const handStackConfigSchema = z
  .object({
    deployment: z
      .object({
        profile: deploymentProfileSchema.default('compact'),
      })
      .strict()
      .default({ profile: 'compact' }),
    database: z
      .object({
        adapter: databaseAdapterSchema.default('sqlite'),
        url: z.string().min(1).default('file:./handstack.db'),
      })
      .strict()
      .default({ adapter: 'sqlite', url: 'file:./handstack.db' }),
    queue: z
      .object({
        redisUrl: z.url().optional(),
        topology: redisTopologySchema.default('standalone'),
        namespaces: z
          .object({
            cache: z.string().trim().min(1).default('handstack:cache'),
            rateLimit: z.string().trim().min(1).default('handstack:rate-limit'),
            queues: z.string().trim().min(1).default('handstack:queues'),
            streams: z.string().trim().min(1).default('handstack:streams'),
          })
          .strict()
          .default({
            cache: 'handstack:cache',
            rateLimit: 'handstack:rate-limit',
            queues: 'handstack:queues',
            streams: 'handstack:streams',
          }),
      })
      .strict()
      .default({
        topology: 'standalone',
        namespaces: {
          cache: 'handstack:cache',
          rateLimit: 'handstack:rate-limit',
          queues: 'handstack:queues',
          streams: 'handstack:streams',
        },
      }),
    notifications: z
      .object({
        slackEndpoint: z
          .url()
          .refine((value) => value.startsWith('https://'), 'Notification endpoint must use HTTPS')
          .optional(),
        teamsEndpoint: z
          .url()
          .refine((value) => value.startsWith('https://'), 'Notification endpoint must use HTTPS')
          .optional(),
        discordEndpoint: z
          .url()
          .refine((value) => value.startsWith('https://'), 'Notification endpoint must use HTTPS')
          .optional(),
      })
      .strict()
      .default({}),
    server: z
      .object({
        apiPort: z.number().int().min(1).max(65_535).default(3001),
        webPort: z.number().int().min(1).max(65_535).default(3000),
      })
      .strict()
      .default({ apiPort: 3001, webPort: 3000 }),
    telemetry: z
      .object({ enabled: z.boolean().default(false) })
      .strict()
      .default({ enabled: false }),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.deployment.profile === 'distributed' && config.queue.redisUrl === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['queue', 'redisUrl'],
        message: 'Distributed deployment requires a Redis URL',
      });
    }
    const schemes: Record<(typeof config.database)['adapter'], readonly string[]> = {
      sqlite: ['file:'],
      postgresql: ['postgres://', 'postgresql://'],
      mongodb: ['mongodb://', 'mongodb+srv://'],
      mysql: ['mysql://'],
      mariadb: ['mariadb://', 'mysql://'],
      sqlserver: ['sqlserver://', 'mssql://'],
    };
    if (
      !schemes[config.database.adapter].some((scheme) => config.database.url.startsWith(scheme))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['database', 'url'],
        message: `Database URL is incompatible with adapter ${config.database.adapter}`,
      });
    }
  });

export type HandStackConfig = z.infer<typeof handStackConfigSchema>;

export function defineConfig(config: z.input<typeof handStackConfigSchema>): HandStackConfig {
  return handStackConfigSchema.parse(config);
}

export function configFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): HandStackConfig {
  return defineConfig({
    deployment: {
      profile: deploymentProfileSchema.parse(environment.HANDSTACK_DEPLOYMENT_PROFILE ?? 'compact'),
    },
    database: {
      adapter: databaseAdapterSchema.parse(environment.HANDSTACK_DATABASE_ADAPTER ?? 'sqlite'),
      url: environment.HANDSTACK_DATABASE_URL ?? 'file:./handstack.db',
    },
    queue:
      environment.HANDSTACK_REDIS_URL === undefined
        ? {
            topology: redisTopologySchema.parse(
              environment.HANDSTACK_REDIS_TOPOLOGY ?? 'standalone',
            ),
          }
        : {
            redisUrl: environment.HANDSTACK_REDIS_URL,
            topology: redisTopologySchema.parse(
              environment.HANDSTACK_REDIS_TOPOLOGY ?? 'standalone',
            ),
          },
    notifications: {
      ...(environment.HANDSTACK_NOTIFICATION_SLACK_ENDPOINT === undefined
        ? {}
        : { slackEndpoint: environment.HANDSTACK_NOTIFICATION_SLACK_ENDPOINT }),
      ...(environment.HANDSTACK_NOTIFICATION_TEAMS_ENDPOINT === undefined
        ? {}
        : { teamsEndpoint: environment.HANDSTACK_NOTIFICATION_TEAMS_ENDPOINT }),
      ...(environment.HANDSTACK_NOTIFICATION_DISCORD_ENDPOINT === undefined
        ? {}
        : { discordEndpoint: environment.HANDSTACK_NOTIFICATION_DISCORD_ENDPOINT }),
    },
    server: {
      apiPort: parsePort(environment.HANDSTACK_API_PORT, 3001),
      webPort: parsePort(environment.HANDSTACK_WEB_PORT, 3000),
    },
    telemetry: { enabled: environment.HANDSTACK_TELEMETRY_ENABLED === 'true' },
  });
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid port: ${value}`);
  return parsed;
}
