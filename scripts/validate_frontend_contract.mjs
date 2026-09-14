import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');
const fail = (message) => {
  throw new Error(`Frontend contract: ${message}`);
};
const required = [
  'apps/web/public/handstack-help-sw.js',
  'apps/web/app/help/help-offline-registration.tsx',
  'apps/web/tests/e2e/chat.e2e.ts',
];
for (const file of required) if (!existsSync(join(root, file))) fail(`missing ${file}`);

const sw = read('apps/web/public/handstack-help-sw.js');
if (!sw.includes("const HELP_SCOPE = '/help'") || !sw.includes('caches.match(request)'))
  fail('Help Center service worker must be scoped and cache-first');
const registration = read('apps/web/app/help/help-offline-registration.tsx');
if (!registration.includes("register('/handstack-help-sw.js', { scope: '/help' })"))
  fail('Help Center service worker registration must use the /help scope');
const css = read('apps/web/app/globals.css');
for (const token of [
  'min-width: 320px',
  'overflow-x: hidden',
  'prefers-reduced-motion',
  'min-height: 2.75rem',
])
  if (!css.includes(token)) fail(`missing CSS accessibility/responsive token: ${token}`);
const playwright = read('apps/web/playwright.config.ts');
for (const project of ['chromium-360', 'firefox-360', 'webkit-360'])
  if (!playwright.includes(`name: '${project}'`)) fail(`missing browser project ${project}`);
if (!playwright.includes('width: 360') || !playwright.includes('height: 800'))
  fail('the 360px responsive viewport is not covered');
const e2e = read('apps/web/tests/e2e/chat.e2e.ts');
for (const token of ['keyboard-only', 'new AxeBuilder', 'toHaveScreenshot'])
  if (!e2e.includes(token)) fail(`missing frontend quality check: ${token}`);
console.log(
  'Frontend contract passed: offline Help Center, 360px browsers, keyboard, axe and visual checks bound.',
);
