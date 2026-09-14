import { describe, expect, it } from 'vitest';
import {
  DiscordNotificationProvider,
  FetchNotificationWebhookTransport,
  InAppNotificationProvider,
  InMemoryNotificationStore,
  NotificationDispatcher,
  RepositoryNotificationStore,
  SlackNotificationProvider,
  SmtpNotificationProvider,
  TeamsNotificationProvider,
  WebhookNotificationProvider,
  type Notification,
} from '../src/index.js';
import type {
  Page,
  PageRequest,
  Repository,
  RepositoryName,
  TenantEntity,
} from '@handstack/domain';

const notification: Notification = {
  id: 'n1',
  organizationId: 'org-a',
  recipientId: 'user-a',
  channel: 'IN_APP',
  subject: 'Hello',
  body: 'Welcome',
  createdAt: new Date(),
};

describe('notifications', () => {
  it('stores in-app notifications tenant and recipient scoped with idempotency', async () => {
    const store = new InMemoryNotificationStore();
    const dispatcher = new NotificationDispatcher([new InAppNotificationProvider(store)]);
    await dispatcher.send(notification);
    await dispatcher.send(notification);
    await expect(store.list('org-a', 'user-a')).resolves.toHaveLength(1);
    await expect(store.list('org-b', 'user-a')).resolves.toHaveLength(0);
  });
  it('routes SMTP and webhook providers through narrow transports', async () => {
    let email = '';
    let webhook = '';
    const dispatcher = new NotificationDispatcher([
      new SmtpNotificationProvider(
        {
          send: ({ to }) => {
            email = to;
            return Promise.resolve();
          },
        },
        () => Promise.resolve('user@example.test'),
      ),
      new WebhookNotificationProvider(
        {
          send: ({ body }) => {
            webhook = body;
            return Promise.resolve();
          },
        },
        () => Promise.resolve('https://example.test/hook'),
      ),
    ]);
    await dispatcher.send({ ...notification, id: 'email', channel: 'EMAIL' });
    await dispatcher.send({ ...notification, id: 'hook', channel: 'WEBHOOK' });
    expect(email).toBe('user@example.test');
    expect(webhook).toContain('"organizationId":"org-a"');
  });
  it('resolves webhook endpoint once per delivery', async () => {
    let resolutions = 0;
    let deliveredEndpoint = '';
    const provider = new WebhookNotificationProvider(
      {
        send: ({ endpoint }) => {
          deliveredEndpoint = endpoint;
          return Promise.resolve();
        },
      },
      () => {
        resolutions += 1;
        return Promise.resolve(`https://hooks.example.test/${String(resolutions)}`);
      },
    );
    await provider.send({ ...notification, id: 'single-resolution', channel: 'WEBHOOK' });
    expect(resolutions).toBe(1);
    expect(deliveredEndpoint).toBe('https://hooks.example.test/1');
  });
  it('round-trips notifications through a tenant repository', async () => {
    const repository = new NotificationRepository();
    const factory = (() => repository) as <T extends TenantEntity>(
      name: RepositoryName,
    ) => Repository<T>;
    const store = new RepositoryNotificationStore(factory);
    await store.append(notification);
    await store.append(notification);
    await expect(store.list('org-a', 'user-a')).resolves.toHaveLength(1);
    await expect(store.list('org-a', 'user-b')).resolves.toHaveLength(0);
  });
  it('routes Slack, Teams and Discord payloads only to HTTPS endpoints', async () => {
    const bodies: string[] = [];
    const transport = {
      send: ({ body }: { readonly body: string }) => {
        bodies.push(body);
        return Promise.resolve();
      },
    };
    const dispatcher = new NotificationDispatcher([
      new SlackNotificationProvider(transport, () =>
        Promise.resolve('https://hooks.example.test/slack'),
      ),
      new TeamsNotificationProvider(transport, () =>
        Promise.resolve('https://hooks.example.test/teams'),
      ),
      new DiscordNotificationProvider(transport, () =>
        Promise.resolve('https://hooks.example.test/discord'),
      ),
    ]);
    await dispatcher.send({ ...notification, id: 'slack', channel: 'SLACK' });
    await dispatcher.send({ ...notification, id: 'teams', channel: 'TEAMS' });
    await dispatcher.send({ ...notification, id: 'discord', channel: 'DISCORD' });
    expect(bodies).toHaveLength(3);
    await expect(
      new SlackNotificationProvider(transport, () => Promise.resolve('http://localhost/hook')).send(
        { ...notification, id: 'bad', channel: 'SLACK' },
      ),
    ).rejects.toThrow('HTTPS');
  });
  it('sends webhook payloads through fetch and rejects non-success responses', async () => {
    let request: { readonly endpoint: string; readonly body: string } | undefined;
    const transport = new FetchNotificationWebhookTransport({
      fetcher: (endpoint, init) => {
        request = { endpoint, body: init.body };
        return Promise.resolve({
          ok: true,
          status: 204,
          statusText: 'No Content',
          text: () => Promise.resolve(''),
        });
      },
    });
    await transport.send({
      endpoint: 'https://hooks.example.test/1',
      body: '{"ok":true}',
      headers: { 'content-type': 'application/json' },
    });
    expect(request).toEqual({ endpoint: 'https://hooks.example.test/1', body: '{"ok":true}' });
    const failing = new FetchNotificationWebhookTransport({
      fetcher: () =>
        Promise.resolve({
          ok: false,
          status: 503,
          statusText: 'Unavailable',
          text: () => Promise.resolve('retry'),
        }),
    });
    await expect(
      failing.send({ endpoint: 'https://hooks.example.test/1', body: '{}', headers: {} }),
    ).rejects.toThrow('503');
    await expect(
      transport.send({ endpoint: 'http://hooks.example.test/1', body: '{}', headers: {} }),
    ).rejects.toThrow('HTTPS');
    const oversized = new FetchNotificationWebhookTransport({
      maxResponseBytes: 2,
      fetcher: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          text: () => Promise.resolve('too large'),
        }),
    });
    await expect(
      oversized.send({ endpoint: 'https://hooks.example.test/1', body: '{}', headers: {} }),
    ).rejects.toThrow('response exceeds limit');
    let called = false;
    const requestLimited = new FetchNotificationWebhookTransport({
      maxRequestBytes: 2,
      fetcher: () => {
        called = true;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          text: () => Promise.resolve(''),
        });
      },
    });
    await expect(
      requestLimited.send({ endpoint: 'https://hooks.example.test/1', body: '123', headers: {} }),
    ).rejects.toThrow('request exceeds limit');
    expect(called).toBe(false);
    const timedOut = new FetchNotificationWebhookTransport({
      timeoutMs: 5,
      fetcher: (_endpoint, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    });
    await expect(
      timedOut.send({ endpoint: 'https://hooks.example.test/1', body: '{}', headers: {} }),
    ).rejects.toThrow('timed out');
  });
});

interface StoredNotification extends TenantEntity {
  readonly notification: Notification;
}
class NotificationRepository implements Repository<StoredNotification> {
  private readonly values = new Map<string, StoredNotification>();
  findById(tenantId: string, id: string) {
    return Promise.resolve(this.values.get(`${tenantId}:${id}`));
  }
  list(tenantId: string, page: PageRequest): Promise<Page<StoredNotification>> {
    const values = [...this.values.values()]
      .filter((item) => item.tenantId === tenantId)
      .sort((a, b) => a.id.localeCompare(b.id));
    const start =
      page.cursor === undefined ? 0 : values.findIndex((item) => item.id === page.cursor) + 1;
    const items = values.slice(start, start + page.limit);
    const last = items.at(-1);
    return Promise.resolve({
      items,
      ...(start + page.limit < values.length && last !== undefined ? { nextCursor: last.id } : {}),
    });
  }
  insert(entity: StoredNotification) {
    this.values.set(`${entity.tenantId}:${entity.id}`, entity);
    return Promise.resolve(entity);
  }
  update(): Promise<StoredNotification> {
    return Promise.reject(new Error('append-only'));
  }
  delete(): Promise<boolean> {
    return Promise.reject(new Error('append-only'));
  }
}
