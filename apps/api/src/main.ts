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
import { configLayerFromEnvironment, resolveConfigLayers } from '@handstack/config';
import { loadConfigFile } from './database/config-file.js';

function runtimeConfig() {
  return resolveConfigLayers(configLayerFromEnvironment(process.env), loadConfigFile());
}

export async function createApplication(): Promise<NestFastifyApplication> {
  const config = runtimeConfig();
  const structuredLogger = createLogger({
    name: 'handstack-api',
    level: config.logging.level,
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
  const config = runtimeConfig();
  const telemetry = initializeTelemetry({
    enabled: config.telemetry.enabled,
    privacyAllowed: config.privacy.sendTelemetry,
    serviceName: 'handstack-api',
    serviceVersion: '0.0.0',
    ...(config.telemetry.otlpEndpoint === undefined
      ? {}
      : { otlpEndpoint: config.telemetry.otlpEndpoint }),
  });
  const app = await createApplication();
  const port = config.server.apiPort;
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
