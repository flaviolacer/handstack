import { describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { IdentityAdministrationService } from '@handstack/identity-service';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { createApplication } from '../src/main.js';
import { NotificationRuntimeService } from '../src/notifications/notification-runtime.service.js';
import { InProcessEventBus } from '@handstack/core';

describe('NotificationRuntimeService', () => {
  it('publishes a sanitized domain event after delivery', async () => {
    const bus = new InProcessEventBus();
    const events: unknown[] = [];
    bus.subscribe('notification.sent', (event) => {
      events.push(event);
      return Promise.resolve();
    });
    const runtime = new NotificationRuntimeService(undefined, undefined, undefined, {
      bus,
    } as never);

    await runtime.send(
      {
        id: 'n-event',
        organizationId: 'org-a',
        recipientId: 'user-a',
        channel: 'IN_APP',
        subject: 'Ready',
        body: 'Do not publish this body',
        createdAt: new Date(),
        metadata: { token: 'must-not-leak' },
      },
      {
        requestId: 'req-1',
        traceId: 'trace-1',
        principalId: 'user-a',
        source: 'API',
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'notification.sent',
      organizationId: 'org-a',
      payload: { notificationId: 'n-event', subject: 'Ready' },
      context: {
        requestId: 'req-1',
        traceId: 'trace-1',
        principalId: 'user-a',
        source: 'API',
      },
    });
    expect(JSON.stringify(events[0])).not.toContain('must-not-leak');
    expect(JSON.stringify(events[0])).not.toContain('Do not publish this body');
  });

  it('dispatches and lists tenant-scoped in-app notifications', async () => {
    const runtime = new NotificationRuntimeService();
    await runtime.send({
      id: 'n1',
      organizationId: 'org-a',
      recipientId: 'user-a',
      channel: 'IN_APP',
      subject: 'Ready',
      body: 'Your agent is ready',
      createdAt: new Date(),
    });
    await expect(runtime.list('org-a', 'user-a')).resolves.toHaveLength(1);
    await expect(runtime.list('org-b', 'user-a')).resolves.toHaveLength(0);
  });

  it('registers configured webhook channels and keeps them HTTPS-only', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve('accepted'),
    });
    vi.stubGlobal('fetch', fetcher);
    const runtime = new NotificationRuntimeService({
      config: {
        notifications: { webhookEndpoint: 'https://hooks.example.test/handstack' },
        timeouts: { http: 10_000 },
      },
      adapter: { repository: () => ({}) },
    } as never);

    await runtime.send({
      id: 'n-webhook',
      organizationId: 'org-a',
      recipientId: 'user-a',
      channel: 'WEBHOOK',
      subject: 'Ready',
      body: 'Your agent is ready',
      createdAt: new Date(),
    });

    expect(fetcher).toHaveBeenCalledWith(
      'https://hooks.example.test/handstack',
      expect.objectContaining({ method: 'POST' }),
    );
    vi.unstubAllGlobals();
  });

  it('uses the configured HTTP timeout for outgoing notification webhooks', async () => {
    const database = {
      config: {
        timeouts: { http: 5 },
        notifications: { webhookEndpoint: 'https://hooks.example.test/handstack' },
      },
      adapter: { repository: () => ({}) },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_endpoint: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      ),
    );
    const runtime = new NotificationRuntimeService(database as never);
    try {
      await expect(
        runtime.send({
          id: 'n-webhook-timeout',
          organizationId: 'org-a',
          recipientId: 'user-a',
          channel: 'WEBHOOK',
          subject: 'Ready',
          body: 'Timeout should be five milliseconds',
          createdAt: new Date(),
        }),
      ).rejects.toThrow('timed out');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resolves the configured SMTP password through the tenant-scoped secret broker', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'smtp-message-1' });
    const close = vi.fn();
    const createTransport = vi
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue({ sendMail, close } as never);
    const resolve = vi.fn().mockResolvedValue('smtp-secret-value');
    const users = {
      list: () => Promise.resolve({ items: [{ id: 'recipient-1', email: 'person@example.test' }] }),
    };
    const auth = {
      storage: { forOrganization: () => ({ users }) },
    };
    const database = {
      config: {
        timeouts: { http: 10_000 },
        notifications: {
          smtp: {
            host: 'smtp.example.test',
            port: 587,
            secure: false,
            username: 'mailer',
            passwordRef: 'secret://smtp-password',
            from: 'noreply@example.test',
          },
        },
      },
      adapter: { repository: () => ({}) },
    };
    const runtime = new NotificationRuntimeService(
      database as never,
      auth as never,
      { resolve } as never,
    );
    try {
      await runtime.send({
        id: 'smtp-notification-1',
        organizationId: 'org-smtp',
        recipientId: 'recipient-1',
        channel: 'EMAIL',
        subject: 'Notification',
        body: 'Secret-backed delivery',
        createdAt: new Date(),
      });
      expect(resolve).toHaveBeenCalledWith('secret://smtp-password', 'org-smtp', 'system');
      expect(createTransport).toHaveBeenCalledWith({
        host: 'smtp.example.test',
        port: 587,
        secure: false,
        auth: { user: 'mailer', pass: 'smtp-secret-value' },
      });
      expect(sendMail).toHaveBeenCalledWith({
        from: 'noreply@example.test',
        to: 'person@example.test',
        subject: 'Notification',
        text: 'Secret-backed delivery',
      });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      createTransport.mockRestore();
    }
  });

  it('wires database, identity and broker dependencies into the Nest notification provider', async () => {
    const environmentKeys = [
      'HANDSTACK_DATABASE_ADAPTER',
      'HANDSTACK_DATABASE_URL',
      'HANDSTACK_ACCESS_TOKEN_SECRET',
      'HANDSTACK_TOKEN_PEPPER',
      'HANDSTACK_SMTP_HOST',
      'HANDSTACK_SMTP_PORT',
      'HANDSTACK_SMTP_SECURE',
      'HANDSTACK_SMTP_USERNAME',
      'HANDSTACK_SMTP_PASSWORD_REF',
      'HANDSTACK_SMTP_FROM',
      'HANDSTACK_SECRET_SMTP_PASSWORD',
      'HANDSTACK_LOG_LEVEL',
    ] as const;
    const previous = new Map(environmentKeys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      HANDSTACK_DATABASE_ADAPTER: 'sqlite',
      HANDSTACK_DATABASE_URL: 'file::memory:',
      HANDSTACK_ACCESS_TOKEN_SECRET: 'notification-access-secret-at-least-32-characters',
      HANDSTACK_TOKEN_PEPPER: 'notification-token-pepper-at-least-32-characters',
      HANDSTACK_SMTP_HOST: 'smtp.example.test',
      HANDSTACK_SMTP_PORT: '587',
      HANDSTACK_SMTP_SECURE: 'false',
      HANDSTACK_SMTP_USERNAME: 'mailer',
      HANDSTACK_SMTP_PASSWORD_REF: 'env://HANDSTACK_SECRET_SMTP_PASSWORD',
      HANDSTACK_SMTP_FROM: 'noreply@example.test',
      HANDSTACK_SECRET_SMTP_PASSWORD: 'broker-resolved-password',
      HANDSTACK_LOG_LEVEL: 'error',
    });
    let app: NestFastifyApplication | undefined;
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'smtp-message-2' });
    const close = vi.fn();
    const createTransport = vi
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue({ sendMail, close } as never);
    try {
      app = await createApplication();
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      const auth = app.get(AuthRuntimeService);
      const identity = new IdentityAdministrationService(auth.storage);
      await identity.createOrganization({ id: 'org-notification-di', name: 'Mail', slug: 'mail' });
      await identity.createUser('org-notification-di', {
        id: 'mail-recipient',
        username: 'mail.recipient',
        displayName: 'Mail Recipient',
        email: 'recipient@example.test',
      });
      await app.get(NotificationRuntimeService).send({
        id: 'smtp-notification-di',
        organizationId: 'org-notification-di',
        recipientId: 'mail-recipient',
        channel: 'EMAIL',
        subject: 'DI check',
        body: 'Broker-backed SMTP',
        createdAt: new Date(),
      });
      expect(sendMail).toHaveBeenCalledWith({
        from: 'noreply@example.test',
        to: 'recipient@example.test',
        subject: 'DI check',
        text: 'Broker-backed SMTP',
      });
      expect(createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ auth: { user: 'mailer', pass: 'broker-resolved-password' } }),
      );
    } finally {
      await app?.close();
      createTransport.mockRestore();
      for (const key of environmentKeys) {
        const value = previous.get(key);
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });
});
