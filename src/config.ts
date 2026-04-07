import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { GombweConfig } from './types.js';

const CONFIG_DIR = join(homedir(), '.claude-gombwe');
const CONFIG_FILE = join(CONFIG_DIR, 'gombwe.json');

const DEFAULT_CONFIG: GombweConfig = {
  port: 18790,
  host: '127.0.0.1',
  dataDir: join(CONFIG_DIR, 'data'),
  skillsDirs: [
    join(CONFIG_DIR, 'skills'),
    './skills',
  ],
  agents: {
    defaultModel: 'claude-sonnet-4-6',
    maxConcurrent: 5,
    workingDir: process.cwd(),
  },
  channels: {
    web: { enabled: true },
  },
  identity: {
    name: 'Gombwe',
    personality: 'A helpful autonomous agent powered by Claude Code.',
  },
};

export function ensureConfigDir(): void {
  for (const dir of [CONFIG_DIR, join(CONFIG_DIR, 'data'), join(CONFIG_DIR, 'skills'), join(CONFIG_DIR, 'data', 'sessions'), join(CONFIG_DIR, 'data', 'tasks')]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig(): GombweConfig {
  ensureConfigDir();

  if (existsSync(CONFIG_FILE)) {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    const userConfig = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...userConfig };
  }

  writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
  return DEFAULT_CONFIG;
}

export function saveConfig(config: GombweConfig): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}
