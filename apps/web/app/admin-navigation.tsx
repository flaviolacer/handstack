import Link from 'next/link';

const entries = [
  ['/', 'Dashboard'],
  ['/chat', 'Chat'],
  ['/agents', 'Agents'],
  ['/capabilities', 'Capabilities'],
  ['/models', 'Models'],
  ['/red-team', 'Red team'],
  ['/knowledge', 'Knowledge'],
  ['/workflows', 'Workflows'],
  ['/access-requests', 'Access requests'],
  ['/access-grants', 'Access grants'],
  ['/mcp', 'MCP'],
  ['/plugins', 'Plugins'],
  ['/providers', 'Providers'],
  ['/routing', 'Routing'],
  ['/users', 'Users'],
  ['/groups', 'Groups'],
  ['/roles', 'Roles'],
  ['/permissions', 'Permissions'],
  ['/policies', 'Policies'],
  ['/budgets', 'Budgets'],
  ['/api-keys', 'API Keys'],
  ['/service-accounts', 'Service accounts'],
  ['/secrets', 'Secrets'],
  ['/audit', 'Audit'],
  ['/incidents', 'Incidents'],
  ['/webhooks', 'Webhooks'],
  ['/operations/dead-letters', 'Operations'],
  ['/pricing', 'Pricing'],
  ['/usage', 'Usage'],
  ['/settings', 'Settings'],
  ['/privacy', 'Privacy'],
  ['/help', 'Help Center'],
] as const;

const contextualHelp: Readonly<Record<string, string>> = {
  '/': '/help/getting-started/overview',
  '/chat': '/help/user/chat-workspace',
  '/agents': '/help/getting-started/agents',
  '/capabilities': '/help/getting-started/capabilities',
  '/models': '/help/getting-started/model-registry',
  '/knowledge': '/help/getting-started/knowledge',
  '/workflows': '/help/getting-started/governance-workflows',
  '/access-requests': '/help/getting-started/access-requests',
  '/access-grants': '/help/getting-started/access-requests',
  '/red-team': '/help/getting-started/red-team',
  '/mcp': '/help/getting-started/mcp-client',
  '/plugins': '/help/getting-started/plugins',
  '/providers': '/help/getting-started/model-registry',
  '/routing': '/help/getting-started/model-routing',
  '/users': '/help/getting-started/authentication-sessions',
  '/groups': '/help/getting-started/authentication-sessions',
  '/roles': '/help/getting-started/authentication-sessions',
  '/permissions': '/help/getting-started/authentication-sessions',
  '/policies': '/help/getting-started/governance-workflows',
  '/budgets': '/help/getting-started/budgets',
  '/api-keys': '/help/getting-started/gateway',
  '/service-accounts': '/help/getting-started/service-accounts',
  '/secrets': '/help/getting-started/encryption-secrets',
  '/audit': '/help/getting-started/audit-observability',
  '/incidents': '/help/getting-started/incidents',
  '/webhooks': '/help/getting-started/webhooks',
  '/operations/dead-letters': '/help/getting-started/operations-api',
  '/pricing': '/help/getting-started/pricing',
  '/usage': '/help/getting-started/observability-and-alerts',
  '/settings': '/help/getting-started/overview',
  '/privacy': '/help/getting-started/privacy-lifecycle',
  '/help': '/help/user/help-center',
};

export function AdminNavigation({ current }: { readonly current?: string }) {
  return (
    <nav className="nav" aria-label="Primary navigation">
      {entries.map(([href, label]) => (
        <Link key={href} href={href} aria-current={current === href ? 'page' : undefined}>
          {label}
        </Link>
      ))}
      {current !== undefined && contextualHelp[current] !== undefined && (
        <Link
          className="context-help"
          href={contextualHelp[current]}
          aria-label={`Contextual help for ${current}`}
        >
          ?
        </Link>
      )}
    </nav>
  );
}
