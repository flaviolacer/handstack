export interface SecretRequestContext {
  readonly organizationId: string;
  readonly pluginId: string;
}

export interface SecretProvider {
  get(reference: string, context: SecretRequestContext): Promise<string | undefined>;
}

export type SecretResolver = () => Promise<string | undefined>;

export function scopedSecretResolver(
  provider: SecretProvider,
  reference: string | undefined,
  context: SecretRequestContext,
): SecretResolver {
  return reference === undefined
    ? () => Promise.resolve(undefined)
    : () => provider.get(reference, context);
}
