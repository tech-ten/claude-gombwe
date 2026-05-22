/**
 * Curated community blocklist sources, grouped by category.
 *
 * MikroTik's /ip/dns/adlist fetches the URL, parses it, and adds matched
 * hostnames to its DNS-blocking table.
 *
 * **Format constraint (verified empirically on RouterOS 7.19.6):** the
 * adlist parser only reliably loads AdBlock-format files (`||domain.com^`).
 * Hosts-format files (`0.0.0.0 domain.com`) get rejected — load returns
 * name-count=2 regardless of file size. So every URL here MUST be the
 * AdBlock variant.
 *
 * Picking decisions:
 *   - **Hagezi** for almost everything. Lightweight, well-maintained,
 *     ships AdBlock format for every category, tier'd by aggressiveness.
 *     Hagezi TIF (threat intelligence) aggregates URLhaus and similar
 *     malware feeds, so URLhaus isn't separately needed.
 *   - **OISD NSFW** as a second adult-list option — different long tail.
 *
 * Anyone adding sources: pick the AdBlock-format URL. If the source only
 * ships hosts format (e.g., StevenBlack), don't add it — find an
 * equivalent AdBlock-format alternative instead.
 */

export interface BlocklistSource {
  id: string;                    // stable per-source key used in API + UI
  category: string;              // matches our app-categories taxonomy
  label: string;                 // human label for the UI
  url: string;                   // raw URL MikroTik adlist will fetch
  description: string;           // one-liner explaining what this covers
  approx_entries: number;        // rough size — informational
}

export const BLOCKLIST_SOURCES: BlocklistSource[] = [
  // ── Adult ──────────────────────────────────────────────────
  {
    id: 'hagezi-adult-pro',
    category: 'adult',
    label: 'Hagezi Pro (Adult)',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/nsfw.txt',
    description: 'Maintained adult/porn blocklist. Updated weekly.',
    approx_entries: 50000,
  },
  {
    id: 'oisd-nsfw',
    category: 'adult',
    label: 'OISD NSFW',
    url: 'https://nsfw.oisd.nl/',
    description: 'Alternative adult list — often catches what Hagezi misses.',
    approx_entries: 75000,
  },

  // ── Gambling ──────────────────────────────────────────────
  {
    id: 'hagezi-gambling',
    category: 'gambling',
    label: 'Hagezi Gambling',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/gambling.txt',
    description: 'Sports betting, casinos, poker, lottery. Updated weekly.',
    approx_entries: 7500,
  },

  // ── Dangerous (malware + phishing + C2) ───────────────────
  {
    id: 'hagezi-threat-intelligence',
    category: 'dangerous',
    label: 'Hagezi Threat Intelligence',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/tif.txt',
    description: 'Phishing, malware, scam. Aggregates URLhaus and other feeds.',
    approx_entries: 250000,
  },

  // ── Ads + tracking (network-wide baseline) ────────────────
  // Hagezi ships their ad/tracking list in tiers — same maintainer, different aggressiveness.
  // Light is the safest first try; Pro adds more trackers but risks more breakage.
  // (Same list family in `hosts/` format also exists at hagezi/dns-blocklists/main/hosts/<tier>.txt
  //  if a future user has an older subscription on that path, it'll show under Custom.)
  {
    id: 'hagezi-light',
    category: 'ads',
    label: 'Hagezi Light',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/light.txt',
    description: 'Conservative ads + tracking. Very low false-positive rate. Good first try.',
    approx_entries: 150000,
  },
  {
    id: 'hagezi-multi',
    category: 'ads',
    label: 'Hagezi Multi (recommended)',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/multi.txt',
    description: 'Balanced ads + tracking — Hagezi\'s recommended default.',
    approx_entries: 250000,
  },
  {
    id: 'hagezi-pro',
    category: 'ads',
    label: 'Hagezi Pro',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt',
    description: 'Aggressive ads + tracking. More coverage; small risk of breakage.',
    approx_entries: 400000,
  },

  // ── Social (network-wide; per-device differentiation deferred) ─
  {
    id: 'hagezi-tif-fakenews',
    category: 'social',
    label: 'Hagezi Fake News',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/fake.txt',
    description: 'Misinformation / fake news sites. Active maintenance.',
    approx_entries: 4500,
  },
];

export function findSource(id: string): BlocklistSource | undefined {
  return BLOCKLIST_SOURCES.find(s => s.id === id);
}
