import type { ScimEmail, ScimGroup, ScimUser } from '@handstack/scim';
import { SCIM_SCHEMAS, ScimNotFoundError, ScimProvisioningService } from '@handstack/scim';
import { ValidationError } from '@handstack/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ScimAuthGuard, requireScimOrganization, type ScimRequest } from './scim-auth.guard.js';
import { ScimErrorFilter } from './scim-error.filter.js';
import { ScimRuntimeService } from './scim-runtime.service.js';

function etag(version: number): string {
  return `W/"${String(version)}"`;
}

function parseIfMatch(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(?:W\/)?"(\d+)"$/.exec(value.trim());
  if (match === null) return undefined;
  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function requireVersion(value: string | undefined): number {
  const parsed = parseIfMatch(value);
  if (parsed === undefined) {
    throw new ValidationError('SCIM If-Match version is required for mutation');
  }
  return parsed;
}

function serializeMeta(meta: ScimUser['meta']) {
  return {
    resourceType: meta.resourceType,
    created: meta.created.toISOString(),
    lastModified: meta.lastModified.toISOString(),
    version: meta.version,
    location: meta.location,
  };
}

function serializeUser(user: ScimUser) {
  return {
    schemas: [SCIM_SCHEMAS.user],
    id: user.id,
    ...(user.externalId === undefined ? {} : { externalId: user.externalId }),
    userName: user.userName,
    displayName: user.displayName,
    active: user.active,
    ...(user.name === undefined ? {} : { name: user.name }),
    ...(user.emails === undefined ? {} : { emails: user.emails }),
    meta: serializeMeta(user.meta),
  };
}

function serializeGroup(group: ScimGroup) {
  return {
    schemas: [SCIM_SCHEMAS.group],
    id: group.id,
    ...(group.externalId === undefined ? {} : { externalId: group.externalId }),
    displayName: group.displayName,
    ...(group.members === undefined ? {} : { members: group.members }),
    meta: serializeMeta(group.meta),
  };
}

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('SCIM request body must be an object');
  }
  return value as Record<string, unknown>;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ValidationError(`SCIM ${key} must be a string`);
  return value;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ValidationError(`SCIM ${key} must be a boolean`);
  return value;
}

function emailField(body: Record<string, unknown>): readonly ScimEmail[] | undefined {
  const value = body.emails;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ValidationError('SCIM emails must be an array');
  return value.map((entry) => {
    const email = objectBody(entry);
    const emailValue = optionalString(email, 'value');
    if (emailValue === undefined) throw new ValidationError('SCIM email value is required');
    const type = optionalString(email, 'type');
    const primary = optionalBoolean(email, 'primary');
    return {
      value: emailValue,
      ...(type === undefined ? {} : { type }),
      ...(primary === undefined ? {} : { primary }),
    };
  });
}

function nameField(body: Record<string, unknown>): ScimUser['name'] {
  const value = body.name;
  if (value === undefined) return undefined;
  const name = objectBody(value);
  const formatted = optionalString(name, 'formatted');
  const givenName = optionalString(name, 'givenName');
  const familyName = optionalString(name, 'familyName');
  return {
    ...(formatted === undefined ? {} : { formatted }),
    ...(givenName === undefined ? {} : { givenName }),
    ...(familyName === undefined ? {} : { familyName }),
  };
}

function positiveInteger(value: unknown, name: string, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ValidationError(`SCIM ${name} must be an integer between 1 and ${String(maximum)}`);
  }
  return parsed;
}

interface PatchOperation {
  readonly op: 'add' | 'remove' | 'replace';
  readonly path?: string;
  readonly value?: unknown;
}

function patchOperations(value: unknown): readonly PatchOperation[] {
  if (Array.isArray(value)) return value.map(parseOperation);
  const body = objectBody(value);
  const operations = body.Operations;
  if (operations === undefined) return [{ op: 'replace', value }];
  if (!Array.isArray(operations))
    throw new ValidationError('SCIM patch Operations must be an array');
  return operations.map(parseOperation);
}

function parseOperation(entry: unknown): PatchOperation {
  const operation = objectBody(entry);
  const op = operation.op;
  if (op !== 'add' && op !== 'remove' && op !== 'replace') {
    throw new ValidationError('SCIM patch op must be add, remove or replace');
  }
  const path = optionalString(operation, 'path');
  return {
    op,
    ...(path === undefined ? {} : { path }),
    ...(operation.value === undefined ? {} : { value: operation.value }),
  };
}

