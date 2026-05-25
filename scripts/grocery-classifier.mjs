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
import { logClassifierDecision } from './grocery-forensics.mjs';

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
  'crunchy','smooth','crispy','crisp','wholegrain','whole','multigrain',
  'unsalted','salted','light','full','low','reduced','extra',
  'plain','spicy','sweet','sour','garlic','herb',
  'heavy','duty','strong','thick','thin','jumbo','mini','large','small',
  'free','range','grassfed','wild',
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
  // Display brand alongside name — Coles NEXT_DATA puts brand in a
  // separate field, so the name alone is often anonymous ("Laundry
  // Liquid Advanced Clean" with brand="Cold Power"). Haiku needs to
  // see the brand to make the right call.
  const lines = candidates.map((c, i) => {
    const brandPrefix = c.brand && !new RegExp(`\\b${c.brand.split(/\s+/)[0]}\\b`, 'i').test(c.name)
      ? `[${c.brand}] ` : '';
    return `${i}. ${brandPrefix}"${c.name}" — $${c.price}${c.cup ? ` (${c.cup})` : ''}`;
  }).join('\n');

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
    `        The size in the wanted name (e.g. "1L", "500g", "38 tabs", "5kg") is a MINIMUM, not a target. PREFER LARGER (a 4L bottle at \$3/L beats a 1L bottle at \$4.50/L). REJECT SMALLER if substantially below the wanted size (don't accept a 500g rice pack when the watchlist asks 5kg — same product but you'd need 10 packs).`,
    `        For "per kg" items, accept packs ≥ ~800g or by-weight items. Reject lunch-meat-sized packs (≤500g) — those are deli cuts, not raw protein for cooking.`,
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
    // Include brand alongside name — for Coles NEXT_DATA where brand is
    // a separate field, scoring on name alone leaves branded watchlist
    // items orphaned. "Cold Power Advanced 4L" wouldn't score against
    // candidate name "Laundry Liquid Advanced Clean" unless we also
    // count brand="Cold Power".
    const haystack = c.brand ? `${c.brand} ${c.name}` : c.name;
    const tokens = new Set(normaliseName(haystack).split(/\s+/));
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
    const r = { picked: null, source: 'empty-shortlist' };
    logClassifierDecision({ item: item.name, store, shortlist: [], picked_index: null, picked_id: null, source: r.source, raw: null, ms: 0 });
    return r;
  }
  if (candidates.length === 1) {
    const r = { picked: candidates[0], source: 'only-candidate' };
    logClassifierDecision({ item: item.name, store, shortlist: candidates, picked_index: 0, picked_id: candidates[0].product_id, source: r.source, raw: null, ms: 0 });
    return r;
  }

  // Cap to avoid prompt-too-long timeouts. Salted Butter at Coles was
  // returning 70+ accepted candidates; the prompt couldn't be processed
  // within the timeout and would fall back to cheapest (Popcorn Butter).
  const shortlist = rankAndCap(item, candidates, MAX_CANDIDATES_TO_LLM);
  const prompt = buildPrompt(item, shortlist, store);
  const _t0 = Date.now();
  let response;
  let result;
  try {
    response = await runHaiku(prompt);
  } catch (err) {
    result = { picked: cheapest(shortlist), source: `fallback-${err.message}` };
    logClassifierDecision({ item: item.name, store, shortlist, picked_index: null, picked_id: result.picked?.product_id, source: result.source, raw: null, ms: Date.now() - _t0 });
    return result;
  }

  const parsed = parsePick(response);
  if (parsed.kind === 'none') {
    result = { picked: null, source: 'haiku-none', raw: response };
  } else if (parsed.kind === 'index' && parsed.value >= 0 && parsed.value < shortlist.length) {
    result = { picked: shortlist[parsed.value], source: 'haiku', raw: response };
  } else {
    // Bad output — fall back to cheapest of the shortlist (not the full
    // candidate list) so we stay consistent with what Haiku was looking at.
    result = { picked: cheapest(shortlist), source: 'fallback-unparseable', raw: response };
  }

  // Post-hoc qualifier check — deterministic guard against Haiku drift.
  // The prompt says "MUST contain ALL qualifier words" but Haiku
  // occasionally ignores that under pressure (long shortlist, similar
  // words). Re-validate here: if the picked product's name lacks any
  // strict qualifier present in the watchlist, force "none".
  // Caught: "Finish Quantum Ultimate 38 tabs" → "Men Deodorant Quantum"
  // (the Rexona deodorant has 'Quantum' but not 'Ultimate').
  if (result.picked) {
    const wlWords = significantWords(stripNotes(item.name));
    const requiredQualifiers = wlWords.filter(w => STRICT_QUALIFIERS.has(w));
    if (requiredQualifiers.length > 0) {
      // Include brand in the picked-words set (Coles NEXT_DATA splits
      // brand from name; without this a qualifier in the brand part
      // would be miscounted as missing).
      const pickedHaystack = result.picked.brand
        ? `${result.picked.brand} ${result.picked.name}`
        : result.picked.name;
      const pickedWords = new Set(normaliseName(pickedHaystack).split(/\s+/));
      const missing = requiredQualifiers.filter(q => !pickedWords.has(q));
      if (missing.length > 0) {
        result = {
          picked: null,
          source: `posthoc-qualifier-fail (missing: ${missing.join(', ')})`,
          raw: response,
          rejected_pick: { name: result.picked.name, brand: result.picked.brand, price: result.picked.price },
        };
      }
    }
  }
  logClassifierDecision({
    item: item.name, store, shortlist,
    picked_index: (parsed.kind === 'index') ? parsed.value : null,
    picked_id: result.picked?.product_id,
    source: result.source, raw: response,
    ms: Date.now() - _t0,
  });
  return result;
}
