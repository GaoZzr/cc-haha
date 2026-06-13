import type { ApiFormat } from '../types/provider.js'

export const CLAUDE_CLI_USER_AGENT = 'claude-cli/2.0.76 (external, cli)'
export const CODEX_CLI_USER_AGENT = 'codex_cli_rs/0.77.0 (Windows 10.0.26100; x86_64) WindowsTerminal'
export const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:149.0) Gecko/20100101 Firefox/149.0'

export function getProviderUserAgent(format: ApiFormat): string {
  if (format === 'anthropic') return CLAUDE_CLI_USER_AGENT
  if (format === 'openai_responses') return CODEX_CLI_USER_AGENT
  return BROWSER_USER_AGENT
}

