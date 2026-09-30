import type { DataClassification, DataSourceType } from '@handstack/knowledge';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { AuthorizationError, ValidationError } from '@handstack/shared';
import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import {
  requireAuthentication,
  requestTraceContext,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { KnowledgeRuntimeService } from './knowledge-runtime.service.js';
import { OperationsRuntimeService } from '../operations/operations-runtime.service.js';
import { DatabaseService } from '../database/database.service.js';

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ValidationError('Request body must be an object');
  return value as Record<string, unknown>;
}
function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '')
    throw new ValidationError(`${key} must be a non-empty string`);
  return value.trim();
}

@Controller('api/v1/organizations/:organizationId/knowledge')
@UseGuards(AccessTokenGuard)
export class KnowledgeController {
  private readonly administration: IdentityAdministrationService;
  constructor(
    @Inject(KnowledgeRuntimeService) private readonly runtime: KnowledgeRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
    @Inject(OperationsRuntimeService) private readonly operations: OperationsRuntimeService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get('bases')
  async listBases(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.runtime.listBases(organizationId) };
  }

  @Post('bases')
  async createBase(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    const strategy = stringField(body, 'strategy');
    if (!['CHARACTER', 'TOKEN', 'PARAGRAPH'].includes(strategy))
      throw new ValidationError('strategy is invalid');
    return this.runtime.createBase(organizationId, {
      name: stringField(body, 'name'),
      description: stringField(body, 'description'),
      chunkSize: Number(body.chunkSize),
      chunkOverlap: Number(body.chunkOverlap),
      strategy: strategy as 'CHARACTER' | 'TOKEN' | 'PARAGRAPH',
      metadataExtraction: body.metadataExtraction === true,
      embeddingModel: stringField(body, 'embeddingModel'),
    });
  }

