import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { HealthService, type HealthResult } from './health.service.js';

@Controller()
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get('health')
  async health(@Res({ passthrough: true }) response: FastifyReply): Promise<HealthResult> {
    const result = await this.healthService.ready();
    response.status(result.status === 'ok' ? 200 : 503);
    return result;
  }

  @Get('health/live')
  live(): HealthResult {
    return this.healthService.live();
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) response: FastifyReply): Promise<HealthResult> {
    const result = await this.healthService.ready();
    response.status(result.status === 'ok' ? 200 : 503);
    return result;
  }
}
