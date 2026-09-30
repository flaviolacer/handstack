import {
  InMemoryApprovalService,
  InMemoryPolicyEngine,
  PersistentPolicyEngine,
  parsePermission,
  type AuthorizationPolicy,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';

const allowPolicy: AuthorizationPolicy = {
  id: 'allow-developers',
  organizationId: 'organization-a',
  principalIds: ['user-a'],
  resource: 'mcp.database.production',
  action: 'execute',
  effect: 'allow',
  conditions: { groupId: 'developers', time: { from: '08:00', to: '18:00' } },
};
const policies: AuthorizationPolicy[] = [allowPolicy];

describe('policy engine', () => {
  it('loads policies by tenant and preserves explicit deny precedence', async () => {
    const engine = new PersistentPolicyEngine((organizationId) =>
      Promise.resolve(
        organizationId === 'organization-a'
          ? [
              {
                id: 'allow-production',
                organizationId: 'organization-a',
                principalIds: ['user-a'],
                resource: allowPolicy.resource,
                action: allowPolicy.action,
                effect: 'allow',
              },
              {
                id: 'deny-production',
                organizationId: 'organization-a',
                principalIds: ['user-a'],
                resource: allowPolicy.resource,
                action: allowPolicy.action,
                effect: 'deny',
              },
              {
                id: 'foreign',
                organizationId: 'organization-b',
                principalIds: ['user-a'],
                resource: allowPolicy.resource,
                action: allowPolicy.action,
                effect: 'allow',
              },
            ]
          : [],
      ),
    );
    await expect(
      engine.authorize({
        organizationId: 'organization-a',
        principalId: 'user-a',
        resource: allowPolicy.resource,
        action: allowPolicy.action,
        groupIds: [],
        evaluatedAt: new Date('2026-09-15T12:00:00.000Z'),
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'explicit deny' });
  });

  it('allows a matching tenant, principal, group, resource, action and time', async () => {
    const decision = await new InMemoryPolicyEngine(policies).authorize({
      organizationId: 'organization-a',
      principalId: 'user-a',
      resource: 'mcp.database.production',
      action: 'execute',
      groupIds: ['developers'],
      evaluatedAt: new Date('2026-09-01T12:00:00Z'),
    });
    expect(decision).toEqual({ allowed: true, policyIds: ['allow-developers'] });
  });

  it('defaults to deny across tenants and gives explicit deny precedence', async () => {
    const engine = new InMemoryPolicyEngine([
      ...policies,
      { ...allowPolicy, id: 'deny-user', effect: 'deny' },
    ]);
    const denied = await engine.authorize({
      organizationId: 'organization-a',
      principalId: 'user-a',
      resource: 'mcp.database.production',
      action: 'execute',
      groupIds: ['developers'],
      evaluatedAt: new Date('2026-09-01T12:00:00Z'),
    });
    expect(denied).toMatchObject({ allowed: false, reason: 'explicit deny' });

    const crossTenant = await engine.authorize({
      organizationId: 'organization-b',
      principalId: 'user-a',
      resource: 'mcp.database.production',
      action: 'execute',
      groupIds: ['developers'],
      evaluatedAt: new Date('2026-09-01T12:00:00Z'),
    });
    expect(crossTenant).toEqual({ allowed: false, reason: 'no matching policy' });
  });

  it('parses the final segment as the action', () => {
    expect(parsePermission('mcp.tool.execute')).toEqual({
      resource: 'mcp.tool',
      action: 'execute',
    });
    expect(() => parsePermission('invalid')).toThrow(TypeError);
  });

  it('evaluates ABAC attributes and requires all tenant approvers', async () => {
    const engine = new InMemoryPolicyEngine([
      { ...allowPolicy, conditions: { attributes: { environment: 'prod' } } },
    ]);
    await expect(
      engine.authorize({
        organizationId: 'organization-a',
        principalId: 'user-a',
        resource: allowPolicy.resource,
        action: allowPolicy.action,
        groupIds: [],
        attributes: { environment: 'prod' },
        evaluatedAt: new Date(),
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      engine.authorize({
        organizationId: 'organization-a',
        principalId: 'user-a',
        resource: allowPolicy.resource,
        action: allowPolicy.action,
        groupIds: [],
        attributes: { environment: 'dev' },
        evaluatedAt: new Date(),
      }),
    ).resolves.toMatchObject({ allowed: false });
    const approvals = new InMemoryApprovalService();
    await approvals.request({
      id: 'approval',
      organizationId: 'organization-a',
      requesterId: 'user-a',
      resource: 'deploy',
      action: 'execute',
      payloadDigest: 'digest',
      requiredApprovers: ['admin-a', 'admin-b'],
    });
    await expect(approvals.requireApproved('organization-a', 'approval')).rejects.toThrow(
      /required/,
    );
    await approvals.approve('organization-a', 'approval', 'admin-a');
    await expect(approvals.requireApproved('organization-a', 'approval')).rejects.toThrow(
      /required/,
    );
    await approvals.approve('organization-a', 'approval', 'admin-b');
    await expect(approvals.requireApproved('organization-a', 'approval')).resolves.toMatchObject({
      status: 'APPROVED',
    });
  });
});
