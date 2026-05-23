import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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
