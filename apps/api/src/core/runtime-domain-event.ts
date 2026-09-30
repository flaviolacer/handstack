import { randomUUID } from 'node:crypto';
import type { DomainEvent, DomainEventContext, EventBus } from '@handstack/core';

export async function publishRuntimeDomainEvent(
  bus: EventBus | undefined,
  input: {
    organizationId: string;
    type: string;
    payload: Readonly<Record<string, unknown>>;
    correlationId?: string;
    context?: DomainEventContext;
  },
): Promise<void> {
  if (bus === undefined) return;
  const id = randomUUID();
  const event: DomainEvent = {
    id,
    type: input.type,
    schemaVersion: 1,
    organizationId: input.organizationId,
    timestamp: new Date().toISOString(),
    correlationId: input.correlationId ?? id,
    idempotencyKey: `${input.type}:${input.organizationId}:${id}`,
    ...(input.context === undefined ? {} : { context: input.context }),
    payload: input.payload,
  };
  await bus.publish(event);
}
