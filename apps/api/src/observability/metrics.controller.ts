import { Controller, Get, Header, Inject } from '@nestjs/common';
import { ApiMetrics } from './api-metrics.js';

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(ApiMetrics) private readonly metrics: ApiMetrics) {}

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  getMetrics(): string {
    return this.metrics.render();
  }
}
