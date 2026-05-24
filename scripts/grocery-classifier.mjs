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
import { significantWords, normaliseName, stripNotes } from './grocery-lib.mjs';

const CLAUDE_BIN = 'claude';
const HAIKU = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 60000;
const MAX_CANDIDATES_TO_LLM = 20;

// Words that turn a generic product into a SPECIFIC variant. Same brand
// with different qualifier = different product. Picked product MUST
// carry the watchlist's qualifier word(s) if any are present.
const STRICT_QUALIFIERS = new Set([
  'plus','premium','original','sensitive','concentrate','gentle',
  'professional','classic','ultimate','advanced','fresh','pure',
  'natural','organic','select','simply','gold','pro','active',
  'lemon','apple','orange','mint','eucalyptus','lavender','rose',
  'crunchy','smooth','crispy','crisp','wholegrain','whole',
  'unsalted','salted','light','full','low','reduced','extra',
  'plain','spicy','sweet','sour','garlic','herb',
]);

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

  // Pull out qualifier words present in the watchlist so we can demand
  // they appear in the picked product. Catches brand-line variant
  // confusion like "Cold Power Advanced PLUS" matched against "Advanced
  // CLEAN" — they're different formulations from the same brand.
  const wlWords = significantWords(stripNotes(item.name));
  const qualifiers = wlWords.filter(w => STRICT_QUALIFIERS.has(w));
  const qualifierLine = qualifiers.length > 0
    ? `HARD CONSTRAINT — the picked product's name MUST contain ALL of these qualifier words: ${qualifiers.map(q => `"${q}"`).join(', ')}. These distinguish brand-line variants from each other. If no candidate satisfies this, reply "none".`
    : '';

  return [
    `You are picking a grocery product for a household shopping list.`,
    '',
    `Wanted: ${wanted}`,
    '',
    `Candidates from ${store}:`,
    lines,
    '',
    qualifierLine,
    qualifierLine ? '' : null,
    `Decision process (apply IN THIS ORDER, don't skip ahead):`,
    '',
    `STEP 1 — Filter to candidates that GENUINELY ARE the wanted product.`,
    `        Reject anything that's a different kind of product, even if it shares words or is cheap. Examples of WRONG matches you must reject:`,
    `          - "Salted Butter" wanted, candidate "Butter Chicken Sauce" / "Microwave Popcorn Butter" / "Peanut Butter" → ALL WRONG (different products)`,
    `          - "Laundry Liquid" wanted, candidate "Dishwashing Liquid" / "Wool Wash" → ALL WRONG (different cleaning products)`,
    `          - "Chicken Breast" wanted, candidate "Chicken Breast Dino Nuggets" / "Butter Chicken Sauce" → ALL WRONG (different category)`,
    `          - "Cold Power Advanced PLUS 4L" wanted, candidate "Cold Power Advanced CLEAN 2L" → WRONG (different formulation in same brand line)`,
    `          - "Pantene Pro-V Original" wanted, candidate "Pantene Pro-V Sheer Volume" → WRONG (different variant)`,
    `          - "Bega Peanut Butter Smooth" wanted, candidate "Bega Peanut Butter Crunchy" → WRONG (different variant of same brand)`,
    `        Same product in different words is FINE: "Whole Milk" = "Full Cream Milk"; "Front Loader Laundry Liquid" = "Laundry Liquid".`,
    '',
    `STEP 2 — Among the candidates that survived STEP 1, pick the one with the BEST PER-UNIT PRICE (the cup string in parentheses, like "\$2.55/1L" or "\$14.00/1kg").`,
    `        The size in the wanted name (e.g. "1L", "500g", "38 tabs") is a HINT, NOT a requirement — a 4L laundry liquid bottle at \$3.00/L beats a 1L bottle at \$4.50/L. Bulk wins on unit price WHEN BOTH ARE THE SAME PRODUCT VARIANT.`,
    `        Never substitute a cheaper VARIANT to get a better unit price. "Advanced Plus" ≠ "Advanced Clean" even if Clean is cheaper per litre.`,
    `        If only one candidate survives STEP 1, pick it regardless of price.`,
    '',
    `STEP 3 — If NO candidate survives STEP 1, reply "none". Never pick a wrong product just because it has a good unit price.`,
    '',
    `Reply with ONLY the index number (e.g. "0") or the word "none". No explanation.`,
  ].filter(line => line !== null).join('\n');
}

function parsePick(response) {
  const t = response.trim().toLowerCase();
  // "none" anywhere in the response takes priority over a stray digit
  // (Haiku sometimes writes "none — option 3 is wool wash" and we'd
  // wrongly parse 3 as the pick if we matched digits first).
  if (/\bnone\b/.test(t)) return { kind: 'none' };
  // First standalone integer anywhere in the response. Tolerates prose
  // prefixes ("I pick 2", "The answer is 2", "2 because…") since Haiku
  // occasionally ignores the "index only" instruction.
  const m = t.match(/\b(\d+)\b/);
  if (m) return { kind: 'index', value: parseInt(m[1], 10) };
  return { kind: 'unparseable', raw: response };
}

function cheapest(candidates) {
  return candidates.slice().sort((a, b) => a.price - b.price)[0] || null;
}

/** Rank candidates by (watchlist-word overlap DESC, price ASC) and take
 *  the top N. Bare price-sort would put cheap-but-irrelevant products
 *  first; bare overlap-sort would put expensive specialty variants
 *  first. Overlap-then-price ensures the genuine matches are at the
 *  top of the list Haiku sees. */
function rankAndCap(item, candidates, n) {
  if (candidates.length <= n) return candidates.slice().sort((a, b) => a.price - b.price);
  const want = new Set(significantWords(item.name));
  const scored = candidates.map(c => {
    const tokens = new Set(normaliseName(c.name).split(/\s+/));
    let overlap = 0;
    for (const w of want) if (tokens.has(w)) overlap++;
    return { c, overlap };
  });
  scored.sort((a, b) => (b.overlap - a.overlap) || (a.c.price - b.c.price));
  return scored.slice(0, n).map(s => s.c);
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

  // Cap to avoid prompt-too-long timeouts. Salted Butter at Coles was
  // returning 70+ accepted candidates; the prompt couldn't be processed
  // within the timeout and would fall back to cheapest (Popcorn Butter).
  const shortlist = rankAndCap(item, candidates, MAX_CANDIDATES_TO_LLM);
  const prompt = buildPrompt(item, shortlist, store);
  let response;
  try {
    response = await runHaiku(prompt);
  } catch (err) {
    return { picked: cheapest(shortlist), source: `fallback-${err.message}` };
  }

  const parsed = parsePick(response);
  if (parsed.kind === 'none') {
    return { picked: null, source: 'haiku-none' };
  }
  if (parsed.kind === 'index' && parsed.value >= 0 && parsed.value < shortlist.length) {
    return { picked: shortlist[parsed.value], source: 'haiku', raw: response };
  }
  // Bad output — fall back to cheapest of the shortlist (not the full
  // candidate list) so we stay consistent with what Haiku was looking at.
  return {
    picked: cheapest(shortlist),
    source: 'fallback-unparseable',
    raw: response,
  };
}