  @Get('documents')
  async listDocuments(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.runtime.listDocuments(organizationId) };
  }

  @Post('documents')
  async createDocument(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    const sourceType = stringField(body, 'sourceType');
    const classification = stringField(body, 'classification');
    if (
      ![
        'FILE',
        'URL',
        'TEXT',
        'GITHUB',
        'GOOGLE_DRIVE',
        'SHAREPOINT',
        'CONFLUENCE',
        'NOTION',
        'S3',
      ].includes(sourceType) ||
      !['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'].includes(classification)
    )
      throw new ValidationError('sourceType or classification is invalid');
    const now = new Date();
    return this.runtime.createDocument(organizationId, {
      knowledgeBaseId: stringField(body, 'knowledgeBaseId'),
      sourceType: sourceType as DataSourceType,
      sourceLocator: stringField(body, 'sourceLocator'),
      title: stringField(body, 'title'),
      contentDigest: stringField(body, 'contentDigest'),
      sourceId: stringField(body, 'sourceId'),
      sourceVersion: stringField(body, 'sourceVersion'),
      sourceAcl: Array.isArray(body.sourceAcl)
        ? body.sourceAcl.filter(
            (entry): entry is { principalId: string; permissions: ('read' | 'admin')[] } =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof (entry as Record<string, unknown>).principalId === 'string' &&
              Array.isArray((entry as Record<string, unknown>).permissions),
          )
        : [],
      classification: classification as DataClassification,
      residency: stringField(body, 'residency'),
      ingestedAt: now,
      lastVerifiedAt: now,
      retentionPolicy: {
        retentionDays: Number(body.retentionDays),
        legalHold: body.legalHold === true,
      },
      deletionStatus: 'ACTIVE',
      ...(typeof body.credentialReference === 'string' && body.credentialReference.trim() !== ''
        ? { credentialReference: body.credentialReference.trim() }
        : {}),
    });
  }

  @Post('documents/:documentId/ingest')
  async ingest(
    @Param('organizationId') organizationId: string,
    @Param('documentId') documentId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    const content = stringField(body, 'content');
    return { items: await this.runtime.ingest(organizationId, documentId, content) };
  }

  @Post('documents/:documentId/sync-source')
  async syncSource(
    @Param('organizationId') organizationId: string,
    @Param('documentId') documentId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.runtime.syncUrl(organizationId, documentId);
  }

  @Post('documents/:documentId/sync')
  async sync(
    @Param('organizationId') organizationId: string,
    @Param('documentId') documentId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    const operation = stringField(body, 'operation');
    if (!['UPSERT', 'DELETE', 'PERMISSION_CHANGED'].includes(operation))
      throw new ValidationError('operation is invalid');
    const cursor = body.cursor;
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor))
      throw new ValidationError('cursor is required');
    const cursorBody = cursor as Record<string, unknown>;
    const connector = typeof cursorBody.connector === 'string' ? cursorBody.connector.trim() : '';
    const token = typeof cursorBody.token === 'string' ? cursorBody.token.trim() : '';
    if (connector === '' || token === '')
      throw new ValidationError('cursor connector and token are required');
    const lastVerifiedAt =
      typeof body.lastVerifiedAt === 'string' ? new Date(body.lastVerifiedAt) : undefined;
    if (lastVerifiedAt !== undefined && Number.isNaN(lastVerifiedAt.getTime()))
      throw new ValidationError('lastVerifiedAt is invalid');
    return this.runtime.syncDocument({
      organizationId,
      documentId,
      operation: operation as 'UPSERT' | 'DELETE' | 'PERMISSION_CHANGED',
      ...(Array.isArray(body.sourceAcl)
        ? {
            sourceAcl: body.sourceAcl as {
              principalId: string;
              permissions: ('read' | 'admin')[];
            }[],
          }
        : {}),
      ...(typeof body.deletionStatus === 'string'
        ? { deletionStatus: body.deletionStatus as 'ACTIVE' | 'PENDING' | 'DELETED' }
        : {}),
      ...(lastVerifiedAt === undefined ? {} : { lastVerifiedAt }),
      cursor: { connector, token, issuedAt: new Date() },
    });
  }

  @Get('documents/:documentId/versions')
  async listVersions(
    @Param('organizationId') organizationId: string,
    @Param('documentId') documentId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.runtime.listVersions(organizationId, documentId) };
  }

  @Post('search')
  async search(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    return {
      items: await this.runtime.search(
        organizationId,
        stringField(body, 'knowledgeBaseId'),
        stringField(body, 'query'),
        stringField(body, 'model'),
        requireAuthentication(request).subject,
        typeof body.topK === 'number' ? body.topK : undefined,
      ),
    };
  }

  @Post('reindex-jobs')
  async createReindexJob(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const auth = requireAuthentication(request);
    const trace = requestTraceContext(request);
    const body = objectBody(value);
    const job = await this.runtime.createReindexJob({
      organizationId,
      knowledgeBaseId: stringField(body, 'knowledgeBaseId'),
      embeddingModel: stringField(body, 'embeddingModel'),
    });
    if (this.database.config.deployment.profile === 'distributed') {
      await this.operations.queue('indexing', organizationId).enqueue({
        id: `knowledge-reindex-${job.id}`,
        idempotencyKey: `knowledge-reindex-${job.id}`,
        payload: { kind: 'knowledge.reindex', organizationId, jobId: job.id },
        context: {
          requestId: trace.requestId,
          traceId: trace.traceId,
          principalId: auth.subject,
          source: 'API',
        },
      });
    }
    return job;
  }

  @Get('reindex-jobs/:jobId')
  async getReindexJob(
    @Param('organizationId') organizationId: string,
    @Param('jobId') jobId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    const job = await this.runtime.getReindexJob(organizationId, jobId);
    if (job === undefined) throw new ValidationError('Reindex job was not found');
    return job;
  }

  @Post('reindex-jobs/:jobId/run')
  async runReindexJob(
    @Param('organizationId') organizationId: string,
    @Param('jobId') jobId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    if (this.database.config.deployment.profile === 'distributed')
      throw new ValidationError('Distributed reindex jobs run through the indexing worker');
    return this.runtime.runReindexJob(organizationId, jobId);
  }

  @Post('reindex-jobs/:jobId/cancel')
  async cancelReindexJob(
    @Param('organizationId') organizationId: string,
    @Param('jobId') jobId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.runtime.cancelReindexJob(organizationId, jobId);
  }

  private async authorize(organizationId: string, request: AuthenticatedRequest): Promise<void> {
    const auth = requireAuthentication(request);
    if (auth.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization knowledge access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: auth.subject,
      permission: 'knowledge.manage',
    });
    if (!decision.allowed) throw new AuthorizationError('knowledge.manage permission is required');
  }
}
