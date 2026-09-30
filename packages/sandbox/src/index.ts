import { randomUUID } from 'node:crypto';
import type { ExtensionHealth, ExtensionProvider, JsonSchema } from '@handstack/core';
import { spawn } from 'node:child_process';

export type SandboxNetworkPolicy = 'deny-all' | 'allow-listed';

export interface SandboxDestination {
  readonly host: string;
  readonly port?: number;
  readonly protocol: 'https' | 'http' | 'tcp';
  /** Explicitly permits a private/loopback/link-local destination; still subject to the allowlist. */
  readonly allowPrivateNetwork?: boolean;
}

export interface SandboxResourceLimits {
  readonly cpuMilliCores?: number;
  readonly memoryBytes?: number;
  readonly maxProcesses?: number;
  readonly executionTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxLogBytes: number;
}

export interface SecretHandle {
  readonly id: string;
  readonly scope: string;
  readonly expiresAt: number;
  readonly tenantId: string;
}

export interface SandboxArtifactPolicy {
  readonly ingress: 'none' | 'allow-listed' | 'all';
  readonly egress: 'none' | 'allow-listed' | 'all';
  readonly allowedPaths: readonly string[];
}

export interface SandboxNetworkProfile {
  readonly policy: SandboxNetworkPolicy;
  readonly allowlist: readonly SandboxDestination[];
}

export interface SandboxProfile {
  readonly id: string;
  readonly organizationId: string;
  readonly executionIdentity: string;
  readonly resourceLimits: SandboxResourceLimits;
  readonly readOnlyRootFilesystem: boolean;
  readonly writableMounts: readonly string[];
  readonly network: SandboxNetworkProfile;
  readonly secretHandles: readonly SecretHandle[];
  /** Allowlist of syscall/capability names available to the sandboxed execution. */
  readonly capabilities: readonly string[];
  readonly artifactPolicy: SandboxArtifactPolicy;
}

export type SandboxHandleStatus = 'READY' | 'TERMINATED' | 'FAILED';

export interface SandboxHandle {
  readonly id: string;
  readonly profile: SandboxProfile;
  readonly status: SandboxHandleStatus;
}

export interface SandboxExecutionRequest {
  readonly command?: readonly string[];
  readonly image?: string;
  readonly stdin?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Requested secret scopes; every one must resolve to a valid, unexpired, tenant-bound handle. */
  readonly secrets?: readonly string[];
  /** Explicit network targets; each must satisfy the profile network allowlist and SSRF policy. */
  readonly networkTargets?: readonly SandboxDestination[];
  readonly signal?: AbortSignal;
  /** Bidirectional request broker supported only by the process executor. */
  readonly rpcHandler?: (request: unknown) => Promise<unknown>;
}

export interface SandboxExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface SandboxProvider {
  readonly id: string;
  prepare(profile: SandboxProfile): Promise<SandboxHandle>;
  execute(handle: SandboxHandle, request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
  terminate(handle: SandboxHandle): Promise<void>;
}

export type SandboxErrorCode =
  | 'sandbox_denied'
  | 'sandbox_timeout'
  | 'sandbox_unavailable'
  | 'sandbox_limits_exceeded'
  | 'sandbox_invalid_profile';

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly status = 500;

  constructor(code: SandboxErrorCode, message: string) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
  }
}

/** Executor injected behind the process-isolated provider so tests never spawn real processes. */
export interface SandboxExecutorInput {
  readonly argv: readonly string[];
  readonly profile: SandboxProfile;
  readonly stdin?: string;
  readonly signal?: AbortSignal;
  readonly rpcHandler?: (request: unknown) => Promise<unknown>;
}

export interface SandboxExecutorOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface SandboxExecutor {
  run(input: SandboxExecutorInput): Promise<SandboxExecutorOutput>;
}

/**
 * Real child-process executor for the process sandbox. The sandbox provider
 * remains responsible for authorization; this class only owns process
 * lifecycle, cancellation, timeout and bounded output collection.
 */
