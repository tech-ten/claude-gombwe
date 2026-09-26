import { join } from 'node:path';
import { homedir } from 'node:os';

// Overridable so tests (and side-by-side instances) never touch the real ~/.claude-gombwe.
// Computed at call time (not module load) so callers that set the env var after import still work.
export function configDir() {
  return process.env.GOMBWE_CONFIG_DIR || join(homedir(), '.claude-gombwe');
}

export function dataDir() {
  return join(configDir(), 'data');
}
