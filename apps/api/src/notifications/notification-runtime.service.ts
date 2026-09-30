import { Inject, Injectable, Optional } from '@nestjs/common';
import nodemailer from 'nodemailer';
import {
  InAppNotificationProvider,
  InMemoryNotificationStore,
  NotificationDispatcher,
  RepositoryNotificationStore,
  FetchNotificationWebhookTransport,
  SlackNotificationProvider,
  TeamsNotificationProvider,
  DiscordNotificationProvider,
  SmtpNotificationProvider,
  WebhookNotificationProvider,
  type NotificationProvider,
  type Notification,
  type NotificationStore,
} from '@handstack/notifications';
import { DatabaseService } from '../database/database.service.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import { SecretRuntimeService } from '../secrets/secret-runtime.service.js';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { EventBusRuntimeService } from '../core/event-bus-runtime.service.js';
import { publishRuntimeDomainEvent } from '../core/runtime-domain-event.js';
import type { DomainEventContext } from '@handstack/core';

@Injectable()
export class NotificationRuntimeService {
  private readonly store: NotificationStore;
  private readonly dispatcher: NotificationDispatcher;

  constructor(
    @Optional() @Inject(DatabaseService) database?: DatabaseService,
    @Optional() @Inject(AuthRuntimeService) auth?: AuthRuntimeService,
    @Optional() @Inject(SecretRuntimeService) secrets?: SecretRuntimeService,
    @Optional() @Inject(EventBusRuntimeService) eventBus?: EventBusRuntimeService,
  ) {
    this.eventBus = eventBus?.bus;
    this.store =
      database === undefined
        ? new InMemoryNotificationStore()
        : new RepositoryNotificationStore((name) => database.adapter.repository(name));
    const providers: NotificationProvider[] = [new InAppNotificationProvider(this.store)];
    const endpoints = database?.config.notifications;
    const transport = new FetchNotificationWebhookTransport({
      timeoutMs: database?.config.timeouts.http ?? 10_000,
    });
    const fixedEndpoint = (endpoint: string) => (): Promise<string> => Promise.resolve(endpoint);
    if (endpoints?.webhookEndpoint !== undefined)
      providers.push(
        new WebhookNotificationProvider(transport, fixedEndpoint(endpoints.webhookEndpoint)),
      );
    if (endpoints?.slackEndpoint !== undefined)
      providers.push(
        new SlackNotificationProvider(transport, fixedEndpoint(endpoints.slackEndpoint)),
      );
    if (endpoints?.teamsEndpoint !== undefined)
      providers.push(
        new TeamsNotificationProvider(transport, fixedEndpoint(endpoints.teamsEndpoint)),
      );
    if (endpoints?.discordEndpoint !== undefined)
      providers.push(
        new DiscordNotificationProvider(transport, fixedEndpoint(endpoints.discordEndpoint)),
      );
    const smtp = endpoints?.smtp;
    if (smtp !== undefined && auth !== undefined && secrets !== undefined) {
      const administration = new IdentityAdministrationService(auth.storage);
      providers.push(
        new SmtpNotificationProvider(
          {
            send: async ({ organizationId, to, subject, text }) => {
              if (organizationId === undefined)
                throw new Error('SMTP organization context is required');
              const password = await secrets.resolve(smtp.passwordRef, organizationId, 'system');
              if (password === undefined) throw new Error('SMTP password secret is unavailable');
              const mailer = nodemailer.createTransport({
                host: smtp.host,
                port: smtp.port,
                secure: smtp.secure,
                auth: { user: smtp.username, pass: password },
              });
              await mailer.sendMail({ from: smtp.from, to, subject, text });
              mailer.close();
            },
          },
          async (recipientId, organizationId) => {
            const user = (await administration.listUsers(organizationId)).find(
              (candidate) => candidate.id === recipientId,
            );
            if (user?.email === undefined) throw new Error('Notification recipient has no email');
            return user.email;
          },
        ),
      );
    }
    this.dispatcher = new NotificationDispatcher(providers);
  }

  private readonly eventBus: EventBusRuntimeService['bus'] | undefined;

  async send(notification: Notification, context?: DomainEventContext): Promise<void> {
    await this.dispatcher.send(notification);
    await publishRuntimeDomainEvent(this.eventBus, {
      organizationId: notification.organizationId,
      type: 'notification.sent',
      payload: {
        notificationId: notification.id,
        recipientId: notification.recipientId,
        channel: notification.channel,
        subject: notification.subject,
      },
      ...(context === undefined ? {} : { context }),
    });
  }

  list(organizationId: string, recipientId: string): Promise<readonly Notification[]> {
    return this.store.list(organizationId, recipientId);
  }
}