export class NodeProcessSandboxExecutor implements SandboxExecutor {
  run(input: SandboxExecutorInput): Promise<SandboxExecutorOutput> {
    const [command, ...arguments_] = input.argv;
    if (command === undefined || command.trim() === '')
      return Promise.reject(new SandboxError('sandbox_denied', 'sandbox command is required'));
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(command, arguments_, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stdoutPending = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', abort);
        callback();
      };
      const abort = (): void => {
        child.kill();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, input.profile.resourceLimits.executionTimeoutMs);
      input.signal?.addEventListener('abort', abort, { once: true });
      child.on('error', (error) => {
        finish(() => {
          reject(error);
        });
      });
      const handleStdoutLine = (line: string): void => {
        let message: { type?: unknown; id?: unknown; request?: unknown } | undefined;
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          // Non-protocol stdout is preserved for the caller.
        }
        if (
          message?.type === 'handstack_rpc_request' &&
          typeof message.id === 'string' &&
          input.rpcHandler !== undefined
        ) {
          void input.rpcHandler(message.request).then(
            (result) => {
              if (!settled)
                child.stdin.write(
                  `${JSON.stringify({ type: 'handstack_rpc_response', id: message.id, result })}\n`,
                );
            },
            () => {
              if (!settled)
                child.stdin.write(
                  `${JSON.stringify({
                    type: 'handstack_rpc_response',
                    id: message.id,
                    error: 'Host capability request failed',
                  })}\n`,
                );
            },
          );
          return;
        }
        stdout = appendBounded(stdout, `${line}\n`, input.profile.resourceLimits.maxOutputBytes);
      };
      child.stdout.on('data', (chunk: Buffer | string) => {
        stdoutPending = appendBounded(
          stdoutPending,
          chunk,
          input.profile.resourceLimits.maxOutputBytes + 1,
        );
        let newline = stdoutPending.indexOf('\n');
        while (newline >= 0) {
          handleStdoutLine(stdoutPending.slice(0, newline).replace(/\r$/u, ''));
          stdoutPending = stdoutPending.slice(newline + 1);
          newline = stdoutPending.indexOf('\n');
        }
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr = appendBounded(stderr, chunk, input.profile.resourceLimits.maxLogBytes);
      });
      child.on('close', (exitCode) => {
        finish(() => {
          if (stdoutPending.length > 0)
            stdout = appendBounded(
              stdout,
              stdoutPending,
              input.profile.resourceLimits.maxOutputBytes,
            );
          resolve({
            exitCode: exitCode ?? 1,
            stdout,
            stderr,
            durationMs: Date.now() - startedAt,
            timedOut,
          });
        });
      });
      if (input.stdin !== undefined) child.stdin.write(input.stdin);
      if (input.rpcHandler === undefined) child.stdin.end();
    });
  }
}

function appendBounded(current: string, chunk: Buffer | string, limit: number): string {
  const next = current + chunk.toString();
  return next.length <= limit ? next : next.slice(0, limit);
}

/** Container runtime injected behind the container provider (e.g. a Docker-compatible client). */
export interface ContainerRuntimeInput {
  readonly image: string;
  readonly profile: SandboxProfile;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface ContainerRuntime {
  run(input: ContainerRuntimeInput): Promise<SandboxExecutorOutput>;
}

export function validateSandboxProfile(profile: SandboxProfile): void {
  if (profile.id.trim() === '')
    throw new SandboxError('sandbox_invalid_profile', 'profile id is required');
  if (profile.organizationId.trim() === '')
    throw new SandboxError('sandbox_invalid_profile', 'organizationId is required');
  if (profile.executionIdentity.trim() === '')
    throw new SandboxError('sandbox_invalid_profile', 'executionIdentity is required');
  if (profile.resourceLimits.executionTimeoutMs <= 0)
    throw new SandboxError('sandbox_invalid_profile', 'executionTimeoutMs must be positive');
  if (profile.resourceLimits.maxOutputBytes <= 0)
    throw new SandboxError('sandbox_invalid_profile', 'maxOutputBytes must be positive');
  if (profile.resourceLimits.maxLogBytes <= 0)
    throw new SandboxError('sandbox_invalid_profile', 'maxLogBytes must be positive');
  if (profile.network.policy === 'allow-listed' && profile.network.allowlist.length === 0)
    throw new SandboxError(
      'sandbox_invalid_profile',
      'allow-listed network policy requires an allowlist',
    );
  for (const destination of profile.network.allowlist) validateDestination(destination);
  for (const handle of profile.secretHandles) {
    if (handle.scope.trim() === '')
      throw new SandboxError('sandbox_invalid_profile', 'secret scope is required');
    if (handle.expiresAt <= 0)
      throw new SandboxError('sandbox_invalid_profile', 'secret handle expiry is required');
    if (handle.tenantId !== profile.organizationId)
      throw new SandboxError(
        'sandbox_invalid_profile',
        'secret handle tenant must match the profile organization',
      );
  }
  if (profile.artifactPolicy.allowedPaths.some((path) => path.trim() === ''))
    throw new SandboxError('sandbox_invalid_profile', 'artifact allowed paths must be non-empty');
}

function validateDestination(destination: SandboxDestination): void {
  if (destination.host.trim() === '')
    throw new SandboxError('sandbox_invalid_profile', 'destination host is required');
  if (destination.port !== undefined && (destination.port < 1 || destination.port > 65535))
    throw new SandboxError('sandbox_invalid_profile', 'destination port is out of range');
}

function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.').map((part) => Number(part));
  const [first = 0, second = 0] = octets;
  return (
    first === 10 ||
    first === 127 ||
    first === 0 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  )
    return true;
  return normalized.startsWith('fc') || normalized.startsWith('fd');
}

