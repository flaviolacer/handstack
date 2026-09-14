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

@Injectable()
export class WebhookRuntimeService {
  private readonly store: WebhookDeliveryStore;
  private readonly endpointStore: WebhookEndpointStore;
  private readonly secretProvider: WebhookSecretProvider;
  private readonly configurations = new Map<
    string,
    { endpoint: string; secret: string; source?: string; dispatcher: WebhookDispatcher }
  >();
  private readonly allowedEndpointHosts = (process.env.HANDSTACK_WEBHOOK_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    audit?: AuditRuntimeService,
  ) {
    this.store = new RepositoryWebhookDeliveryStore((name) =>
      this.database.adapter.repository(name),
    );
    this.endpointStore = new RepositoryWebhookEndpointStore((name) =>
      this.database.adapter.repository(name),
    );
    const masterKey = process.env.HANDSTACK_WEBHOOK_MASTER_KEY;
    if (masterKey === undefined && process.env.NODE_ENV === 'production') {
      throw new Error('HANDSTACK_WEBHOOK_MASTER_KEY is required in production');
    }
    this.secretProvider =
      masterKey === undefined
        ? new InMemoryWebhookSecretProvider()
        : new RepositoryWebhookSecretProvider(
            (name) => this.database.adapter.repository(name),
            masterKey,
          );
    this.audit = audit?.webhook;
  }

  private readonly audit: AuditRuntimeService['webhook'] | undefined;

  createDispatcher(options: Omit<WebhookDispatcherOptions, 'store'>): WebhookDispatcher {
    return new WebhookDispatcher({
      ...options,
      store: this.store,
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
    const dispatcher = this.createDispatcher({
      secret: secretSet.current,
      keyId: secretSet.keyId,
      ...(source === undefined ? {} : { source }),
      ...(this.allowedEndpointHosts.length === 0
        ? {}
        : { allowedEndpointHosts: this.allowedEndpointHosts }),
      transport: transport ?? new FetchWebhookTransport(),
    });
    this.configurations.set(organizationId, {
      endpoint,
      secret: secretSet.current,
      ...(source === undefined ? {} : { source }),
      dispatcher,
    });
  }

  async dispatch(input: {
    organizationId: string;
    id: string;
    event: WebhookEvent;
    payload: unknown;
  }): Promise<WebhookDelivery> {
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
        transport: new FetchWebhookTransport(),
      });
      configuration = {
        endpoint: endpoint.endpoint,
        secret: secretSet.current,
        ...(endpoint.source === undefined ? {} : { source: endpoint.source }),
        dispatcher,
      };
      this.configurations.set(input.organizationId, configuration);
    }
    return await configuration.dispatcher.dispatch({
      ...input,
      endpoint: configuration.endpoint,
      ...(configuration.source === undefined ? {} : { source: configuration.source }),
    });
  }

  async deadLetters(organizationId: string): Promise<readonly WebhookDelivery[]> {
    return await this.store.listDeadLettered(organizationId);
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
      await this.configure(
        organizationId,
        configuration.endpoint,
        rotated.current,
        configuration.source,
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
  async send(input: {
    readonly endpoint: string;
    readonly body: string;
    readonly signature: string;
  }): Promise<void> {
    const response = await fetch(input.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-handstack-signature': input.signature },
      body: input.body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Webhook endpoint returned HTTP ${String(response.status)}`);
  }
}
