import { timingSafeEqual } from 'node:crypto';
import { AuthenticationError } from '@handstack/shared';

/** Validates the authenticated service boundary used by distributed workers. */
export function assertInternalServiceToken(
  header: string | string[] | undefined,
  configuredToken: string | undefined,
): void {
  const supplied = typeof header === 'string' ? /^Bearer (.+)$/u.exec(header)?.[1] : undefined;
  if (configuredToken === undefined || configuredToken.length < 32 || supplied === undefined)
    throw new AuthenticationError('Internal service authentication is required');
  const expectedBytes = Buffer.from(configuredToken);
  const suppliedBytes = Buffer.from(supplied);
  if (
    expectedBytes.length !== suppliedBytes.length ||
    !timingSafeEqual(expectedBytes, suppliedBytes)
  )
    throw new AuthenticationError('Internal service authentication failed');
}
