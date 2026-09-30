import { AuthorizationError, ValidationError } from '@handstack/shared';
import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import {
  requireAuthentication,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { PrivacyRuntimeService } from './privacy-runtime.service.js';
import type {
  DataClassification,
  DataSubjectRequestStatus,
  DataSubjectRequestType,
} from '@handstack/privacy';

@ApiTags('Privacy')
@ApiBearerAuth()
@Controller('api/v1/organizations/:organizationId/privacy')
@UseGuards(AccessTokenGuard)
export class PrivacyController {
  private readonly administration: IdentityAdministrationService;
  constructor(
    @Inject(PrivacyRuntimeService) private readonly runtime: PrivacyRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }
  @Get('retention') async retention(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.runtime.listRetention(organizationId) };
  }
  @Post('retention') async setRetention(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    await this.authorize(organizationId, request);
    const value = object(body);
    if (typeof value.resourceType !== 'string' || typeof value.retentionDays !== 'number')
      throw new ValidationError('resourceType and retentionDays are required');
    return this.runtime.setRetention(organizationId, value.resourceType, value.retentionDays);
  }
  @Post('retention/run') async runRetention(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    const authentication = requireAuthentication(request);
    return this.runtime.runConversationRetention(organizationId, authentication.subject);
  }
  @Post('retention/usage/run') async runUsageRetention(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    const authentication = requireAuthentication(request);
    return this.runtime.runUsageRetention(organizationId, authentication.subject);
  }
  @Post('retention/attachments/run') async runAttachmentRetention(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    const authentication = requireAuthentication(request);
    return this.runtime.runAttachmentRetention(organizationId, authentication.subject);
  }
  @Post('retention/traces/run') async runTraceRetention(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    const authentication = requireAuthentication(request);
    return this.runtime.runTraceRetention(organizationId, authentication.subject);
  }
  @Get('legal-holds') async holds(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.runtime.listHolds(organizationId) };
  }
  @Post('legal-holds') async createHold(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    await this.authorize(organizationId, request);
    const value = object(body);
    if (typeof value.reason !== 'string') throw new ValidationError('reason is required');
    return this.runtime.createHold({
      organizationId,
      reason: value.reason,
      ...(typeof value.resourceType === 'string' ? { resourceType: value.resourceType } : {}),
      ...(typeof value.resourceId === 'string' ? { resourceId: value.resourceId } : {}),
    });
  }
  @Patch('legal-holds/:holdId/release') async releaseHold(
    @Param('organizationId') organizationId: string,
    @Param('holdId') holdId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.runtime.releaseHold(organizationId, holdId);
  }
  @Get('subject-requests') async requests(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.runtime.listRequests(organizationId) };
  }
  @Post('subject-requests') async createRequest(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    await this.authorize(organizationId, request);
    const value = object(body);
    if (
      typeof value.subjectId !== 'string' ||
      typeof value.type !== 'string' ||
      !['ACCESS', 'EXPORT', 'CORRECTION', 'DELETION', 'RESTRICTION', 'OBJECTION'].includes(
        value.type,
      )
    )
      throw new ValidationError('subjectId and valid type are required');
    return this.runtime.createRequest({
      organizationId,
      subjectId: value.subjectId,
      type: value.type as DataSubjectRequestType,
    });
  }
  @Patch('subject-requests/:requestId') async updateRequest(
    @Param('organizationId') organizationId: string,
    @Param('requestId') requestId: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    await this.authorize(organizationId, request);
    const value = object(body);
    if (
      typeof value.status !== 'string' ||
      ![
        'RECEIVED',
        'IDENTITY_VERIFICATION',
        'APPROVED',
        'IN_PROGRESS',
        'COMPLETED',
        'PARTIALLY_COMPLETED',
        'DENIED_WITH_REASON',
      ].includes(value.status)
    )
      throw new ValidationError('valid status is required');
    const evidence = Array.isArray(value.evidence)
      ? value.evidence.filter((item): item is string => typeof item === 'string')
      : [];
    return this.runtime.updateRequest(
      organizationId,
      requestId,
      value.status as DataSubjectRequestStatus,
      evidence,
    );
  }
  @Post('subject-requests/:requestId/execute') async executeRequest(
    @Param('organizationId') organizationId: string,
    @Param('requestId') requestId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.runtime.executeRequest(organizationId, requestId);
  }
  @Get('subject-requests/:requestId/export') async getExport(
    @Param('organizationId') organizationId: string,
    @Param('requestId') requestId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.runtime.getExport(organizationId, requestId);
  }
  @Get('inventory') async inventory(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.runtime.listInventory(organizationId) };
  }
  @Post('inventory') async createInventory(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    await this.authorize(organizationId, request);
    const value = object(body);
    if (
      typeof value.resourceType !== 'string' ||
      typeof value.resourceId !== 'string' ||
      typeof value.classification !== 'string' ||
      !['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'].includes(value.classification) ||
      !Array.isArray(value.subjectIds) ||
      value.subjectIds.some((item) => typeof item !== 'string')
    )
      throw new ValidationError('Inventory fields are required');
    return this.runtime.createInventory({
      organizationId,
      resourceType: value.resourceType,
      resourceId: value.resourceId,
      classification: value.classification as DataClassification,
      subjectIds: value.subjectIds as string[],
      ...(typeof value.processingPurpose === 'string'
        ? { processingPurpose: value.processingPurpose }
        : {}),
      ...(typeof value.region === 'string' ? { region: value.region } : {}),
    });
  }
  @Get('purposes') async purposes(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.runtime.listPurposes(organizationId) };
  }
  @Post('purposes') async createPurpose(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    await this.authorize(organizationId, request);
    const value = object(body);
    if (
      typeof value.name !== 'string' ||
      typeof value.description !== 'string' ||
      typeof value.lawfulBasis !== 'string'
    )
      throw new ValidationError('Processing purpose fields are required');
    return this.runtime.createPurpose({
      organizationId,
      name: value.name,
      description: value.description,
      lawfulBasis: value.lawfulBasis,
    });
  }
  @Get('consents') async consents(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.runtime.listConsents(organizationId) };
  }
  @Post('consents') async createConsent(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    await this.authorize(organizationId, request);
    const value = object(body);
    if (typeof value.subjectId !== 'string' || typeof value.purposeId !== 'string')
      throw new ValidationError('Consent subject and purpose are required');
    return this.runtime.createConsent({
      organizationId,
      subjectId: value.subjectId,
      purposeId: value.purposeId,
    });
  }
  @Patch('consents/:consentId/withdraw') async withdrawConsent(
    @Param('organizationId') organizationId: string,
    @Param('consentId') consentId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.runtime.withdrawConsent(organizationId, consentId);
  }
  @Get('processors') async processors(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.runtime.listProcessors(organizationId) };
  }
  @Post('processors') async createProcessor(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    await this.authorize(organizationId, request);
    const value = object(body);
    if (
      typeof value.name !== 'string' ||
      typeof value.purpose !== 'string' ||
      !Array.isArray(value.regions) ||
      value.regions.some((item) => typeof item !== 'string')
    )
      throw new ValidationError('Processor fields are required');
    return this.runtime.createProcessor({
      organizationId,
      name: value.name,
      purpose: value.purpose,
      regions: value.regions as string[],
    });
  }
  @Get('incidents') async incidents(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.runtime.listIncidents(organizationId) };
  }
  @Post('incidents') async createIncident(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    await this.authorize(organizationId, request);
    const value = object(body);
    if (
      typeof value.title !== 'string' ||
      typeof value.severity !== 'string' ||
      !['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(value.severity) ||
      !Array.isArray(value.affectedResources) ||
      value.affectedResources.some((item) => typeof item !== 'string')
    )
      throw new ValidationError('Privacy incident fields are required');
    return this.runtime.createIncident({
      organizationId,
      title: value.title,
      severity: value.severity as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
      affectedResources: value.affectedResources as string[],
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
    });
  }
  @Get('deletion-jobs') async deletionJobs(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.runtime.listDeletionJobs(organizationId) };
  }
  @Get('deletion-jobs/:jobId/evidence') async deletionEvidence(
    @Param('organizationId') organizationId: string,
    @Param('jobId') jobId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.runtime.listDeletionEvidence(organizationId, jobId) };
  }
  @Get('residency') async residency(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.runtime.listResidency(organizationId) };
  }
  @Post('residency') async setResidency(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    await this.authorize(organizationId, request);
    const value = object(body);
    if (
      typeof value.region !== 'string' ||
      typeof value.classification !== 'string' ||
      !['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'].includes(value.classification)
    )
      throw new ValidationError('region and valid classification are required');
    return this.runtime.setResidency(
      organizationId,
      value.region,
      value.classification as DataClassification,
    );
  }
  private async authorize(organizationId: string, request: AuthenticatedRequest) {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization privacy access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission: 'privacy.manage',
    });
    if (!decision.allowed) throw new AuthorizationError('privacy.manage permission is required');
  }
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ValidationError('Request body must be an object');
  return value as Record<string, unknown>;
}
