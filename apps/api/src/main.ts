import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { createLogger, FrameworkLogger, initializeTelemetry } from '@handstack/telemetry';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import 'reflect-metadata';
import { AppModule } from './app.module.js';
import { ProblemDetailsFilter } from './http/problem-details.filter.js';

export async function createApplication(): Promise<NestFastifyApplication> {
  const structuredLogger = createLogger({
    name: 'handstack-api',
    level: process.env.HANDSTACK_LOG_LEVEL ?? 'info',
  });
  const adapter = new FastifyAdapter({ bodyLimit: 1024 * 1024, trustProxy: true });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    abortOnError: false,
    logger: new FrameworkLogger(structuredLogger),
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { files: 1, fileSize: 25 * 1024 * 1024, fields: 4, parts: 5 },
  });
  await app.register(helmet);
  app.enableCors({ origin: false });
  app.useGlobalFilters(new ProblemDetailsFilter());
  const openApiConfiguration = new DocumentBuilder()
    .setTitle('HandStack API')
    .setDescription('Versioned public and administrative HandStack API')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, openApiConfiguration);
  SwaggerModule.setup('api/docs', app, document, {
    ui: false,
    raw: true,
    jsonDocumentUrl: '/api/openapi.json',
  });
  app.enableShutdownHooks();
  return app;
}

async function bootstrap(): Promise<void> {
  const telemetry = initializeTelemetry({
    enabled: process.env.HANDSTACK_TELEMETRY_ENABLED === 'true',
    serviceName: 'handstack-api',
    serviceVersion: '0.0.0',
    ...(process.env.HANDSTACK_OTLP_ENDPOINT === undefined
      ? {}
      : { otlpEndpoint: process.env.HANDSTACK_OTLP_ENDPOINT }),
  });
  const app = await createApplication();
  const port = Number.parseInt(process.env.HANDSTACK_API_PORT ?? '3001', 10);
  await app.listen(port, '0.0.0.0');
  const shutdown = async (): Promise<void> => {
    await app.close();
    await telemetry.shutdown();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

if (process.env.NODE_ENV !== 'test') {
  await bootstrap();
}
