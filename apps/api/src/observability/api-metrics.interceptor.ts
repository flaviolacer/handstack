import {
  Inject,
  Injectable,
  Optional,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { finalize, type Observable } from 'rxjs';
import { ApiMetrics } from './api-metrics.js';

@Injectable()
export class ApiMetricsInterceptor implements NestInterceptor {
  private readonly metrics: ApiMetrics;

  constructor(@Optional() @Inject(ApiMetrics) metrics?: ApiMetrics) {
    this.metrics = metrics ?? new ApiMetrics();
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const response = context.switchToHttp().getResponse<{ statusCode?: number } | undefined>();
    const request = context.switchToHttp().getRequest<{ method?: string } | undefined>();
    const method = request?.method;
    if (response === undefined || method === undefined) return next.handle();
    return next.handle().pipe(
      finalize(() => {
        this.metrics.request(method, response.statusCode ?? 500);
      }),
    );
  }
}
