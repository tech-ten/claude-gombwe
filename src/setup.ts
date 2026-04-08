import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json');

interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface ClaudeSettings {
  mcpServers?: Record<string, MCPServerConfig>;
  [key: string]: unknown;
}

/**
 * Available service connectors.
 * Each one maps to an MCP server that gives Claude access to the service.
 */
export const SERVICES: Record<string, {
  name: string;
  description: string;
  package: string;
  command: string;
  args: string[];
  envVars: { key: string; description: string; required: boolean }[];
  exampleJobs: string[];
}> = {
  github: {
    name: 'GitHub',
    description: 'Issues, PRs, repos, code search',
    package: '@modelcontextprotocol/server-github',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envVars: [
      { key: 'GITHUB_PERSONAL_ACCESS_TOKEN', description: 'GitHub personal access token (repo, read:org scopes)', required: true },
    ],
    exampleJobs: [
      'Every morning at 9am, check my GitHub repos for new issues and PRs that need attention. Send me the top 3 priorities.',
      'Every Friday at 5pm, summarize this week\'s merged PRs across all my repos.',
    ],
  },
  gmail: {
    name: 'Gmail',
    description: 'Read, search, and manage email',
    package: 'gmail-mcp-server',
    command: 'uvx',
    args: ['gmail-mcp-server'],
    envVars: [
      { key: 'GMAIL_CREDENTIALS_FILE', description: 'Path to Google OAuth credentials.json', required: true },
      { key: 'GMAIL_TOKEN_FILE', description: 'Path to store OAuth token (e.g. ~/.claude-gombwe/gmail-token.json)', required: true },
    ],
    exampleJobs: [
      'Every 30 minutes, check my inbox for emails from @importantclient.com. If any, send me a summary and suggested reply on Telegram.',
      'Every morning at 8am, give me a digest of unread emails, grouped by priority.',
    ],
  },
  'google-calendar': {
    name: 'Google Calendar',
    description: 'Read and manage calendar events',
    package: 'google-calendar-mcp',
    command: 'uvx',
    args: ['google-calendar-mcp'],
    envVars: [
      { key: 'GOOGLE_CREDENTIALS_FILE', description: 'Path to Google OAuth credentials.json', required: true },
    ],
    exampleJobs: [
      'Every morning at 7:30am, send me today\'s schedule with prep notes for each meeting.',
      'Every Sunday at 8pm, send me a preview of next week\'s calendar.',
    ],
  },
  slack: {
    name: 'Slack',
    description: 'Read/send messages, search channels',
    package: '@modelcontextprotocol/server-slack',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    envVars: [
      { key: 'SLACK_BOT_TOKEN', description: 'Slack bot token (xoxb-...)', required: true },
      { key: 'SLACK_TEAM_ID', description: 'Slack workspace/team ID', required: true },
    ],
    exampleJobs: [
      'Every evening at 6pm, summarize today\'s important Slack messages across my channels.',
      'When mentioned in Slack, draft a response and send it to me on Telegram for approval.',
    ],
  },
  'brave-search': {
    name: 'Web Search (Brave)',
    description: 'Search the web for current information',
    package: '@modelcontextprotocol/server-brave-search',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envVars: [
      { key: 'BRAVE_API_KEY', description: 'Brave Search API key (free at brave.com/search/api)', required: true },
    ],
    exampleJobs: [
      'Every morning, search for trending topics in AI and send me the top 3 content ideas.',
      'Every Monday, search for competitors\' latest blog posts and summarize what they\'re writing about.',
    ],
  },
  filesystem: {
    name: 'Filesystem',
    description: 'Read and manage local files and folders',
    package: '@modelcontextprotocol/server-filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', join(homedir(), 'Documents')],
    envVars: [],
    exampleJobs: [
      'Every night at midnight, check my Downloads folder and organize files by type into subfolders.',
    ],
  },
  fetch: {
    name: 'HTTP Fetch',
    description: 'Fetch URLs, scrape web pages',
    package: '@modelcontextprotocol/server-fetch',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    envVars: [],
    exampleJobs: [
      'Every morning, check this URL for price changes and alert me if anything drops below $X.',
    ],
  },
  memory: {
    name: 'Persistent Memory',
    description: 'Long-term knowledge graph that persists across conversations',
    package: '@modelcontextprotocol/server-memory',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    envVars: [],
    exampleJobs: [],
  },
};

export function loadClaudeSettings(): ClaudeSettings {
  if (existsSync(CLAUDE_SETTINGS)) {
    return JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf-8'));
  }
  return {};
}

function saveClaudeSettings(settings: ClaudeSettings): void {
  const dir = join(homedir(), '.claude');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
}

export function listConnectedServices(): string[] {
  const settings = loadClaudeSettings();
  if (!settings.mcpServers) return [];
  return Object.keys(settings.mcpServers);
}

export function connectService(serviceId: string, envVars: Record<string, string>): void {
  const service = SERVICES[serviceId];
  if (!service) throw new Error(`Unknown service: ${serviceId}`);

  const settings = loadClaudeSettings();
  if (!settings.mcpServers) settings.mcpServers = {};

  const config: MCPServerConfig = {
    command: service.command,
    args: [...service.args],
  };

  if (Object.keys(envVars).length > 0) {
    config.env = envVars;
  }

  settings.mcpServers[serviceId] = config;
  saveClaudeSettings(settings);
}

export function disconnectService(serviceId: string): boolean {
  const settings = loadClaudeSettings();
  if (!settings.mcpServers || !settings.mcpServers[serviceId]) return false;
  delete settings.mcpServers[serviceId];
  saveClaudeSettings(settings);
  return true;
}
