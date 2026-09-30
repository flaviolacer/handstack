import { ValidationError } from '@handstack/shared';
import {
  repositoryName,
  type Repository,
  type RepositoryName,
  type TenantEntity,
} from '@handstack/domain';

export type NotificationChannel = 'IN_APP' | 'EMAIL' | 'WEBHOOK' | 'SLACK' | 'TEAMS' | 'DISCORD';

export interface Notification {
  readonly id: string;
  readonly organizationId: string;
  readonly recipientId: string;
  readonly channel: NotificationChannel;
  readonly subject: string;
  readonly body: string;
  readonly createdAt: Date;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface NotificationProvider {
  readonly channel: NotificationChannel;
  send(notification: Notification): Promise<void>;
}

export interface NotificationStore {
  append(notification: Notification): Promise<void>;
  list(organizationId: string, recipientId: string): Promise<readonly Notification[]>;
}

interface NotificationEntity extends TenantEntity {
  readonly notification: Notification;
}

export class RepositoryNotificationStore implements NotificationStore {
  private readonly repository: Repository<NotificationEntity>;
  constructor(factory: <T extends TenantEntity>(name: RepositoryName) => Repository<T>) {
    this.repository = factory<NotificationEntity>(repositoryName('notifications'));
  }
  async append(notification: Notification): Promise<void> {
    validate(notification);
    if (
      (await this.repository.findById(notification.organizationId, notification.id)) !== undefined
    )
      return;
    const now = new Date(notification.createdAt);
    await this.repository.insert({
      id: notification.id,
      tenantId: notification.organizationId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      notification: clone(notification),
    });
  }
  async list(organizationId: string, recipientId: string): Promise<readonly Notification[]> {
    const values: Notification[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.repository.list(organizationId, {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      values.push(
        ...page.items
          .filter((item) => item.notification.recipientId === recipientId)
          .map((item) => clone(item.notification)),
      );
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return values;
  }
}

export class InMemoryNotificationStore implements NotificationStore {
  private readonly values: Notification[] = [];
  append(notification: Notification): Promise<void> {
    validate(notification);
    if (
      this.values.some(
        (item) =>
          item.id === notification.id && item.organizationId === notification.organizationId,
      )
    )
      return Promise.resolve();
    this.values.push(clone(notification));
    return Promise.resolve();
  }
  list(organizationId: string, recipientId: string): Promise<readonly Notification[]> {
    return Promise.resolve(
      this.values
        .filter(
          (item) => item.organizationId === organizationId && item.recipientId === recipientId,
        )
        .map(clone),
    );
  }
}

export class InAppNotificationProvider implements NotificationProvider {
  readonly channel = 'IN_APP' as const;
  constructor(private readonly store: NotificationStore) {}
  send(notification: Notification): Promise<void> {
    return this.store.append(notification);
  }
}

export interface SmtpTransport {
  send(input: {
    readonly organizationId?: string;
    readonly to: string;
    readonly subject: string;
    readonly text: string;
  }): Promise<void>;
}

export class SmtpNotificationProvider implements NotificationProvider {
  readonly channel = 'EMAIL' as const;
  constructor(
    private readonly transport: SmtpTransport,
    private readonly resolveRecipient: (
      recipientId: string,
      organizationId: string,
    ) => Promise<string>,
  ) {}
  async send(notification: Notification): Promise<void> {
    validate(notification);
    await this.transport.send({
      organizationId: notification.organizationId,
      to: await this.resolveRecipient(notification.recipientId, notification.organizationId),
      subject: notification.subject,
      text: notification.body,
    });
  }
}

export interface NotificationWebhookTransport {
  send(input: {
    readonly endpoint: string;
    readonly body: string;
    readonly headers: Readonly<Record<string, string>>;
  }): Promise<void>;
}

export interface NotificationHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  text(): Promise<string>;
}

export type NotificationHttpFetcher = (
  input: string,
  init: {
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<NotificationHttpResponse>;

/** Minimal production transport; credentials and endpoint selection stay outside this package. */
export class FetchNotificationWebhookTransport implements NotificationWebhookTransport {
  private readonly fetcher: NotificationHttpFetcher;
  private readonly timeoutMs: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;

  constructor(
    options: {
      readonly fetcher?: NotificationHttpFetcher;
      readonly timeoutMs?: number;
      readonly maxRequestBytes?: number;
      readonly maxResponseBytes?: number;
    } = {},
  ) {
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRequestBytes = options.maxRequestBytes ?? 1_000_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 64_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 86_400_000)
      throw new ValidationError('Notification HTTP timeout is invalid');
    if (
      !Number.isInteger(this.maxRequestBytes) ||
      this.maxRequestBytes < 1 ||
      this.maxRequestBytes > 10_000_000
    )
      throw new ValidationError('Notification HTTP request limit is invalid');
    if (
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1 ||
      this.maxResponseBytes > 1_000_000
    )
      throw new ValidationError('Notification HTTP response limit is invalid');
  }

  async send(input: {
    readonly endpoint: string;
    readonly body: string;
    readonly headers: Readonly<Record<string, string>>;
  }): Promise<void> {
    assertHttps(input.endpoint);
    if (new TextEncoder().encode(input.body).byteLength > this.maxRequestBytes)
      throw new ValidationError('Notification HTTP request exceeds limit');
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetcher(input.endpoint, {
        method: 'POST',
        headers: input.headers,
        body: input.body,
        signal: controller.signal,
      });
      const responseText = await response.text();
      if (new TextEncoder().encode(responseText).byteLength > this.maxResponseBytes)
        throw new ValidationError('Notification HTTP response exceeds limit');
      if (!response.ok)
        throw new ValidationError(
          `Notification HTTP delivery failed: ${String(response.status)} ${response.statusText}`,
        );
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      if (controller.signal.aborted)
        throw new ValidationError('Notification HTTP delivery timed out');
      throw new ValidationError(
        `Notification HTTP delivery failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export class WebhookNotificationProvider implements NotificationProvider {
  readonly channel = 'WEBHOOK' as const;
  constructor(
    private readonly transport: NotificationWebhookTransport,
    private readonly resolveEndpoint: (recipientId: string) => Promise<string>,
  ) {}
  async send(notification: Notification): Promise<void> {
    validate(notification);
    const endpoint = await this.resolveEndpoint(notification.recipientId);
    assertHttps(endpoint);
    const body = JSON.stringify({
      id: notification.id,
      organizationId: notification.organizationId,
      subject: notification.subject,
      body: notification.body,
      createdAt: notification.createdAt.toISOString(),
    });
    await this.transport.send({ endpoint, body, headers: { 'content-type': 'application/json' } });
  }
}

export class SlackNotificationProvider implements NotificationProvider {
  readonly channel = 'SLACK' as const;
  constructor(
    private readonly transport: NotificationWebhookTransport,
    private readonly resolveEndpoint: (recipientId: string) => Promise<string>,
  ) {}
  async send(notification: Notification): Promise<void> {
    validate(notification);
    const endpoint = await this.resolveEndpoint(notification.recipientId);
    assertHttps(endpoint);
    await this.transport.send({
      endpoint,
      body: JSON.stringify({ text: `*${notification.subject}*\n${notification.body}` }),
      headers: { 'content-type': 'application/json' },
    });
  }
}

export class TeamsNotificationProvider implements NotificationProvider {
  readonly channel = 'TEAMS' as const;
  constructor(
    private readonly transport: NotificationWebhookTransport,
    private readonly resolveEndpoint: (recipientId: string) => Promise<string>,
  ) {}
  async send(notification: Notification): Promise<void> {
    validate(notification);
    const endpoint = await this.resolveEndpoint(notification.recipientId);
    assertHttps(endpoint);
    await this.transport.send({
      endpoint,
      body: JSON.stringify({
        '@type': 'MessageCard',
        summary: notification.subject,
        text: notification.body,
      }),
      headers: { 'content-type': 'application/json' },
    });
  }
}

export class DiscordNotificationProvider implements NotificationProvider {
  readonly channel = 'DISCORD' as const;
  constructor(
    private readonly transport: NotificationWebhookTransport,
    private readonly resolveEndpoint: (recipientId: string) => Promise<string>,
  ) {}
  async send(notification: Notification): Promise<void> {
    validate(notification);
    const endpoint = await this.resolveEndpoint(notification.recipientId);
    assertHttps(endpoint);
    await this.transport.send({
      endpoint,
      body: JSON.stringify({ content: `**${notification.subject}**\n${notification.body}` }),
      headers: { 'content-type': 'application/json' },
    });
  }
}

export class NotificationDispatcher {
  private readonly providers = new Map<NotificationChannel, NotificationProvider>();
  constructor(providers: readonly NotificationProvider[]) {
    for (const provider of providers) {
      if (this.providers.has(provider.channel))
        throw new ValidationError(`Duplicate notification provider: ${provider.channel}`);
      this.providers.set(provider.channel, provider);
    }
  }
  async send(notification: Notification): Promise<void> {
    validate(notification);
    const provider = this.providers.get(notification.channel);
    if (provider === undefined)
      throw new ValidationError(`Notification channel is not configured: ${notification.channel}`);
    if (provider.channel !== notification.channel)
      throw new ValidationError(`Notification provider channel mismatch: ${provider.channel}`);
    await provider.send(notification);
  }
}

function validate(notification: Notification): void {
  if (
    notification.id === '' ||
    notification.organizationId === '' ||
    notification.recipientId === ''
  )
    throw new ValidationError('Notification identity is required');
  if (notification.subject.length > 500 || notification.body.length > 1_000_000)
    throw new ValidationError('Notification content exceeds limits');
}

function assertHttps(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ValidationError('Notification endpoint must be a valid URL');
  }
  if (url.protocol !== 'https:') throw new ValidationError('Notification endpoint must use HTTPS');
}

function clone(notification: Notification): Notification {
  return {
    ...notification,
    createdAt: new Date(notification.createdAt),
    ...(notification.metadata === undefined ? {} : { metadata: { ...notification.metadata } }),
  };
}
