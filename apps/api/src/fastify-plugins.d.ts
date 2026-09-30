// Load Fastify plugin module augmentations for every controller typecheck.
import '@fastify/cookie';
import '@fastify/multipart';

declare module 'fastify' {
  interface FastifyRequest {
    cookies: Record<string, string | undefined>;
    file: () => Promise<
      | {
          toBuffer: () => Promise<Buffer>;
          filename: string;
          mimetype: string;
        }
      | undefined
    >;
  }

  interface FastifyReply {
    setCookie: (name: string, value: string, options?: unknown) => FastifyReply;
    clearCookie: (name: string, options?: unknown) => FastifyReply;
  }
}
