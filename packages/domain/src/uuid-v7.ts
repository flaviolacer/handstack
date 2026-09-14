import { randomBytes } from 'node:crypto';

let lastTimestamp = -1;
let sequence = 0;

function nextTimestampAndSequence(now: number): readonly [number, number] {
  const timestamp = Math.max(Math.trunc(now), lastTimestamp);
  if (timestamp === lastTimestamp) {
    sequence += 1;
    if (sequence > 0x0fff) {
      lastTimestamp += 1;
      sequence = 0;
      return [lastTimestamp, sequence];
    }
  } else {
    lastTimestamp = timestamp;
    sequence = randomBytes(2).readUInt16BE() & 0x0fff;
  }
  return [lastTimestamp, sequence];
}

export function uuidV7(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new RangeError('UUIDv7 timestamp must be a non-negative 48-bit integer');
  }

  const [timestamp, counter] = nextTimestampAndSequence(now);
  const bytes = randomBytes(16);
  bytes[0] = Math.floor(timestamp / 0x10000000000) & 0xff;
  bytes[1] = Math.floor(timestamp / 0x100000000) & 0xff;
  bytes[2] = Math.floor(timestamp / 0x1000000) & 0xff;
  bytes[3] = Math.floor(timestamp / 0x10000) & 0xff;
  bytes[4] = Math.floor(timestamp / 0x100) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes[6] = 0x70 | ((counter >>> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
