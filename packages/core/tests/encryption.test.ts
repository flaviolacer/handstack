import { describe, expect, it } from 'vitest';
import {
  EncryptedSecretStore,
  EncryptionError,
  MasterKey,
  openSecret,
  parseEnvelope,
  sealSecret,
  secretAad,
} from '../src/index.js';

describe('master key', () => {
  it('decodes a 32-byte base64 key and derives deterministic purpose keys', () => {
    const key = MasterKey.decode('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=');
    const first = key.derive('secret-encryption');
    const second = key.derive('secret-encryption');
    expect(first).toEqual(second);
    expect(first).toHaveLength(32);
  });

  it('separates keys by purpose', () => {
    const key = MasterKey.generate();
    expect(key.derive('a')).not.toEqual(key.derive('b'));
  });

  it('rejects keys that do not decode to 32 bytes', () => {
    expect(() => MasterKey.decode('c2hvcnQ=')).toThrow(EncryptionError);
    expect(() => MasterKey.fromBytes(new Uint8Array(16))).toThrow(EncryptionError);
  });

  it('reads the master key from HANDSTACK_MASTER_KEY', () => {
    const hex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    const loaded = MasterKey.fromEnvironment({ HANDSTACK_MASTER_KEY: hex });
    expect(loaded?.equals(MasterKey.decode(hex))).toBe(true);
  });

  it('returns undefined when the environment variable is absent', () => {
    expect(MasterKey.fromEnvironment({})).toBeUndefined();
  });

  it('decodes hex and base64 forms of the same key to equal keys', () => {
    const hex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    const base64 = Buffer.from(hex, 'hex').toString('base64');
    expect(MasterKey.decode(hex).equals(MasterKey.decode(base64))).toBe(true);
  });
});

describe('AES-256-GCM sealing', () => {
  const key = MasterKey.generate().derive('secret-encryption');
  const aad = secretAad({ organizationId: 'org-a', pluginId: 'plugin-oidc' });

  it('round-trips plaintext through seal and open', () => {
    const envelope = sealSecret('s3cr3t-value', key, aad);
    expect(openSecret(envelope, key, aad)).toBe('s3cr3t-value');
  });

  it('uses a fresh nonce per seal', () => {
    const first = sealSecret('same', key, aad);
    const second = sealSecret('same', key, aad);
    expect(first).not.toBe(second);
    expect(openSecret(first, key, aad)).toBe('same');
    expect(openSecret(second, key, aad)).toBe('same');
  });

  it('rejects a wrong key without leaking material', () => {
    const envelope = sealSecret('top-secret', key, aad);
    const wrongKey = MasterKey.generate().derive('secret-encryption');
    expect(() => openSecret(envelope, wrongKey, aad)).toThrow(/could not be decrypted/);
  });

  it('rejects mismatched AAD (cross-tenant or cross-plugin)', () => {
    const envelope = sealSecret('scoped', key, aad);
    const otherTenant = secretAad({ organizationId: 'org-b', pluginId: 'plugin-oidc' });
    expect(() => openSecret(envelope, key, otherTenant)).toThrow(EncryptionError);
  });

  it('rejects tampered ciphertext', () => {
    const envelope = sealSecret('integrity', key, aad);
    const sealed = parseEnvelope(envelope);
    const flipped = sealed.ciphertext.endsWith('A')
      ? `${sealed.ciphertext.slice(0, -1)}B`
      : `${sealed.ciphertext.slice(0, -1)}A`;
    const tampered = `${sealed.scheme}.${sealed.nonce}.${flipped}.${sealed.tag}`;
    expect(() => openSecret(tampered, key, aad)).toThrow(EncryptionError);
  });

  it('rejects malformed envelopes', () => {
    expect(() => openSecret('garbage', key, aad)).toThrow(EncryptionError);
    expect(() => parseEnvelope('hs-other-v1.a.b.c')).toThrow(EncryptionError);
  });

  it('encrypts empty and multibyte plaintext', () => {
    expect(openSecret(sealSecret('', key, aad), key, aad)).toBe('');
    expect(openSecret(sealSecret('dados sensíveis 日本語', key, aad), key, aad)).toBe(
      'dados sensíveis 日本語',
    );
  });
});

describe('encrypted secret store', () => {
  it('stores only sealed envelopes and opens within the sealing context', async () => {
    const store = new EncryptedSecretStore(MasterKey.generate());
    const context = { organizationId: 'org-a', pluginId: '@handstack/plugin-github' };
    store.set('secret://github/token', 'ghp_value', context);

    await expect(store.get('secret://github/token', context)).resolves.toBe('ghp_value');
    for (const [, envelope] of store.entries()) {
      expect(envelope).not.toContain('ghp_value');
    }
  });

  it('fails closed when opened from another organization', async () => {
    const store = new EncryptedSecretStore(MasterKey.generate());
    const context = { organizationId: 'org-a', pluginId: 'plugin' };
    store.set('secret://x', 'value', context);
    await expect(
      store.get('secret://x', { organizationId: 'org-b', pluginId: 'plugin' }),
    ).rejects.toHaveProperty('code', 'DECRYPTION_FAILED');
  });

  it('returns undefined for missing references and supports deletion', async () => {
    const store = new EncryptedSecretStore(MasterKey.generate());
    const context = { organizationId: 'org-a', pluginId: 'plugin' };
    await expect(store.get('secret://missing', context)).resolves.toBeUndefined();
    store.set('secret://y', 'value', context);
    expect(store.size).toBe(1);
    store.delete('secret://y');
    expect(store.size).toBe(0);
  });
});
