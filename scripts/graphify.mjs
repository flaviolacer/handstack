import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

const root = process.cwd();
const ignored = new Set(['.git', 'node_modules', 'dist', '.next', 'graphify-out', '.turbo']);
const extensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.yaml', '.yml']);

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (extensions.has(path.slice(path.lastIndexOf('.')))) result.push(path);
  }
  return result;
}

const nodes = [];
const edges = [];
for (const path of await files(root)) {
  const source = await readFile(path, 'utf8');
  const id = relative(root, path).replaceAll('\\', '/');
  nodes.push({ id, kind: 'file', lines: source.split(/\r?\n/u).length });
  for (const match of source.matchAll(
    /(?:from\s+|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]/gu,
  )) {
    const target = match[1];
    if (target?.startsWith('.')) edges.push({ from: id, to: target, kind: 'imports' });
  }
}
const links = edges.map(({ from, to, kind }) => ({ source: from, target: to, kind }));
const graph = {
  schemaVersion: 1,
  generator: 'handstack-graphify-v1',
  root: '.',
  directed: true,
  multigraph: false,
  nodes,
  links,
};
const output = resolve(root, 'graphify-out', 'graph.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
process.stdout.write(
  `Graph generated: ${output} (${String(nodes.length)} nodes, ${String(edges.length)} edges)\n`,
);
