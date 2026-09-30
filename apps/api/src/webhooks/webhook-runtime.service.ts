import { Inject, Injectable } from '@nestjs/common';
import {
  InMemoryWebhookSecretProvider,
  RepositoryWebhookEndpointStore,
  RepositoryWebhookSecretProvider,
  WebhookDispatcher,
  RepositoryWebhookDeliveryStore,
  type WebhookDelivery,
  type WebhookDeliveryStore,
  type WebhookDispatcherOptions,
  type WebhookEndpointStore,
  type WebhookEvent,
  type WebhookSecretProvider,
  type WebhookTransport,
} from '@handstack/webhooks';
import { DatabaseService } from '../database/database.service.js';
import { AuditRuntimeService } from '../audit/audit-runtime.service.js';
import { MasterKey } from '@handstack/core';
import { EventBusRuntimeService } from '../core/event-bus-runtime.service.js';
import { publishRuntimeDomainEvent } from '../core/runtime-domain-event.js';
import type { DomainEventContext } from '@handstack/core';

@Injectable()
export class WebhookRuntimeService {
  private readonly store: WebhookDeliveryStore;
  private readonly endpointStore: WebhookEndpointStore;
  private readonly secretProvider: WebhookSecretProvider;
  private readonly configurations = new Map<
    string,
    {
      endpoint: string;
      secret: string;
      source?: string;
      dispatcher: WebhookDispatcher;
      transport?: WebhookTransport;
    }
  >();
  private readonly allowedEndpointHosts: readonly string[];

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    audit?: AuditRuntimeService,
    eventBus?: EventBusRuntimeService,
  ) {
    this.allowedEndpointHosts = database.config.webhooks.allowedHosts;
    this.eventBus = eventBus?.bus;
    this.store = new RepositoryWebhookDeliveryStore((name) =>
      this.database.adapter.repository(name),
    );
    this.endpointStore = new RepositoryWebhookEndpointStore((name) =>
      this.database.adapter.repository(name),
    );
    const configuredMasterKey = database.config.security.masterKey;
    const masterKey =
      configuredMasterKey === undefined ? undefined : MasterKey.decode(configuredMasterKey);
    const legacyMasterKey = database.config.security.webhookLegacyMasterKey;
    const observeSecretAccess =
      audit === undefined
        ? undefined
        : async ({ organizationId, keyId }: { organizationId: string; keyId: string }) =>
            audit.record({
              organizationId,
              actorId: 'system:webhook-secret-provider',
              actorType: 'SYSTEM',
              action: 'SECRET_ACCESSED',
              resourceType: 'secret',
              resourceId: organizationId,
              metadata: {
                name: 'webhook signing secret',
                pluginId: 'webhook-signing',
                keyId,
                provider: 'repository',
              },
            });
    if (masterKey === undefined && process.env.NODE_ENV === 'production') {
      throw new Error('HANDSTACK_MASTER_KEY is required in production');
    }
    this.secretProvider =
      masterKey === undefined
        ? new InMemoryWebhookSecretProvider()
        : new RepositoryWebhookSecretProvider(
            (name) => this.database.adapter.repository(name),
            masterKey,
            legacyMasterKey,
            observeSecretAccess,
          );
    this.audit = audit?.webhook;
  }

  private readonly audit: AuditRuntimeService['webhook'] | undefined;
  private readonly eventBus: EventBusRuntimeService['bus'] | undefined;

  createDispatcher(options: Omit<WebhookDispatcherOptions, 'store'>): WebhookDispatcher {
    return new WebhookDispatcher({
      ...options,
      store: this.store,
      retentionMs: options.retentionMs ?? this.database.config.retention.audit * 86_400_000,
      ...(this.audit === undefined ? {} : { audit: this.audit }),
    });
  }

  async configure(
    organizationId: string,
    endpoint: string,
    secret: string,
    source?: string,
    transport?: WebhookTransport,
  ): Promise<void> {
    const secretSet = await this.secretProvider.put(organizationId, secret);
    await this.endpointStore.save({
      organizationId,
      endpoint,
      ...(source === undefined ? {} : { source }),
    });
    this.cacheConfiguration(organizationId, endpoint, secretSet, source, transport);
  }

  private cacheConfiguration(
    organizationId: string,
    endpoint: string,
    secretSet: Awaited<ReturnType<WebhookSecretProvider['put']>>,
    source?: string,
    transport?: WebhookTransport,
  ): void {
    const dispatcher = this.createDispatcher({
      secret: secretSet.current,
      keyId: secretSet.keyId,
      ...(source === undefined ? {} : { source }),
      ...(this.allowedEndpointHosts.length === 0
        ? {}
        : { allowedEndpointHosts: this.allowedEndpointHosts }),
      transport: transport ?? new FetchWebhookTransport(() => this.database.config.timeouts.http),
    });
    this.configurations.set(organizationId, {
      endpoint,
      secret: secretSet.current,
      ...(source === undefined ? {} : { source }),
      dispatcher,
      ...(transport === undefined ? {} : { transport }),
    });
  }

  async dispatch(input: {
    organizationId: string;
    id: string;
    event: WebhookEvent;
    payload: unknown;
    context?: DomainEventContext;
  }): Promise<WebhookDelivery> {
    const { context, ...deliveryInput } = input;
    let configuration = this.configurations.get(input.organizationId);
    if (configuration === undefined) {
      const endpoint = await this.endpointStore.get(input.organizationId);
      const secretSet = await this.secretProvider.get(input.organizationId);
      if (endpoint === undefined || secretSet === undefined)
        throw new Error('Webhook endpoint is not configured');
      const dispatcher = this.createDispatcher({
        secret: secretSet.current,
        keyId: secretSet.keyId,
        ...(endpoint.source === undefined ? {} : { source: endpoint.source }),
        ...(this.allowedEndpointHosts.length === 0
          ? {}
          : { allowedEndpointHosts: this.allowedEndpointHosts }),
        transport: new FetchWebhookTransport(() => this.database.config.timeouts.http),
      });
      configuration = {
        endpoint: endpoint.endpoint,
        secret: secretSet.current,
        ...(endpoint.source === undefined ? {} : { source: endpoint.source }),
        dispatcher,
      };
      this.configurations.set(input.organizationId, configuration);
    }
    const delivery = await configuration.dispatcher.dispatch({
      ...deliveryInput,
      endpoint: configuration.endpoint,
      ...(configuration.source === undefined ? {} : { source: configuration.source }),
    });
    await publishRuntimeDomainEvent(this.eventBus, {
      organizationId: input.organizationId,
      type: `webhook.${delivery.status.toLowerCase()}`,
      payload: {
        deliveryId: delivery.id,
        event: delivery.event,
        status: delivery.status,
        attempts: delivery.attempt,
      },
      ...(context === undefined ? {} : { context }),
    });
    return delivery;
  }

  async deadLetters(organizationId: string): Promise<readonly WebhookDelivery[]> {
    return await this.store.listDeadLettered(organizationId);
  }

  /** Prunes tenant deliveries using the configured dispatcher retention window. */
  async prune(organizationId: string): Promise<number> {
    const configuration = this.configurations.get(organizationId);
    if (configuration !== undefined) return await configuration.dispatcher.prune(organizationId);
    const endpoint = await this.endpointStore.get(organizationId);
    const secretSet = await this.secretProvider.get(organizationId);
    if (endpoint === undefined || secretSet === undefined) return 0;
    const dispatcher = this.createDispatcher({
      secret: secretSet.current,
      keyId: secretSet.keyId,
      ...(endpoint.source === undefined ? {} : { source: endpoint.source }),
      ...(this.allowedEndpointHosts.length === 0
        ? {}
        : { allowedEndpointHosts: this.allowedEndpointHosts }),
      transport: new FetchWebhookTransport(() => this.database.config.timeouts.http),
    });
    return await dispatcher.prune(organizationId);
  }

  async deliveries(
    organizationId: string,
    status?: WebhookDelivery['status'],
  ): Promise<readonly WebhookDelivery[]> {
    return await this.store.list(organizationId, status);
  }

  async rotateSecret(
    organizationId: string,
    secret: string,
    keyId?: string,
    overlapMs?: number,
  ): Promise<{ keyId: string; previousKeyId?: string }> {
    const rotated = await this.secretProvider.put(organizationId, secret, keyId, overlapMs);
    const configuration = this.configurations.get(organizationId);
    if (configuration !== undefined) {
      this.cacheConfiguration(
        organizationId,
        configuration.endpoint,
        rotated,
        configuration.source,
        configuration.transport,
      );
    }
    return {
      keyId: rotated.keyId,
      ...(rotated.previous === undefined ? {} : { previousKeyId: rotated.previous.keyId }),
    };
  }

  async replay(organizationId: string, deliveryId: string): Promise<WebhookDelivery> {
    const configuration = this.configurations.get(organizationId);
    if (configuration === undefined) throw new Error('Webhook endpoint is not configured');
    const previous = await this.store.get(deliveryId, organizationId);
    if (previous === undefined) throw new Error('Webhook delivery not found');
    return await configuration.dispatcher.replay({
      id: previous.id,
      organizationId,
      event: previous.event,
      payload: previous.payload,
      endpoint: configuration.endpoint,
      ...(previous.schemaVersion === undefined ? {} : { schemaVersion: previous.schemaVersion }),
      ...(previous.source === undefined ? {} : { source: previous.source }),
      ...(previous.keyId === undefined ? {} : { keyId: previous.keyId }),
    });
  }
}

class FetchWebhookTransport implements WebhookTransport {
  constructor(private readonly timeoutMs: () => number) {}

  async send(input: {
    readonly endpoint: string;
    readonly body: string;
    readonly signature: string;
  }): Promise<void> {
    const response = await fetch(input.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-handstack-signature': input.signature },
      body: input.body,
      signal: AbortSignal.timeout(this.timeoutMs()),
    });
    if (!response.ok) throw new Error(`Webhook endpoint returned HTTP ${String(response.status)}`);
  }
}
