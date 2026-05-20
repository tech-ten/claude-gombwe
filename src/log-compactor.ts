/**
 * Compress raw network/DNS JSONL files older than 7 days.
 *
 * Text compresses ~10x, so a year of household traffic stays well under
 * a few hundred MB on disk. The rollup reader handles both `.jsonl` and
 * `.jsonl.gz` transparently, so this is invisible to the rest of the
 * application.
 *
 * Runs on startup, then once every 24h.
 */
import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { gzipSync } from 'node:zlib';

const DATA_DIR = join(homedir(), '.claude-gombwe', 'data', 'network');
const AGE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }

function isCompactableName(name: string): boolean {
  // The two raw stream forms:
  return /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) ||
         /^dns-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name);
}

function extractDate(name: string): string | null {
  const m = name.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** One-shot compaction pass. Returns counts for logging. */
export function compactOnce(): { compressed: number; skipped: number; errors: number } {
  const today = ymd(new Date());
  const cutoff = ymd(new Date(Date.now() - AGE_THRESHOLD_MS));
  let compressed = 0, skipped = 0, errors = 0;
  let entries: string[] = [];
  try { entries = readdirSync(DATA_DIR); } catch { return { compressed, skipped, errors }; }

  for (const f of entries) {
    if (!isCompactableName(f)) { skipped++; continue; }
    const date = extractDate(f);
    if (!date) { skipped++; continue; }
    if (date >= cutoff) { skipped++; continue; }   // too fresh
    if (date === today) { skipped++; continue; }    // never touch today

    const fullPath = join(DATA_DIR, f);
    try {
      const buf = readFileSync(fullPath);
      const gz = gzipSync(buf, { level: 9 });
      writeFileSync(fullPath + '.gz', gz, { mode: 0o600 });
      unlinkSync(fullPath);
      compressed++;
    } catch (err) {
      errors++;
      console.warn(`[compactor] failed on ${f}:`, err);
    }
  }
  return { compressed, skipped, errors };
}

/** Run a compaction now, then schedule another in 24h. Re-schedules itself. */
export function startLogCompactor(): NodeJS.Timeout {
  try {
    const r = compactOnce();
    if (r.compressed > 0) console.log(`[compactor] compressed ${r.compressed} raw log file(s)`);
  } catch (err) {
    console.warn('[compactor] initial pass failed:', err);
  }
  return setInterval(() => {
    try {
      const r = compactOnce();
      if (r.compressed > 0) console.log(`[compactor] compressed ${r.compressed} raw log file(s)`);
    } catch (err) {
      console.warn('[compactor] periodic pass failed:', err);
    }
  }, 24 * 60 * 60 * 1000);
}
