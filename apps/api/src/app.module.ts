import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { HealthController } from './health/health.controller.js';
import { HealthService } from './health/health.service.js';
import { DatabaseService } from './database/database.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AccessTokenGuard } from './auth/access-token.guard.js';
import { AuthRuntimeService } from './auth/auth-runtime.service.js';
import { OidcController } from './auth/oidc.controller.js';
import { OidcRuntimeService } from './auth/oidc-runtime.service.js';
import { IdentityAdminController } from './auth/identity-admin.controller.js';
import { IdentityAdminTelemetryInterceptor } from './auth/identity-admin-telemetry.interceptor.js';
import { ModelAdminController } from './models/model-admin.controller.js';
import { ModelAdminRuntimeService } from './models/model-admin-runtime.service.js';
import { ChatController } from './chat/chat.controller.js';
import { ChatRuntimeService } from './chat/chat-runtime.service.js';
import { BuiltinMalwareScanner, LocalAttachmentStorage } from './chat/attachment-storage.js';
import { AttachmentContentController } from './chat/attachment-content.controller.js';
import { GatewayController } from './gateway/gateway.controller.js';
import { GatewayRuntimeService } from './gateway/gateway-runtime.service.js';
import { OpenAiCompatibleController } from './gateway/openai-compatible.controller.js';
import { BudgetController } from './budgets/budget.controller.js';
import { BudgetRuntimeService } from './budgets/budget-runtime.service.js';
import {
  CapabilityController,
  PublicCapabilityController,
} from './capabilities/capability.controller.js';
import { CapabilityRuntimeService } from './capabilities/capability-runtime.service.js';
import { McpController } from './mcp/mcp.controller.js';
import { PluginRegistryController } from './plugins/plugin-registry.controller.js';
import { PluginRegistryRuntimeService } from './plugins/plugin-registry.runtime.js';
import {
  AsyncOperationsController,
  OperationsController,
} from './operations/operations.controller.js';
import { OperationsRuntimeService } from './operations/operations-runtime.service.js';
import { AgentController, PublicAgentController } from './agents/agent.controller.js';
import { AgentRuntimeService } from './agents/agent-runtime.service.js';
import { WorkflowController } from './workflows/workflow.controller.js';
import { WorkflowRuntimeService } from './workflows/workflow-runtime.service.js';
import { AccessController } from './access/access.controller.js';
import { AccessRuntimeService } from './access/access-runtime.service.js';
import { WebhookRuntimeService } from './webhooks/webhook-runtime.service.js';
import { WebhookController } from './webhooks/webhook.controller.js';
import { AuditRuntimeService } from './audit/audit-runtime.service.js';
import { AuditIntegritySchedulerService } from './audit/audit-integrity-scheduler.service.js';
import { NotificationRuntimeService } from './notifications/notification-runtime.service.js';
import { NotificationController } from './notifications/notification.controller.js';
import { RedisRuntimeService } from './health/redis-runtime.service.js';
import { ApiMetrics } from './observability/api-metrics.js';
import { ApiMetricsInterceptor } from './observability/api-metrics.interceptor.js';
import { MetricsController } from './observability/metrics.controller.js';
import { IncidentController, IncidentStatusController } from './incidents/incident.controller.js';
import { IncidentRuntimeService } from './incidents/incident-runtime.service.js';
import { ScimController } from './scim/scim.controller.js';
import { ScimAdminController } from './scim/scim-admin.controller.js';
import { ScimAuthGuard } from './scim/scim-auth.guard.js';
import { ScimRuntimeService } from './scim/scim-runtime.service.js';
import { SettingsController } from './settings/settings.controller.js';
import { SettingsRuntimeService } from './settings/settings-runtime.service.js';
import { DirectoryController } from './access/directory.controller.js';
import { KnowledgeController } from './knowledge/knowledge.controller.js';
import { KnowledgeWorkerController } from './knowledge/knowledge-worker.controller.js';
import { KnowledgeRuntimeService } from './knowledge/knowledge-runtime.service.js';
import { KnowledgeSyncSchedulerService } from './knowledge/knowledge-sync-scheduler.service.js';
import { RoutingController } from './models/routing.controller.js';
import { RoutingRuntimeService } from './models/routing-runtime.service.js';
import { ServiceAccountController } from './auth/service-account.controller.js';
import { ServiceAccountRuntimeService } from './auth/service-account-runtime.service.js';
import { McpRuntimeService } from './mcp/mcp-runtime.service.js';
import { PluginAdminController } from './plugins/plugin-admin.controller.js';
import { PluginAdminRuntimeService } from './plugins/plugin-admin.runtime.js';
import { SecretController } from './secrets/secret.controller.js';
import { SecretRuntimeService } from './secrets/secret-runtime.service.js';
import { WorkflowSchedulerService } from './workflows/workflow-scheduler.service.js';
import { WorkflowWorkerController } from './workflows/workflow-worker.controller.js';
import { PolicyController } from './policy/policy.controller.js';
import { PolicyRuntimeService } from './policy/policy-runtime.service.js';
import { DatabaseSettingsController } from './database/database-settings.controller.js';
import { PrivacyController } from './privacy/privacy.controller.js';
import { PrivacyRuntimeService } from './privacy/privacy-runtime.service.js';
import { PrivacyRetentionSchedulerService } from './privacy/privacy-retention-scheduler.service.js';
import { EventBusRuntimeService } from './core/event-bus-runtime.service.js';
import { ChatRateLimitService } from './chat/chat-rate-limit.service.js';

