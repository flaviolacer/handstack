import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { SecretProvider, SecretRequestContext } from './secrets.js';

/** Environment variable that supplies the 256-bit master key for encryption at rest. */
export const HANDSTACK_MASTER_KEY_ENV = 'HANDSTACK_MASTER_KEY';

/** Stable scheme identifier stamped on every sealed value and its envelope. */
export const SECRET_ENCRYPTION_SCHEME = 'hs-aes256gcm-v1';

const MASTER_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

export type EncryptionErrorCode = 'INVALID_MASTER_KEY' | 'INVALID_ENVELOPE' | 'DECRYPTION_FAILED';

/**
 * Typed failure for encryption operations. The message never includes plaintext, key material,
 * or ciphertext so that it is safe to surface in logs and Problem Details.
 */
export class EncryptionError extends Error {
  readonly code: EncryptionErrorCode;

  constructor(code: EncryptionErrorCode, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'EncryptionError';
    this.code = code;
  }
}

export interface SealedSecret {
  readonly scheme: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

/** Context bound to ciphertext through GCM additional authenticated data. */
export interface SecretAadContext {
  readonly organizationId: string;
  readonly pluginId: string;
}

export function secretAad(context: SecretAadContext): string {
  return `handstack:secret:v1:${context.organizationId}:${context.pluginId}`;
}

function decodeBase64(value: string, label: string): Buffer {
  for (const encoding of ['base64url', 'base64'] as const) {
    try {
      const decoded = Buffer.from(value, encoding);
      const reencoded = decoded.toString(encoding);
      if (reencoded === value) return decoded;
    } catch {
      // Try the next encoding.
    }
  }
  throw new EncryptionError('INVALID_MASTER_KEY', `${label} is not valid base64.`);
}

/**
 * A 256-bit master key loaded from `HANDSTACK_MASTER_KEY` (base64 or hex). It is kept private and
 * is never rendered back to strings; callers derive purpose keys through {@link MasterKey.derive}.
 */
export class MasterKey {
  readonly #key: Buffer;

  private constructor(key: Buffer) {
    this.#key = key;
  }

  static generate(): MasterKey {
    return new MasterKey(randomBytes(MASTER_KEY_BYTES));
  }

  static fromBytes(bytes: Uint8Array): MasterKey {
    const key = Buffer.from(bytes);
    if (key.byteLength !== MASTER_KEY_BYTES) {
      throw new EncryptionError(
        'INVALID_MASTER_KEY',
        `master key must be ${MASTER_KEY_BYTES.toString()} bytes.`,
      );
    }
    return new MasterKey(key);
  }

  /** Decodes a base64 (standard or URL-safe) or hex master key into 32 bytes. */
  static decode(value: string): MasterKey {
    const trimmed = value.trim();
    const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
      ? Buffer.from(trimmed, 'hex')
      : decodeBase64(trimmed, 'master key');
    if (key.byteLength !== MASTER_KEY_BYTES) {
      throw new EncryptionError(
        'INVALID_MASTER_KEY',
        `master key must decode to ${MASTER_KEY_BYTES.toString()} bytes, got ${key.byteLength.toString()}.`,
      );
    }
    return new MasterKey(key);
  }

  static fromEnvironment(
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): MasterKey | undefined {
    const value = env[HANDSTACK_MASTER_KEY_ENV];
    return value === undefined || value === '' ? undefined : MasterKey.decode(value);
  }

  /** Derives an independent 256-bit key for a purpose using HKDF-SHA256. */
  derive(purpose: string): Buffer {
    return Buffer.from(
      hkdfSync(
        'sha256',
        this.#key,
        Buffer.from(SECRET_ENCRYPTION_SCHEME, 'utf8'),
        Buffer.from(`${SECRET_ENCRYPTION_SCHEME}:${purpose}`, 'utf8'),
        MASTER_KEY_BYTES,
      ),
    );
  }

  equals(other: MasterKey): boolean {
    return timingSafeEqual(this.#key, other.#key);
  }
}

function toBase64Url(value: Buffer): string {
  return value.toString('base64url');
}

function fromBase64Url(value: string, label: string): Buffer {
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) {
      throw new Error('non-canonical base64url');
    }
    return decoded;
  } catch {
    throw new EncryptionError('INVALID_ENVELOPE', `${label} is not valid base64url.`);
  }
}

