/**
 * Server-side mirror of the UI's owner-guess heuristic.
 *
 * Why this exists: the UI auto-tags devices to a person from their name
 * (e.g. "Tendais-Mac-mini" → "Tendai") so users see grouping immediately
 * without manual assignment. But the history API filters rollups by the
 * persisted `owner` field — and most rollups have `owner: null` because the
 * user hasn't explicitly assigned everyone. Result: clicking "Tendai" returned
 * an empty chart because the heuristic never reached the server.
 *
 * This module keeps the heuristic in one place we can use from both:
 *   - history-rollup.ts (populate `owner` when generating new rollups)
 *   - gateway.ts        (apply at filter time for legacy rollups w/ owner: null)
 *
 * Keep semantically aligned with ui/network.js guessOwner().
 */

const HOUSEHOLD_HINTS = [
  'tv','printer','router','hub','switch','iot','echo','alexa',
  'google home','nest','ring','smart','thermostat','doorbell',
  'camera','speaker','chromecast','sonos','hue',
  'brw','mxchip','esp','shelly','lifx','eero',
];

const NAME_BLACKLIST = new Set([
  'iphone','ipad','ipod','mac','macbook','imac','appletv','homepod','airpods',
  'tendais',
  'samsung','galaxy','pixel','nexus','oneplus','xiaomi','redmi','huawei','honor',
  'ps5','ps4','xbox','switch','nintendo','steam','deck',
  'echo','alexa','nest','ring','hue','sonos','roku','chromecast','fire','kindle',
  'router','modem','gateway','extender','ap','access','point','tplink','netgear',
  'android','phone','tablet','laptop','desktop','pc','windows','linux',
]);

const OWNER_PATTERNS: RegExp[] = [
  /^([A-Za-z][A-Za-z]{2,19})['’]s[\s-_]/,
  /^([A-Za-z][A-Za-z]{2,19})[-_\s]/,
  /[-_\s(]([A-Za-z][A-Za-z]{2,19})[)\s]*$/,
  /\bof\s+([A-Za-z][A-Za-z]{2,19})\b/i,
];

function stripPossessiveStem(stem: string): string {
  if (/s$/i.test(stem) && stem.length >= 4) {
    const stripped = stem.slice(0, -1);
    if (stripped.length >= 3) return stripped;
  }
  return stem;
}

function tryExtract(s: string | null | undefined): string | null {
  if (!s) return null;
  const raw = s.trim();
  if (!raw) return null;
  for (const re of OWNER_PATTERNS) {
    const m = raw.match(re);
    if (!m) continue;
    let candidate = m[1].toLowerCase();
    candidate = stripPossessiveStem(candidate);
    if (NAME_BLACKLIST.has(candidate)) continue;
    return candidate.charAt(0).toUpperCase() + candidate.slice(1);
  }
  return null;
}

/**
 * Guess an owner from any name-like candidate fields.
 * Returns null if no match or if the device looks household-class.
 */
export function guessOwner(candidates: {
  name?: string | null;
  hostname?: string | null;
  mdns_name?: string | null;
  mdns_host?: string | null;
}): string | null {
  const all = [
    candidates.mdns_name,
    candidates.name,
    candidates.hostname,
    candidates.mdns_host,
  ].filter((s): s is string => !!s);

  if (all.length === 0) return null;

  // Household class wins over personal — don't tag a TV or printer to a person.
  for (const c of all) {
    const low = c.toLowerCase();
    if (HOUSEHOLD_HINTS.some(h => low.includes(h))) return null;
  }

  for (const c of all) {
    const o = tryExtract(c);
    if (o) return o;
  }
  return null;
}

/**
 * Filter helper: does this rollup device match the given owner query?
 * Matches explicit owner OR a heuristic guess from its name fields.
 * Case-insensitive owner comparison.
 */
export function deviceMatchesOwner(
  device: { owner?: string | null; name?: string | null; hostname?: string | null; mdns_name?: string | null; mdns_host?: string | null },
  owner: string,
): boolean {
  const want = owner.toLowerCase();
  if ((device.owner ?? '').toLowerCase() === want) return true;
  const guess = guessOwner(device);
  return guess !== null && guess.toLowerCase() === want;
}