@Module({
  controllers: [
    AuthController,
    AttachmentContentController,
    ChatController,
    HealthController,
    IdentityAdminController,
    ModelAdminController,
    OidcController,
    GatewayController,
    OpenAiCompatibleController,
    BudgetController,
    CapabilityController,
    PublicCapabilityController,
    McpController,
    PluginAdminController,
    PluginRegistryController,
    OperationsController,
    AsyncOperationsController,
    AgentController,
    PublicAgentController,
    WorkflowController,
    WorkflowWorkerController,
    AccessController,
    WebhookController,
    NotificationController,
    MetricsController,
    IncidentController,
    IncidentStatusController,
    ScimController,
    ScimAdminController,
    SettingsController,
    DirectoryController,
    KnowledgeController,
    KnowledgeWorkerController,
    RoutingController,
    ServiceAccountController,
    SecretController,
    PolicyController,
    DatabaseSettingsController,
    PrivacyController,
  ],
  providers: [
    AccessTokenGuard,
    AuthRuntimeService,
    BuiltinMalwareScanner,
    ChatRuntimeService,
    ChatRateLimitService,
    DatabaseService,
    HealthService,
    IdentityAdminTelemetryInterceptor,
    LocalAttachmentStorage,
    ModelAdminRuntimeService,
    OidcRuntimeService,
    GatewayRuntimeService,
    BudgetRuntimeService,
    CapabilityRuntimeService,
    PluginRegistryRuntimeService,
    OperationsRuntimeService,
    AgentRuntimeService,
    WorkflowRuntimeService,
    AccessRuntimeService,
    WebhookRuntimeService,
    AuditRuntimeService,
    AuditIntegritySchedulerService,
    NotificationRuntimeService,
    RedisRuntimeService,
    ApiMetrics,
    IncidentRuntimeService,
    ScimAuthGuard,
    ScimRuntimeService,
    SettingsRuntimeService,
    KnowledgeRuntimeService,
    KnowledgeSyncSchedulerService,
    RoutingRuntimeService,
    ServiceAccountRuntimeService,
    McpRuntimeService,
    PluginAdminRuntimeService,
    SecretRuntimeService,
    WorkflowSchedulerService,
    PolicyRuntimeService,
    PrivacyRuntimeService,
    PrivacyRetentionSchedulerService,
    EventBusRuntimeService,
    { provide: APP_INTERCEPTOR, useClass: ApiMetricsInterceptor },
  ],
})
// NestJS modules are declarative classes consumed through decorator metadata.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AppModule {}
