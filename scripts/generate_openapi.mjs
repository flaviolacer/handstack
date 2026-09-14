import fs from 'node:fs/promises';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.HANDSTACK_DATABASE_ADAPTER ??= 'sqlite';
process.env.HANDSTACK_DATABASE_URL ??= 'file::memory:';
process.env.HANDSTACK_ACCESS_TOKEN_SECRET ??= 'openapi-generation-secret-at-least-32-characters';
process.env.HANDSTACK_TOKEN_PEPPER ??= 'openapi-generation-pepper-at-least-32-characters';

const { createApplication } = await import('../apps/api/dist/main.js');
const app = await createApplication();
await app.init();
await app.getHttpAdapter().getInstance().ready();
const response = await app.inject({ method: 'GET', url: '/api/openapi.json' });
if (response.statusCode !== 200)
  throw new Error(`OpenAPI endpoint returned ${response.statusCode}`);
const document = response.json();
const outputPath = path.resolve('docs/api/openapi.json');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
await app.close();
console.log(`OpenAPI generated: ${outputPath}`);