function parseMembers(value: unknown): readonly { value: string; display?: string }[] {
  if (!Array.isArray(value)) throw new ValidationError('SCIM members must be an array');
  return value.map((entry) => {
    const member = objectBody(entry);
    const memberValue = optionalString(member, 'value');
    if (memberValue === undefined) throw new ValidationError('SCIM member value is required');
    const display = optionalString(member, 'display');
    return { value: memberValue, ...(display === undefined ? {} : { display }) };
  });
}

function listResponse<T>(
  resources: readonly T[],
  startIndex: number,
  itemsPerPage: number,
  totalResults: number,
) {
  return {
    schemas: [SCIM_SCHEMAS.listResponse],
    totalResults,
    startIndex,
    itemsPerPage,
    Resources: resources,
  };
}

@Controller('scim/v2')
@UseGuards(ScimAuthGuard)
@UseFilters(ScimErrorFilter)
export class ScimController {
  constructor(@Inject(ScimRuntimeService) private readonly runtime: ScimRuntimeService) {}

  private provisioning(): ScimProvisioningService {
    return this.runtime.provisioning;
  }

  @Get('ServiceProviderConfig')
  serviceProviderConfig() {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      documentationUri: 'https://docs.handstack.dev/help/getting-started/scim',
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 1000 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: true },
      authenticationSchemes: [
        {
          name: 'OAuth Bearer Token',
          description: 'Dedicated SCIM bearer token',
          specUri: 'https://tools.ietf.org/html/rfc6750',
          type: 'oauthbearertoken',
          primary: true,
        },
      ],
    };
  }

  @Get('ResourceTypes')
  resourceTypes() {
    return {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: 2,
      itemsPerPage: 2,
      startIndex: 1,
      Resources: [
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'User',
          name: 'User',
          endpoint: '/scim/v2/Users',
          schema: SCIM_SCHEMAS.user,
          meta: { resourceType: 'ResourceType', location: '/scim/v2/ResourceTypes/User' },
        },
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'Group',
          name: 'Group',
          endpoint: '/scim/v2/Groups',
          schema: SCIM_SCHEMAS.group,
          meta: { resourceType: 'ResourceType', location: '/scim/v2/ResourceTypes/Group' },
        },
      ],
    };
  }

  @Get('Schemas')
  schemas() {
    return {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: 2,
      itemsPerPage: 2,
      startIndex: 1,
      Resources: [
        { id: SCIM_SCHEMAS.user, name: 'User' },
        { id: SCIM_SCHEMAS.group, name: 'Group' },
      ],
    };
  }

  // --- Users -----------------------------------------------------------------

  @Get('Users')
  async listUsers(
    @Req() request: ScimRequest,
    @Query('startIndex') startIndex?: string,
    @Query('count') count?: string,
    @Query('filter') filter?: string,
  ) {
    const organizationId = requireScimOrganization(request);
    if (filter !== undefined) {
      const match = /^(\w+)\s+eq\s+"([^"]+)"$/.exec(filter);
      if (match !== null) {
        const attribute = match[1];
        const value = match[2] ?? '';
        const users = (await this.provisioning().listUsers(organizationId, 1, 1000)).Resources;
        if (attribute === 'userName' || attribute === 'externalId') {
          const found = users.find((user) =>
            attribute === 'userName' ? user.userName === value : user.externalId === value,
          );
          return listResponse(
            found === undefined ? [] : [serializeUser(found)],
            1,
            found === undefined ? 0 : 1,
            found === undefined ? 0 : 1,
          );
        }
      }
    }
    const normalizedStart = positiveInteger(startIndex, 'startIndex', 1_000_000) ?? 1;
    const normalizedCount = positiveInteger(count, 'count', 1000) ?? 100;
    const page = await this.provisioning().listUsers(
      organizationId,
      normalizedStart,
      normalizedCount,
    );
    return listResponse(
      page.Resources.map(serializeUser),
      page.startIndex,
      page.itemsPerPage,
      page.totalResults,
    );
  }

  @Post('Users')
  async createUser(
    @Req() request: ScimRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() value: unknown,
  ) {
    const organizationId = requireScimOrganization(request);
    const body = objectBody(value);
    const externalId = optionalString(body, 'externalId');
    const userName = optionalString(body, 'userName');
    const displayName = optionalString(body, 'displayName');
    const active = optionalBoolean(body, 'active');
    const name = nameField(body);
    const emails = emailField(body);
    const user = await this.provisioning().upsertUser(organizationId, {
      ...(externalId === undefined ? {} : { externalId }),
      ...(userName === undefined ? {} : { userName }),
      ...(displayName === undefined ? {} : { displayName }),
      ...(active === undefined ? {} : { active }),
      ...(name === undefined ? {} : { name }),
      ...(emails === undefined ? {} : { emails }),
    });
    reply
      .status(201)
      .header('Location', user.meta.location)
      .header('ETag', etag(user.meta.version));
    return serializeUser(user);
  }

  @Get('Users/:id')
  async getUser(
    @Req() request: ScimRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id') id: string,
  ) {
    const organizationId = requireScimOrganization(request);
    const user = await this.provisioning().getUser(organizationId, id);
    if (user === undefined) throw new ScimNotFoundError('SCIM user not found');
    reply.header('ETag', etag(user.meta.version));
    return serializeUser(user);
  }

  @Put('Users/:id')
  async replaceUser(
    @Req() request: ScimRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id') id: string,
    @Body() value: unknown,
  ) {
    const organizationId = requireScimOrganization(request);
    const version = requireVersion(request.headers['if-match']);
    const body = objectBody(value);
    const current = await this.provisioning().getUser(organizationId, id);
    if (current === undefined) throw new ScimNotFoundError('SCIM user not found');
    const userName = optionalString(body, 'userName');
    const displayName = optionalString(body, 'displayName');
    const active = optionalBoolean(body, 'active');
    const name = nameField(body);
    const emails = emailField(body);
    const user = await this.provisioning().updateUser(
      organizationId,
      id,
      {
        ...(userName === undefined ? {} : { userName }),
        ...(displayName === undefined ? {} : { displayName }),
        ...(active === undefined ? {} : { active }),
        ...(name === undefined ? {} : { name }),
        ...(emails === undefined ? {} : { emails }),
      },
      version,
    );
    reply.header('ETag', etag(user.meta.version));
    return serializeUser(user);
  }

  @Patch('Users/:id')
  async patchUser(
    @Req() request: ScimRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id') id: string,
    @Body() value: unknown,
  ) {
    const organizationId = requireScimOrganization(request);
    const version = requireVersion(request.headers['if-match']);
    const current = await this.provisioning().getUser(organizationId, id);
    if (current === undefined) throw new ScimNotFoundError('SCIM user not found');
    const patch: { userName?: string; displayName?: string; active?: boolean } = {};
    for (const operation of patchOperations(value)) {
      if (operation.op === 'remove') {
        throw new ValidationError('SCIM user patch remove is unsupported');
      }
      if (operation.path === undefined) {
        const body = objectBody(operation.value);
        const userName = optionalString(body, 'userName');
        const displayName = optionalString(body, 'displayName');
        const active = optionalBoolean(body, 'active');
        if (userName !== undefined) patch.userName = userName;
        if (displayName !== undefined) patch.displayName = displayName;
        if (active !== undefined) patch.active = active;
        continue;
      }
      if (operation.path === 'active') {
        if (typeof operation.value !== 'boolean')
          throw new ValidationError('SCIM active must be a boolean');
        patch.active = operation.value;
        continue;
      }
      if (operation.path === 'userName') {
        if (typeof operation.value !== 'string')
          throw new ValidationError('SCIM userName must be a string');
        patch.userName = operation.value;
        continue;
      }
      if (operation.path === 'displayName') {
        if (typeof operation.value !== 'string')
          throw new ValidationError('SCIM displayName must be a string');
        patch.displayName = operation.value;
        continue;
      }
      throw new ValidationError(`SCIM unsupported patch path: ${operation.path}`);
    }
    const user = await this.provisioning().updateUser(organizationId, id, patch, version);
    reply.header('ETag', etag(user.meta.version));
    return serializeUser(user);
  }

  @Delete('Users/:id')
  async deleteUser(
    @Req() request: ScimRequest,
    @Res() reply: FastifyReply,
    @Param('id') id: string,
  ) {
    const organizationId = requireScimOrganization(request);
    const version = requireVersion(request.headers['if-match']);
    await this.provisioning().deleteUser(organizationId, id, version);
    void reply.status(204).send();
  }

  // --- Groups ----------------------------------------------------------------

  @Get('Groups')
  async listGroups(
    @Req() request: ScimRequest,
    @Query('startIndex') startIndex?: string,
    @Query('count') count?: string,
  ) {
    const organizationId = requireScimOrganization(request);
    const normalizedStart = positiveInteger(startIndex, 'startIndex', 1_000_000) ?? 1;
    const normalizedCount = positiveInteger(count, 'count', 1000) ?? 100;
    const page = await this.provisioning().listGroups(
      organizationId,
      normalizedStart,
      normalizedCount,
    );
    return listResponse(
      page.Resources.map(serializeGroup),
      page.startIndex,
      page.itemsPerPage,
      page.totalResults,
    );
  }

  @Post('Groups')
  async createGroup(
    @Req() request: ScimRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() value: unknown,
  ) {
    const organizationId = requireScimOrganization(request);
    const body = objectBody(value);
    const externalId = optionalString(body, 'externalId');
    const displayName = optionalString(body, 'displayName');
    const members = body.members;
    const group = await this.provisioning().upsertGroup(organizationId, {
      ...(externalId === undefined ? {} : { externalId }),
      ...(displayName === undefined ? {} : { displayName }),
      ...(members === undefined ? {} : { members: parseMembers(members) }),
    });
    reply
      .status(201)
      .header('Location', group.meta.location)
      .header('ETag', etag(group.meta.version));
    return serializeGroup(group);
  }

  @Get('Groups/:id')
  async getGroup(
    @Req() request: ScimRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id') id: string,
  ) {
    const organizationId = requireScimOrganization(request);
    const group = await this.provisioning().getGroup(organizationId, id);
    if (group === undefined) throw new ScimNotFoundError('SCIM group not found');
    reply.header('ETag', etag(group.meta.version));
    return serializeGroup(group);
  }

  @Patch('Groups/:id')
  async patchGroup(
    @Req() request: ScimRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id') id: string,
    @Body() value: unknown,
  ) {
    const organizationId = requireScimOrganization(request);
    const version = requireVersion(request.headers['if-match']);
    const current = await this.provisioning().getGroup(organizationId, id);
    if (current === undefined) throw new ScimNotFoundError('SCIM group not found');

    let result = current;
    let currentVersion = version;
    for (const operation of patchOperations(value)) {
      if (operation.path === 'members' && operation.op === 'add') {
        for (const member of parseMembers(operation.value)) {
          result = await this.provisioning().addGroupMember(
            organizationId,
            id,
            member.value,
            currentVersion,
          );
          currentVersion = result.meta.version;
        }
        continue;
      }
      if (operation.path === 'members' && operation.op === 'remove') {
        for (const member of parseMembers(operation.value)) {
          result = await this.provisioning().removeGroupMember(
            organizationId,
            id,
            member.value,
            currentVersion,
          );
          currentVersion = result.meta.version;
        }
        continue;
      }
      if (operation.path === undefined) {
        const body = objectBody(operation.value);
        const displayName = optionalString(body, 'displayName');
        const externalId = optionalString(body, 'externalId');
        result = await this.provisioning().updateGroup(
          organizationId,
          id,
          {
            ...(displayName === undefined ? {} : { displayName }),
            ...(externalId === undefined ? {} : { externalId }),
          },
          currentVersion,
        );
        currentVersion = result.meta.version;
        continue;
      }
      if (operation.path === 'displayName') {
        if (typeof operation.value !== 'string')
          throw new ValidationError('SCIM displayName must be a string');
        result = await this.provisioning().updateGroup(
          organizationId,
          id,
          { displayName: operation.value },
          currentVersion,
        );
        currentVersion = result.meta.version;
        continue;
      }
      throw new ValidationError(`SCIM unsupported patch path: ${operation.path}`);
    }
    reply.header('ETag', etag(result.meta.version));
    return serializeGroup(result);
  }

  @Delete('Groups/:id')
  async deleteGroup(
    @Req() request: ScimRequest,
    @Res() reply: FastifyReply,
    @Param('id') id: string,
  ) {
    const organizationId = requireScimOrganization(request);
    const version = requireVersion(request.headers['if-match']);
    await this.provisioning().deleteGroup(organizationId, id, version);
    void reply.status(204).send();
  }
}
