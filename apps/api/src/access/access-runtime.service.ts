import { Injectable } from '@nestjs/common';
import {
  DurableAccessService,
  InMemoryAccessService,
  InMemoryNotificationProvider,
  RepositoryAccessStore,
} from '@handstack/access';
import { DatabaseService } from '../database/database.service.js';

@Injectable()
export class AccessRuntimeService {
  readonly notifications = new InMemoryNotificationProvider();
  readonly access: InMemoryAccessService | DurableAccessService;
  constructor(database?: DatabaseService) {
    this.access =
      database === undefined
        ? new InMemoryAccessService(this.notifications)
        : new DurableAccessService(
            new RepositoryAccessStore((name) => database.adapter.repository(name)),
            this.notifications,
          );
  }
}
