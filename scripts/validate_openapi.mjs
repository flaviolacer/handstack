import fs from 'node:fs/promises';

const document = JSON.parse(await fs.readFile('docs/api/openapi.json', 'utf8'));
if (document.openapi !== '3.0.0' && !String(document.openapi ?? '').startsWith('3.1.')) {
  throw new Error('OpenAPI document must use OpenAPI 3.x');
}
if (!document.info?.title || !document.info?.version) throw new Error('OpenAPI info is incomplete');
if (!document.paths || Object.keys(document.paths).length === 0)
  throw new Error('OpenAPI has no paths');
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
const operationIds = new Set();
let operationCount = 0;
for (const [path, pathItem] of Object.entries(document.paths)) {
  const pathParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
  const pathVariables = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!methods.has(method)) continue;
    operationCount += 1;
    if (!operation.operationId || typeof operation.operationId !== 'string')
      throw new Error(`OpenAPI operation is missing operationId: ${method.toUpperCase()} ${path}`);
    if (operationIds.has(operation.operationId))
      throw new Error(`Duplicate OpenAPI operationId: ${operation.operationId}`);
    operationIds.add(operation.operationId);
    if (!operation.responses || Object.keys(operation.responses).length === 0)
      throw new Error(`OpenAPI operation has no responses: ${method.toUpperCase()} ${path}`);
    const parameters = [
      ...pathParameters,
      ...(Array.isArray(operation.parameters) ? operation.parameters : []),
    ];
    for (const variable of pathVariables) {
      const parameter = parameters.find(
        (item) => item.in === 'path' && item.name === variable && item.required === true,
      );
      if (!parameter)
        throw new Error(
          `OpenAPI path parameter is incomplete: ${method.toUpperCase()} ${path} {${variable}}`,
        );
    }
  }
}
const requiredPaths = [
  '/api/v1/organizations/{organizationId}/providers',
  '/api/v1/organizations/{organizationId}/models',
  '/api/v1/organizations/{organizationId}/conversations',
];
for (const route of requiredPaths)
  if (!document.paths[route]) throw new Error(`Missing OpenAPI route: ${route}`);
console.log(
  `OpenAPI valid: ${Object.keys(document.paths).length} paths, ${operationCount} operations`,
);
