import { Injectable } from '@nestjs/common';
import { InMemoryFeatureFlagService } from '@handstack/feature-flags';
import { ValidationError } from '@handstack/shared';
import {
  DistributedJobQueue,
  InMemoryJobQueue,
  RepositoryJobTransport,
  InMemoryOperationStore,
  RepositoryOperationStore,
  type Operation,
  type OperationStore,
  type JobQueueName,
} from '@handstack/jobs';
import { AuditRuntimeService } from '../audit/audit-runtime.service.js';
import { DatabaseService } from '../database/database.service.js';

@Injectable()
export class OperationsRuntimeService {
  readonly flags = new InMemoryFeatureFlagService();
  readonly audit: AuditRuntimeService;
  readonly operations: OperationStore;
  private readonly queues = new Map<
    string,
    InMemoryJobQueue<unknown> | DistributedJobQueue<unknown>
  >();

  constructor(
    audit?: AuditRuntimeService,
    private readonly database?: DatabaseService,
  ) {
    this.audit = audit ?? new AuditRuntimeService();
    this.operations =
      database === undefined
        ? new InMemoryOperationStore()
        : new RepositoryOperationStore((repositoryName) =>
            database.adapter.repository(repositoryName),
          );
  }

  async createOperation(input: {
    organizationId: string;
    type: string;
    idempotencyKey: string;
    result?: unknown;
  }) {
    const idempotencyKey = input.idempotencyKey.trim();
    if (idempotencyKey === '') throw new ValidationError('Idempotency key is required');
    const normalized = { ...input, idempotencyKey };
    return this.operations.create(normalized);
  }

  getOperation(organizationId: string, id: string): Promise<Operation | undefined> {
    return this.operations.get(organizationId, id);
  }

  queue(
    name: JobQueueName,
    organizationId = 'default',
  ): InMemoryJobQueue<unknown> | DistributedJobQueue<unknown> {
    const key = `${organizationId}:${name}`;
    let queue = this.queues.get(key);
    if (queue === undefined) {
      const database = this.database;
      queue =
        database === undefined
          ? new InMemoryJobQueue(name)
          : new DistributedJobQueue(
              name,
              new RepositoryJobTransport(
                (repositoryName) => database.adapter.repository(repositoryName),
                organizationId,
              ),
            );
      this.queues.set(key, queue);
    }
    return queue;
  }
}
