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
import { CapabilityController } from './capabilities/capability.controller.js';
import { CapabilityRuntimeService } from './capabilities/capability-runtime.service.js';
import { McpController } from './mcp/mcp.controller.js';
import { PluginRegistryController } from './plugins/plugin-registry.controller.js';
import { PluginRegistryRuntimeService } from './plugins/plugin-registry.runtime.js';
import {
  AsyncOperationsController,
  OperationsController,
} from './operations/operations.controller.js';
import { OperationsRuntimeService } from './operations/operations-runtime.service.js';
import { AgentController } from './agents/agent.controller.js';
import { AgentRuntimeService } from './agents/agent-runtime.service.js';
import { WorkflowController } from './workflows/workflow.controller.js';
import { WorkflowRuntimeService } from './workflows/workflow-runtime.service.js';
import { AccessController } from './access/access.controller.js';
import { AccessRuntimeService } from './access/access-runtime.service.js';
import { WebhookRuntimeService } from './webhooks/webhook-runtime.service.js';
import { WebhookController } from './webhooks/webhook.controller.js';
import { AuditRuntimeService } from './audit/audit-runtime.service.js';
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
    McpController,
    PluginRegistryController,
    OperationsController,
    AsyncOperationsController,
    AgentController,
    WorkflowController,
    AccessController,
    WebhookController,
    NotificationController,
    MetricsController,
    IncidentController,
    IncidentStatusController,
    ScimController,
    ScimAdminController,
  ],
  providers: [
    AccessTokenGuard,
    AuthRuntimeService,
    BuiltinMalwareScanner,
    ChatRuntimeService,
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
    NotificationRuntimeService,
    RedisRuntimeService,
    ApiMetrics,
    IncidentRuntimeService,
    ScimAuthGuard,
    ScimRuntimeService,
    { provide: APP_INTERCEPTOR, useClass: ApiMetricsInterceptor },
  ],
})
// NestJS modules are declarative classes consumed through decorator metadata.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AppModule {}
