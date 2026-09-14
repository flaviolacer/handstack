import { describe, expect, it } from 'vitest';
import {
  ContainerSandboxProvider,
  FailClosedSandboxProvider,
  ProcessIsolatedSandboxProvider,
  SandboxError,
  enforceOutputLimits,
  isBlockedNetworkTarget,
  isDestinationAllowed,
  sandboxExtensionProvider,
  validateSandboxProfile,
  type ContainerRuntime,
  type SandboxExecutor,
  type SandboxProfile,
  type SandboxProvider,
} from '../src/index.js';

function profile(overrides?: Partial<SandboxProfile>): SandboxProfile {
  return {
    id: 'profile-1',
    organizationId: 'org-a',
    executionIdentity: 'agent-run-1',
    resourceLimits: {
      executionTimeoutMs: 5000,
      maxOutputBytes: 64,
      maxLogBytes: 64,
    },
    readOnlyRootFilesystem: true,
    writableMounts: ['/tmp'],
    network: {
      policy: 'allow-listed',
      allowlist: [{ host: 'api.example.com', protocol: 'https' }],
    },
    secretHandles: [
      { id: 'sh-1', scope: 'github.token', expiresAt: Date.now() + 60_000, tenantId: 'org-a' },
    ],
    capabilities: [],
    artifactPolicy: { ingress: 'none', egress: 'none', allowedPaths: [] },
    ...overrides,
  };
}

describe('sandbox profile validation', () => {
  it('accepts a complete profile', () => {
    expect(() => {
      validateSandboxProfile(profile());
    }).not.toThrow();
  });

  it('rejects invalid profiles', () => {
    expect(() => {
      validateSandboxProfile(profile({ organizationId: '' }));
    }).toThrow(SandboxError);
    expect(() => {
      validateSandboxProfile(
        profile({ resourceLimits: { executionTimeoutMs: 0, maxOutputBytes: 64, maxLogBytes: 64 } }),
      );
    }).toThrow(SandboxError);
    expect(() => {
      validateSandboxProfile(
        profile({
          resourceLimits: { executionTimeoutMs: 100, maxOutputBytes: 0, maxLogBytes: 64 },
        }),
      );
    }).toThrow(SandboxError);
    expect(() => {
      validateSandboxProfile(profile({ network: { policy: 'allow-listed', allowlist: [] } }));
    }).toThrow(SandboxError);
    expect(() => {
      validateSandboxProfile(
        profile({ secretHandles: [{ id: 'sh', scope: 'x', expiresAt: 1, tenantId: 'org-b' }] }),
      );
    }).toThrow(SandboxError);
  });
});

describe('network and SSRF policy', () => {
  it('blocks localhost, private, link-local and metadata targets', () => {
    for (const host of [
      'localhost',
      'foo.internal',
      '169.254.169.254',
      'metadata.google.internal',
      '10.0.0.1',
      '127.0.0.1',
      '192.168.1.10',
      '172.16.0.1',
      '100.64.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
    ]) {
      expect(isBlockedNetworkTarget(host)).toBe(true);
    }
  });

  it('allows public literals and hostnames', () => {
    expect(isBlockedNetworkTarget('8.8.8.8')).toBe(false);
    expect(isBlockedNetworkTarget('api.example.com')).toBe(false);
  });

  it('enforces deny-by-default and the allowlist', () => {
    const denyAll = profile({ network: { policy: 'deny-all', allowlist: [] } });
    expect(isDestinationAllowed({ host: 'api.example.com', protocol: 'https' }, denyAll)).toBe(
      false,
    );

    const allow = profile();
    expect(isDestinationAllowed({ host: 'api.example.com', protocol: 'https' }, allow)).toBe(true);
    expect(isDestinationAllowed({ host: 'evil.example.com', protocol: 'https' }, allow)).toBe(
      false,
    );

    const privateAllowed = profile({
      network: {
        policy: 'allow-listed',
        allowlist: [{ host: '10.0.0.5', protocol: 'tcp', allowPrivateNetwork: true }],
      },
    });
    expect(
      isDestinationAllowed(
        { host: '10.0.0.5', protocol: 'tcp', allowPrivateNetwork: true },
        privateAllowed,
      ),
    ).toBe(true);
  });
});

