import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { AttachmentStorage, MalwareScanner } from '@handstack/chat';
import { Injectable } from '@nestjs/common';

interface DownloadClaim {
  readonly key: string;
  readonly expiresAt: number;
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

@Injectable()
export class LocalAttachmentStorage implements AttachmentStorage {
  private readonly root: string;
  private readonly signingSecret: string;

  constructor() {
    const configured =
      process.env.HANDSTACK_ATTACHMENT_STORAGE_PATH ?? '.handstack-data/attachments';
    this.root = resolve(configured);
    this.signingSecret =
      process.env.HANDSTACK_ATTACHMENT_SIGNING_SECRET ??
      process.env.HANDSTACK_ACCESS_TOKEN_SECRET ??
      '';
  }

  async put(key: string, content: Uint8Array): Promise<void> {
    const target = this.target(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx' });
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.target(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const claim = encode(
      JSON.stringify({ key, expiresAt: Math.floor(Date.now() / 1000) + expiresInSeconds }),
    );
    const signature = this.sign(claim);
    return Promise.resolve(`/api/v1/attachments/content?token=${claim}.${signature}`);
  }

  async readSigned(token: string): Promise<Uint8Array> {
    const [claim, signature, extra] = token.split('.');
    if (claim === undefined || signature === undefined || extra !== undefined)
      throw new Error('Invalid attachment token');
    const expected = Buffer.from(this.sign(claim), 'utf8');
    const actual = Buffer.from(signature, 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new Error('Invalid attachment token');
    let parsed: DownloadClaim;
    try {
      parsed = JSON.parse(Buffer.from(claim, 'base64url').toString('utf8')) as DownloadClaim;
    } catch {
      throw new Error('Invalid attachment token');
    }
    if (
      typeof parsed.key !== 'string' ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      parsed.expiresAt < Math.floor(Date.now() / 1000)
    )
      throw new Error('Expired or invalid attachment token');
    return readFile(this.target(parsed.key));
  }

  private sign(claim: string): string {
    if (this.signingSecret.length < 32)
      throw new Error('HANDSTACK_ATTACHMENT_SIGNING_SECRET must have at least 32 characters');
    return createHmac('sha256', this.signingSecret).update(claim).digest('base64url');
  }

  private target(key: string): string {
    if (key === '' || key.includes('..') || key.includes('\\') || key.startsWith('/'))
      throw new Error('Attachment storage key is invalid');
    const target = resolve(this.root, key);
    if (!target.startsWith(`${this.root}${sep}`))
      throw new Error('Attachment path escaped storage');
    return target;
  }
}

@Injectable()
export class BuiltinMalwareScanner implements MalwareScanner {
  scan(input: { content: Uint8Array }): Promise<'CLEAN' | 'INFECTED'> {
    const sample = Buffer.from(input.content).toString('latin1');
    return Promise.resolve(
      sample.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'INFECTED' : 'CLEAN',
    );
  }
}