/**
 * Determines whether a host is a network target that must be blocked by default. Private, loopback,
 * link-local, metadata, and reserved-suffix hosts are denied unless a destination explicitly opts
 * in with `allowPrivateNetwork`. Hostname targets that are not literals are treated as public here
 * and remain subject to runtime DNS revalidation (DNS-rebinding protection) by the executor.
 */
export function isBlockedNetworkTarget(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (normalized.endsWith('.local') || normalized.endsWith('.internal')) return true;
  if (normalized === 'metadata.google.internal' || normalized === '169.254.169.254') return true;
  if (isIpv4Literal(normalized)) return isPrivateIpv4(normalized);
  if (normalized.includes(':')) return isPrivateIpv6(normalized);
  return false;
}

export function isDestinationAllowed(
  destination: SandboxDestination,
  profile: SandboxProfile,
): boolean {
  if (profile.network.policy === 'deny-all') return false;
  const blocked = isBlockedNetworkTarget(destination.host);
  if (blocked && destination.allowPrivateNetwork !== true) return false;
  return profile.network.allowlist.some(
    (allowed) =>
      allowed.host === destination.host &&
      allowed.protocol === destination.protocol &&
      (allowed.port === undefined ||
        destination.port === undefined ||
        allowed.port === destination.port),
  );
}

export function enforceOutputLimits(
  output: SandboxExecutorOutput,
  profile: SandboxProfile,
): SandboxExecutionResult {
  const stdoutTruncated = output.stdout.length > profile.resourceLimits.maxOutputBytes;
  const stderrTruncated = output.stderr.length > profile.resourceLimits.maxLogBytes;
  return {
    exitCode: output.exitCode,
    stdout: output.stdout.slice(0, profile.resourceLimits.maxOutputBytes),
    stderr: output.stderr.slice(0, profile.resourceLimits.maxLogBytes),
    truncated: stdoutTruncated || stderrTruncated,
    durationMs: output.durationMs,
    timedOut: output.timedOut,
  };
}

function authorizeRequestedSecrets(
  request: SandboxExecutionRequest,
  profile: SandboxProfile,
  now: number,
): void {
  for (const scope of request.secrets ?? []) {
    const handle = profile.secretHandles.find((candidate) => candidate.scope === scope);
    if (handle === undefined)
      throw new SandboxError('sandbox_denied', 'requested secret scope was not provisioned');
    if (handle.expiresAt <= now)
      throw new SandboxError('sandbox_denied', 'secret handle has expired');
    if (handle.tenantId !== profile.organizationId)
      throw new SandboxError('sandbox_denied', 'secret handle belongs to another tenant');
  }
}

function authorizeNetworkTargets(request: SandboxExecutionRequest, profile: SandboxProfile): void {
  for (const target of request.networkTargets ?? []) {
    if (!isDestinationAllowed(target, profile))
      throw new SandboxError('sandbox_denied', 'network destination is not allowed by the profile');
  }
}

function makeHandle(profile: SandboxProfile): SandboxHandle {
  validateSandboxProfile(profile);
  return { id: randomUUID(), profile, status: 'READY' };
}

abstract class TrackedSandboxProvider implements SandboxProvider {
  abstract readonly id: string;
  abstract execute(
    handle: SandboxHandle,
    request: SandboxExecutionRequest,
  ): Promise<SandboxExecutionResult>;
  private readonly handles = new Map<string, SandboxHandle>();