describe('output bounding', () => {
  it('truncates stdout and stderr to profile limits', () => {
    const result = enforceOutputLimits(
      {
        exitCode: 0,
        stdout: 'a'.repeat(100),
        stderr: 'b'.repeat(80),
        durationMs: 5,
        timedOut: false,
      },
      profile(),
    );
    expect(result.stdout).toHaveLength(64);
    expect(result.stderr).toHaveLength(64);
    expect(result.truncated).toBe(true);
  });
});

describe('process-isolated sandbox provider', () => {
  const executor: SandboxExecutor = {
    run: (input) =>
      Promise.resolve({
        exitCode: 0,
        stdout: `argv=${input.argv.join(',')}`,
        stderr: '',
        durationMs: 5,
        timedOut: false,
      }),
  };

  it('executes an allowlisted command through the injected executor', async () => {
    const provider = new ProcessIsolatedSandboxProvider(executor);
    const handle = await provider.prepare(profile());
    const result = await provider.execute(handle, {
      command: ['echo', 'hi'],
      networkTargets: [{ host: 'api.example.com', protocol: 'https' }],
      secrets: ['github.token'],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('argv=echo,hi');
    expect(result.truncated).toBe(false);
  });

  it('denies a network target outside the allowlist', async () => {
    const provider = new ProcessIsolatedSandboxProvider(executor);
    const handle = await provider.prepare(profile());
    await expect(
      provider.execute(handle, {
        command: ['curl'],
        networkTargets: [{ host: 'evil.example.com', protocol: 'https' }],
      }),
    ).rejects.toThrow(SandboxError);
  });

  it('denies a secret scope that was not provisioned', async () => {
    const provider = new ProcessIsolatedSandboxProvider(executor);
    const handle = await provider.prepare(profile());
    await expect(
      provider.execute(handle, { command: ['x'], secrets: ['unprovisioned.scope'] }),
    ).rejects.toThrow(SandboxError);
  });

  it('refuses execution after termination', async () => {
    const provider = new ProcessIsolatedSandboxProvider(executor);
    const handle = await provider.prepare(profile());
    await provider.terminate(handle);
    await expect(provider.execute(handle, { command: ['echo'] })).rejects.toThrow(SandboxError);
  });
});

describe('container sandbox provider', () => {
  const runtime: ContainerRuntime = {
    run: (input) =>
      Promise.resolve({
        exitCode: 0,
        stdout: `image=${input.image}`,
        stderr: '',
        durationMs: 5,
        timedOut: false,
      }),
  };

  it('executes a container with a required image', async () => {
    const provider = new ContainerSandboxProvider(runtime);
    const handle = await provider.prepare(profile());
    const result = await provider.execute(handle, { image: 'gcr.io/handstack/runner:1' });
    expect(result.stdout).toContain('image=gcr.io/handstack/runner:1');
  });

  it('rejects execution without an image', async () => {
    const provider = new ContainerSandboxProvider(runtime);
    const handle = await provider.prepare(profile());
    await expect(provider.execute(handle, {})).rejects.toThrow(SandboxError);
  });
});

describe('fail-closed provider and extension wiring', () => {
  it('fails closed when no executor is configured', async () => {
    const provider: SandboxProvider = new FailClosedSandboxProvider();
    const handle = await provider.prepare(profile());
    await expect(provider.execute(handle, {})).rejects.toThrow(SandboxError);
  });

  it('wraps a provider as a sandbox extension with healthy state', async () => {
    const provider = new FailClosedSandboxProvider();
    const extension = sandboxExtensionProvider(provider, {
      id: '@handstack/sandbox-test',
      apiVersion: '1',
      capabilities: ['sandbox.execute'],
      configurationSchema: { type: 'object' },
      requiredPermissions: ['sandbox.execute'],
    });
    expect(extension.type).toBe('sandbox');
    await expect(extension.health({ signal: new AbortController().signal })).resolves.toEqual({
      status: 'healthy',
    });
    expect(extension.sandbox).toBe(provider);
  });
});