/**
 * Encrypts a UTF-8 secret with AES-256-GCM under a 256-bit purpose key. A random 96-bit nonce and a
 * 128-bit authentication tag are produced per call, and the AAD binds the ciphertext to its tenant
 * and plugin context.
 */
export function encryptSecret(plaintext: string, key: Buffer, aad: string): SealedSecret {
  if (key.byteLength !== MASTER_KEY_BYTES) {
    throw new EncryptionError('INVALID_MASTER_KEY', 'encryption key must be 32 bytes.');
  }
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return {
    scheme: SECRET_ENCRYPTION_SCHEME,
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(ciphertext),
    tag: toBase64Url(cipher.getAuthTag()),
  };
}

/**
 * Decrypts a {@link SealedSecret}. Failures from wrong keys, altered ciphertext, or mismatched AAD
 * are collapsed into a single redacted `DECRYPTION_FAILED` error that reveals no material.
 */
export function decryptSecret(sealed: SealedSecret, key: Buffer, aad: string): string {
  if (sealed.scheme !== SECRET_ENCRYPTION_SCHEME) {
    throw new EncryptionError('INVALID_ENVELOPE', 'unsupported sealed scheme.');
  }
  if (key.byteLength !== MASTER_KEY_BYTES) {
    throw new EncryptionError('INVALID_MASTER_KEY', 'decryption key must be 32 bytes.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, fromBase64Url(sealed.nonce, 'nonce'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    const tag = fromBase64Url(sealed.tag, 'tag');
    if (tag.byteLength !== GCM_TAG_BYTES) {
      throw new EncryptionError('INVALID_ENVELOPE', 'authentication tag has wrong size.');
    }
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(fromBase64Url(sealed.ciphertext, 'ciphertext')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    if (error instanceof EncryptionError) throw error;
    throw new EncryptionError('DECRYPTION_FAILED', 'secret could not be decrypted.');
  }
}

/** Encodes a {@link SealedSecret} as a single storable string. */
export function sealSecret(plaintext: string, key: Buffer, aad: string): string {
  const sealed = encryptSecret(plaintext, key, aad);
  return `${sealed.scheme}.${sealed.nonce}.${sealed.ciphertext}.${sealed.tag}`;
}

/** Parses a sealed envelope without decrypting it. */
export function parseEnvelope(envelope: string): SealedSecret {
  const parts = envelope.split('.');
  const scheme = parts[0];
  const nonce = parts[1];
  const ciphertext = parts[2];
  const tag = parts[3];
  if (
    scheme !== SECRET_ENCRYPTION_SCHEME ||
    nonce === undefined ||
    ciphertext === undefined ||
    tag === undefined ||
    parts.length !== 4
  ) {
    throw new EncryptionError('INVALID_ENVELOPE', 'malformed sealed envelope.');
  }
  return { scheme, nonce, ciphertext, tag };
}

/** Opens a storable envelope produced by {@link sealSecret}. */
export function openSecret(envelope: string, key: Buffer, aad: string): string {
  return decryptSecret(parseEnvelope(envelope), key, aad);
}

/**
 * A {@link SecretProvider} that stores only sealed envelopes, never plaintext. The same purpose key
 * is used for every record while tenant/plugin context is enforced through GCM AAD, so a secret can
 * only be opened within the organization and plugin that sealed it.
 */
export class EncryptedSecretStore implements SecretProvider {
  readonly #key: Buffer;
  readonly #records = new Map<string, string>();

  constructor(masterKey: MasterKey, purpose = 'secret-encryption') {
    this.#key = masterKey.derive(purpose);
  }

  set(reference: string, plaintext: string, context: SecretAadContext): void {
    this.#records.set(reference, sealSecret(plaintext, this.#key, secretAad(context)));
  }

  get(reference: string, context: SecretRequestContext): Promise<string | undefined> {
    const envelope = this.#records.get(reference);
    if (envelope === undefined) return Promise.resolve(undefined);
    return Promise.resolve().then(() => openSecret(envelope, this.#key, secretAad(context)));
  }

  delete(reference: string): void {
    this.#records.delete(reference);
  }

  get size(): number {
    return this.#records.size;
  }

  /** Exposes sealed envelopes for durable persistence without revealing plaintext. */
  entries(): readonly (readonly [string, string])[] {
    return [...this.#records.entries()];
  }
}
