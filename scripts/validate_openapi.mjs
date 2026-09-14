import fs from 'node:fs/promises';

const document = JSON.parse(await fs.readFile('docs/api/openapi.json', 'utf8'));
if (document.openapi !== '3.0.0' && !String(document.openapi ?? '').startsWith('3.1.')) {
  throw new Error('OpenAPI document must use OpenAPI 3.x');
}
if (!document.info?.title || !document.info?.version) throw new Error('OpenAPI info is incomplete');
if (!document.paths || Object.keys(document.paths).length === 0)
  throw new Error('OpenAPI has no paths');
const requiredPaths = [
  '/api/v1/organizations/{organizationId}/providers',
  '/api/v1/organizations/{organizationId}/models',
  '/api/v1/organizations/{organizationId}/conversations',
];
for (const route of requiredPaths)
  if (!document.paths[route]) throw new Error(`Missing OpenAPI route: ${route}`);
console.log(`OpenAPI valid: ${Object.keys(document.paths).length} paths`);
