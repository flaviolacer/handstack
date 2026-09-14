import { IdentityTelemetry, type IdentityOperation } from '@handstack/telemetry';
import {
  Injectable,
  Inject,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { AuditRuntimeService } from '../audit/audit-runtime.service.js';
import type { AuthenticatedRequest } from './authentication-context.js';

const operationByHandler: Readonly<Record<string, IdentityOperation>> = {
  listProviders: 'admin.provider.list',
  createProvider: 'admin.provider.create',
  setProviderEnabled: 'admin.provider.enablement',
  testProviderConnection: 'admin.provider.test_connection',
  loginPolicy: 'admin.policy.read',
  setLoginPolicy: 'admin.policy.update',
  enableBreakGlass: 'admin.break_glass.enable',
  disableBreakGlass: 'admin.break_glass.disable',
  deprovisionUser: 'admin.user.deprovision',
  listMappings: 'admin.mapping.read',
  setMappings: 'admin.mapping.update',
};

@Injectable()
export class IdentityAdminTelemetryInterceptor implements NestInterceptor {
  private readonly telemetry = new IdentityTelemetry();

  constructor(@Inject(AuditRuntimeService) private readonly audit: AuditRuntimeService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const operation = operationByHandler[context.getHandler().name];
    if (operation === undefined) return next.handle();
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const organizationId = (request.params as { organizationId?: string } | undefined)
      ?.organizationId;
    const authentication = request.authentication;
    const audit = async (decision: 'ALLOW' | 'DENY'): Promise<void> => {
      if (organizationId === undefined || authentication === undefined) return;
      try {
        await this.audit.record({
          organizationId,
          actorId: authentication.subject,
          action: `IDENTITY_ADMIN_${operation.toUpperCase().replaceAll('.', '_')}`,
          resourceType: 'identity_admin',
          resourceId: organizationId,
          decision,
        });
      } catch {
        // Audit persistence must not replace the original HTTP result.
      }
    };
    return from(
      this.telemetry.measure(operation, async () => {
        try {
          const result: unknown = await lastValueFrom(next.handle());
          await audit('ALLOW');
          return result;
        } catch (error) {
          await audit('DENY');
          throw error;
        }
      }),
    );
  }
}
