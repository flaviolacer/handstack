import { Injectable } from '@nestjs/common';
import {
  InAppNotificationProvider,
  InMemoryNotificationStore,
  NotificationDispatcher,
  RepositoryNotificationStore,
  type Notification,
  type NotificationStore,
} from '@handstack/notifications';
import { DatabaseService } from '../database/database.service.js';

@Injectable()
export class NotificationRuntimeService {
  private readonly store: NotificationStore;
  private readonly dispatcher: NotificationDispatcher;

  constructor(database?: DatabaseService) {
    this.store =
      database === undefined
        ? new InMemoryNotificationStore()
        : new RepositoryNotificationStore((name) => database.adapter.repository(name));
    this.dispatcher = new NotificationDispatcher([new InAppNotificationProvider(this.store)]);
  }

  send(notification: Notification): Promise<void> {
    return this.dispatcher.send(notification);
  }

  list(organizationId: string, recipientId: string): Promise<readonly Notification[]> {
    return this.store.list(organizationId, recipientId);
  }
}
