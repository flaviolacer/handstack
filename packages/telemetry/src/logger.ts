import pino, { type DestinationStream, type Logger } from 'pino';

const redactedPaths = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'authorization',
  'cookie',
  'secret',
  'req.headers.authorization',
  'req.headers.cookie',
  'request.headers.authorization',
  'request.headers.cookie',
] as const;

export function createLogger(
  options: { readonly name: string; readonly level?: string },
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      name: options.name,
      level: options.level ?? 'info',
      base: null,
      redact: { paths: [...redactedPaths], censor: '[REDACTED]' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    destination,
  );
}

export class FrameworkLogger {
  constructor(private readonly logger: Logger) {}
  log(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.info({ optionalParameters }, messageToString(message));
  }
  error(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.error({ optionalParameters }, messageToString(message));
  }
  warn(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.warn({ optionalParameters }, messageToString(message));
  }
  debug(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.debug({ optionalParameters }, messageToString(message));
  }
  verbose(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.trace({ optionalParameters }, messageToString(message));
  }
  fatal(message: unknown, ...optionalParameters: unknown[]): void {
    this.logger.fatal({ optionalParameters }, messageToString(message));
  }
}

function messageToString(message: unknown): string {
  return typeof message === 'string' ? message : JSON.stringify(message);
}
