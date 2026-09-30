import { configLayerFromEnvironment } from '@handstack/config';

export interface CliRuntimeConfig {
  readonly apiUrl?: string | undefined;
  readonly organizationId?: string | undefined;
  readonly accessToken?: string | undefined;
  readonly portableSigningKey?: string | undefined;
}

export function cliRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): CliRuntimeConfig {
  return configLayerFromEnvironment(environment).cli ?? {};
}

export function requiredCliRuntimeConfig(): {
  readonly apiUrl: string;
  readonly organizationId: string;
  readonly accessToken: string;
} {
  const config = cliRuntimeConfig();
  const apiUrl = config.apiUrl?.trim();
  const organizationId = config.organizationId?.trim();
  const accessToken = config.accessToken?.trim();
  if (apiUrl === undefined || apiUrl === '') throw new Error('HANDSTACK_API_URL is required');
  if (organizationId === undefined || organizationId === '')
    throw new Error('HANDSTACK_ORGANIZATION_ID is required');
  if (accessToken === undefined || accessToken === '')
    throw new Error('HANDSTACK_ACCESS_TOKEN is required');
  return { apiUrl, organizationId, accessToken };
}

export function requiredPortableSigningKey(environment: NodeJS.ProcessEnv = process.env): string {
  const key = cliRuntimeConfig(environment).portableSigningKey?.trim();
  if (key === undefined || key === '')
    throw new Error('HANDSTACK_PORTABLE_SIGNING_KEY is required');
  return key;
}