  prepare(profile: SandboxProfile): Promise<SandboxHandle> {
    const handle = makeHandle(profile);
    this.handles.set(handle.id, handle);
    return Promise.resolve(handle);
  }

  protected currentHandle(id: string): SandboxHandle {
    const handle = this.handles.get(id);
    if (handle === undefined) throw new SandboxError('sandbox_denied', 'sandbox handle not found');
    if (handle.status !== 'READY') throw new SandboxError('sandbox_denied', 'sandbox is not ready');
    return handle;
  }

  terminate(handle: SandboxHandle): Promise<void> {
    const current = this.handles.get(handle.id);
    if (current === undefined)
      return Promise.reject(new SandboxError('sandbox_denied', 'sandbox handle not found'));
    this.handles.set(handle.id, { ...current, status: 'TERMINATED' });
    return Promise.resolve();
  }
}

/** Official process-isolated development sandbox. Actual process spawn is delegated to the executor. */
export class ProcessIsolatedSandboxProvider extends TrackedSandboxProvider {
  readonly id = 'handstack.sandbox.process';

  constructor(private readonly executor: SandboxExecutor) {
    super();
  }

  async execute(
    handle: SandboxHandle,
    request: SandboxExecutionRequest,
  ): Promise<SandboxExecutionResult> {
    const current = this.currentHandle(handle.id);
    authorizeRequestedSecrets(request, current.profile, Date.now());
    authorizeNetworkTargets(request, current.profile);
    const command = request.command;
    if (command === undefined || command.length === 0)
      throw new SandboxError('sandbox_denied', 'process sandbox requires a command');
    const input: SandboxExecutorInput = {
      argv: command,
      profile: current.profile,
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(request.rpcHandler !== undefined ? { rpcHandler: request.rpcHandler } : {}),
    };
    const output = await this.executor.run(input);
    return enforceOutputLimits(output, current.profile);
  }
}

/** Official container sandbox for production. Container execution is delegated to a runtime client. */
export class ContainerSandboxProvider extends TrackedSandboxProvider {
  readonly id = 'handstack.sandbox.container';

  constructor(private readonly runtime: ContainerRuntime) {
    super();
  }

  async execute(
    handle: SandboxHandle,
    request: SandboxExecutionRequest,
  ): Promise<SandboxExecutionResult> {
    const current = this.currentHandle(handle.id);
    authorizeRequestedSecrets(request, current.profile, Date.now());
    authorizeNetworkTargets(request, current.profile);
    if (request.rpcHandler !== undefined)
      throw new SandboxError('sandbox_unavailable', 'container sandbox does not support host RPC');
    const image = request.image;
    if (image === undefined || image.trim() === '')
      throw new SandboxError('sandbox_denied', 'container sandbox requires an image');
    const input: ContainerRuntimeInput = {
      image,
      profile: current.profile,
      ...(request.env !== undefined ? { env: request.env } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    };
    const output = await this.runtime.run(input);
    return enforceOutputLimits(output, current.profile);
  }
}

/** Fail-closed provider used when no concrete executor is configured for an isolated runtime. */
export class FailClosedSandboxProvider extends TrackedSandboxProvider {
  readonly id = 'handstack.sandbox.fail-closed';

  execute(): Promise<SandboxExecutionResult> {
    return Promise.reject(
      new SandboxError('sandbox_unavailable', 'no sandbox executor is available'),
    );
  }
}

export interface SandboxExtensionMeta {
  readonly id: string;
  readonly apiVersion: string;
  readonly capabilities: readonly string[];
  readonly configurationSchema: JsonSchema;
  readonly requiredPermissions: readonly string[];
}

/** Wraps a {@link SandboxProvider} into the versioned `sandbox` extension point contract. */
export function sandboxExtensionProvider(
  provider: SandboxProvider,
  meta: SandboxExtensionMeta,
): ExtensionProvider & { readonly sandbox: SandboxProvider } {
  const health = (): Promise<ExtensionHealth> => Promise.resolve({ status: 'healthy' });
  return {
    id: meta.id,
    type: 'sandbox',
    apiVersion: meta.apiVersion,
    capabilities: meta.capabilities,
    configurationSchema: meta.configurationSchema,
    requiredPermissions: meta.requiredPermissions,
    health,
    sandbox: provider,
  };
}
