import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { getConfigDir } from './config.js';

export type LockInfo = { pid: number; port: number; startedAt: string };

export type DaemonState =
  | { state: 'not-running' }
  | { state: 'stale-lock'; lock: LockInfo }
  | { state: 'wedged'; lock: LockInfo }
  | { state: 'running'; lock: LockInfo };

const lockPath = () => join(getConfigDir(), 'gombwe.pid');

export function readLock(): LockInfo | null {
  const p = lockPath();
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch { return null; }
}

export function writeLock(port: number): void {
  writeFileSync(lockPath(), JSON.stringify({
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
  }, null, 2));
}

export function clearLock(): void {
  try { unlinkSync(lockPath()); } catch {}
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

/**
 * SIGKILL whatever still holds the given TCP port (except ourselves).
 * A predecessor killed with SIGKILL can't run its shutdown handler, so it
 * orphans its listener (and any child it spawned) still bound to the port.
 * launchd then respawns us, but listen() throws EADDRINUSE and we crash-loop.
 * Reclaiming the port here lets the supervised restart actually succeed.
 * Returns the PIDs we killed.
 */
export function freePort(port: number): number[] {
  const killed: number[] = [];
  let out = '';
  try { out = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' }).trim(); }
  catch { return killed; } // lsof exits non-zero when nothing holds the port
  for (const line of out.split('\n')) {
    const pid = parseInt(line, 10);
    if (!pid || pid === process.pid) continue;
    try { process.kill(pid, 'SIGKILL'); killed.push(pid); } catch {}
  }
  return killed;
}

export async function isResponsive(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: AbortSignal.timeout(1000),
    });
    return r.ok;
  } catch { return false; }
}

export async function getDaemonState(): Promise<DaemonState> {
  const lock = readLock();
  if (!lock) return { state: 'not-running' };
  if (!isAlive(lock.pid)) {
    clearLock();
    return { state: 'stale-lock', lock };
  }
  if (!(await isResponsive(lock.port))) {
    return { state: 'wedged', lock };
  }
  return { state: 'running', lock };
}
