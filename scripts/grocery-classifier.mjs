/**
 * GROCERY CLASSIFIER — Haiku-backed product matcher.
 *
 * Regex matching has a ceiling. "Salted Butter 500g" matching "Bread &
 * Butter Cucumbers Sliced Pickles 500g" because both contain "butter"
 * and "500g" is the kind of failure no per-item requires-list can solve
 * sustainably. So we put a small LLM call between the regex pre-filter
 * and the final pick.
 *
 * Architecture:
 *   1. Regex gates (in grocery-lib.mjs) keep doing the cheap reject —
 *      size/pack/perKg/processed-variant/name-overlap. Drops obvious junk
 *      so we don't waste Claude on it.
 *   2. classifyMatch() takes the regex-accepted shortlist, asks Haiku to
 *      pick the candidate that is genuinely the wanted item.
 *   3. Falls back to cheapest-accepted if Haiku errors / times out — the
 *      watch run must never silently break because Claude was slow.
 *
 * Cost: runs against the user's Max subscription via the claude CLI; no
 * API billing. Latency dominated by per-call spawn overhead (~1-3s).
 */

import { spawn } from 'node:child_process';

const CLAUDE_BIN = 'claude';
const HAIKU = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 30000;

function runHaiku(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, [
      '-p', prompt,
      '--output-format', 'text',
      '--dangerously-skip-permissions',
      '--model', HAIKU,
    ]);
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, TIMEOUT_MS);
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`exit ${code}: ${stderr.slice(0, 200)}`));
      else resolve(stdout.trim());
    });
  });
}

function buildPrompt(item, candidates, store) {
  const wanted = item.name + (item.notes ? `  (notes: ${item.notes})` : '');
  const lines = candidates.map((c, i) =>
    `${i}. "${c.name}" — $${c.price}${c.cup ? ` (${c.cup})` : ''}`
  ).join('\n');
  return [
    `Pick the candidate from ${store} that genuinely IS this grocery item.`,
    '',
    `Wanted: ${wanted}`,
    '',
    `Candidates:`,
    lines,
    '',
    `Reject candidates that are a different product (e.g. "Salted Butter" should NOT match "Butter Chicken Sauce" — they share words but are different things).`,
    `Reject candidates whose quantity is too small to be useful (e.g. an 80g lunch-meat pack for "Chicken Breast per kg").`,
    `Accept candidates that are essentially the same product even if labelled differently (e.g. "Whole Milk" = "Full Cream Milk").`,
    '',
    `Reply with ONLY the index number (e.g. "0") or the word "none" if no candidate is acceptable. No explanation.`,
  ].join('\n');
}

function parsePick(response) {
  const t = response.trim().toLowerCase();
  if (t === 'none' || t.startsWith('none')) return { kind: 'none' };
  const m = t.match(/^(\d+)/);
  if (m) return { kind: 'index', value: parseInt(m[1], 10) };
  return { kind: 'unparseable', raw: response };
}

function cheapest(candidates) {
  return candidates.slice().sort((a, b) => a.price - b.price)[0] || null;
}

/**
 * Pick the best candidate for a watchlist item from a regex-prefiltered list.
 * @returns {Promise<{ picked: object|null, source: string, raw?: string }>}
 *   picked: the chosen candidate object, or null if no good match
 *   source: tag indicating how the pick was made (haiku|only-candidate|fallback-*)
 */
export async function classifyMatch(item, candidates, store) {
  if (!candidates || candidates.length === 0) {
    return { picked: null, source: 'empty-shortlist' };
  }
  if (candidates.length === 1) {
    return { picked: candidates[0], source: 'only-candidate' };
  }

  const prompt = buildPrompt(item, candidates, store);
  let response;
  try {
    response = await runHaiku(prompt);
  } catch (err) {
    const fallback = cheapest(candidates);
    return { picked: fallback, source: `fallback-${err.message}` };
  }

  const parsed = parsePick(response);
  if (parsed.kind === 'none') {
    return { picked: null, source: 'haiku-none' };
  }
  if (parsed.kind === 'index' && parsed.value >= 0 && parsed.value < candidates.length) {
    return { picked: candidates[parsed.value], source: 'haiku', raw: response };
  }
  // Bad output — fall back to cheapest accepted rather than silently dropping
  return {
    picked: cheapest(candidates),
    source: 'fallback-unparseable',
    raw: response,
  };
}
