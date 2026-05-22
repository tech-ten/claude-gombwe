/**
 * DNS hostname → app + category mapping.
 *
 * Used by the history rollup to bucket DNS traffic and bytes into recognisable
 * apps ("Instagram", "Netflix") and broad categories ("social", "video",
 * "adult", "gambling"). The category layer is what drives the kid-list policy
 * scanner and the per-user trend chart in the history view.
 *
 * Matching strategy:
 *   - Each entry is a domain SUFFIX. "instagram.com" matches "www.instagram.com",
 *     "scontent-syd1-1.cdninstagram.com", etc.
 *   - The table is sorted longest-suffix first so more-specific entries win.
 *   - Unknown hostnames return null app + 'unknown' category.
 *
 * Add new entries here as you see traffic the dashboard can't bucket.
 */

export type AppCategory =
  | 'social' | 'video' | 'messaging' | 'gaming' | 'music'
  | 'productivity' | 'system' | 'news' | 'shopping'
  | 'adult' | 'gambling' | 'dangerous' | 'ads' | 'unknown';

export interface AppEntry {
  suffix: string;
  app: string;
  category: AppCategory;
}

const DEFAULT_ENTRIES: AppEntry[] = [
  // ── Social ────────────────────────────────────────────────────────
  { suffix: 'cdninstagram.com',      app: 'Instagram',  category: 'social' },
  { suffix: 'instagram.com',         app: 'Instagram',  category: 'social' },
  { suffix: 'tiktokcdn.com',         app: 'TikTok',     category: 'social' },
  { suffix: 'tiktokv.com',           app: 'TikTok',     category: 'social' },
  { suffix: 'byteoversea.com',       app: 'TikTok',     category: 'social' },
  { suffix: 'bytedance.com',         app: 'TikTok',     category: 'social' },
  { suffix: 'musical.ly',            app: 'TikTok',     category: 'social' },
  { suffix: 'tiktok.com',            app: 'TikTok',     category: 'social' },
  { suffix: 'snapchat.com',          app: 'Snapchat',   category: 'social' },
  { suffix: 'sc-cdn.net',            app: 'Snapchat',   category: 'social' },
  { suffix: 'snap-dev.net',          app: 'Snapchat',   category: 'social' },
  { suffix: 'fbcdn.net',             app: 'Facebook',   category: 'social' },
  { suffix: 'facebook.com',          app: 'Facebook',   category: 'social' },
  { suffix: 'messenger.com',         app: 'Messenger',  category: 'messaging' },
  { suffix: 'twimg.com',             app: 'X (Twitter)',category: 'social' },
  { suffix: 'twitter.com',           app: 'X (Twitter)',category: 'social' },
  { suffix: 't.co',                  app: 'X (Twitter)',category: 'social' },
  { suffix: 'x.com',                 app: 'X (Twitter)',category: 'social' },
  { suffix: 'redditmedia.com',       app: 'Reddit',     category: 'social' },
  { suffix: 'redditstatic.com',      app: 'Reddit',     category: 'social' },
  { suffix: 'redd.it',               app: 'Reddit',     category: 'social' },
  { suffix: 'reddit.com',            app: 'Reddit',     category: 'social' },
  { suffix: 'bereal.com',            app: 'BeReal',     category: 'social' },
  { suffix: 'pinterest.com',         app: 'Pinterest',  category: 'social' },
  { suffix: 'pinimg.com',            app: 'Pinterest',  category: 'social' },
  { suffix: 'tumblr.com',            app: 'Tumblr',     category: 'social' },
  { suffix: 'mastodon.social',       app: 'Mastodon',   category: 'social' },
  { suffix: 'threads.net',           app: 'Threads',    category: 'social' },
  { suffix: 'linkedin.com',          app: 'LinkedIn',   category: 'social' },
  { suffix: 'licdn.com',             app: 'LinkedIn',   category: 'social' },

  // ── Video / streaming ─────────────────────────────────────────────
  { suffix: 'googlevideo.com',       app: 'YouTube',    category: 'video' },
  { suffix: 'ytimg.com',             app: 'YouTube',    category: 'video' },
  { suffix: 'ggpht.com',             app: 'YouTube',    category: 'video' },
  { suffix: 'youtube.com',           app: 'YouTube',    category: 'video' },
  { suffix: 'youtu.be',              app: 'YouTube',    category: 'video' },
  { suffix: 'nflxvideo.net',         app: 'Netflix',    category: 'video' },
  { suffix: 'nflximg.com',           app: 'Netflix',    category: 'video' },
  { suffix: 'nflxso.net',            app: 'Netflix',    category: 'video' },
  { suffix: 'nflxext.com',           app: 'Netflix',    category: 'video' },
  { suffix: 'netflix.com',           app: 'Netflix',    category: 'video' },
  { suffix: 'jtvnw.net',             app: 'Twitch',     category: 'video' },
  { suffix: 'ttvnw.net',             app: 'Twitch',     category: 'video' },
  { suffix: 'twitch.tv',             app: 'Twitch',     category: 'video' },
  { suffix: 'dssott.com',            app: 'Disney+',    category: 'video' },
  { suffix: 'bamgrid.com',           app: 'Disney+',    category: 'video' },
  { suffix: 'disneyplus.com',        app: 'Disney+',    category: 'video' },
  { suffix: 'disney-plus.net',       app: 'Disney+',    category: 'video' },
  { suffix: 'aiv-cdn.net',           app: 'Prime Video',category: 'video' },
  { suffix: 'primevideo.com',        app: 'Prime Video',category: 'video' },
  { suffix: 'amazonvideo.com',       app: 'Prime Video',category: 'video' },
  { suffix: 'hulu.com',              app: 'Hulu',       category: 'video' },
  { suffix: 'huluim.com',            app: 'Hulu',       category: 'video' },
  { suffix: 'hbo.com',               app: 'Max',        category: 'video' },
  { suffix: 'max.com',               app: 'Max',        category: 'video' },
  { suffix: 'hbomax.com',            app: 'Max',        category: 'video' },
  { suffix: 'paramountplus.com',     app: 'Paramount+', category: 'video' },
  { suffix: 'cbsivideo.com',         app: 'Paramount+', category: 'video' },
  { suffix: 'stan.com.au',           app: 'Stan',       category: 'video' },
  { suffix: 'binge.com.au',          app: 'Binge',      category: 'video' },
  { suffix: 'kayosports.com.au',     app: 'Kayo',       category: 'video' },
  { suffix: 'iview.abc.net.au',      app: 'ABC iview',  category: 'video' },
  { suffix: '9now.com.au',           app: '9Now',       category: 'video' },
  { suffix: '7plus.com.au',          app: '7plus',      category: 'video' },
  { suffix: 'sbs.com.au',            app: 'SBS On Demand', category: 'video' },
  { suffix: 'vimeo.com',             app: 'Vimeo',      category: 'video' },

  // ── Messaging ─────────────────────────────────────────────────────
  { suffix: 'whatsapp.net',          app: 'WhatsApp',   category: 'messaging' },
  { suffix: 'whatsapp.com',          app: 'WhatsApp',   category: 'messaging' },
  { suffix: 'discord.com',           app: 'Discord',    category: 'messaging' },
  { suffix: 'discordapp.com',        app: 'Discord',    category: 'messaging' },
  { suffix: 'discordapp.net',        app: 'Discord',    category: 'messaging' },
  { suffix: 'discord.gg',            app: 'Discord',    category: 'messaging' },
  { suffix: 'telegram.org',          app: 'Telegram',   category: 'messaging' },
  { suffix: 'telegram.me',           app: 'Telegram',   category: 'messaging' },
  { suffix: 'signal.org',            app: 'Signal',     category: 'messaging' },
  { suffix: 'wechat.com',            app: 'WeChat',     category: 'messaging' },
  { suffix: 'weixin.qq.com',         app: 'WeChat',     category: 'messaging' },
  { suffix: 'line.me',               app: 'LINE',       category: 'messaging' },
  { suffix: 'imessage.apple.com',    app: 'iMessage',   category: 'messaging' },
  { suffix: 'gateway.icloud.com',    app: 'iCloud',     category: 'system' },

  // ── Gaming ────────────────────────────────────────────────────────
  { suffix: 'rbxcdn.com',            app: 'Roblox',     category: 'gaming' },
  { suffix: 'roblox.com',            app: 'Roblox',     category: 'gaming' },
  { suffix: 'mojang.com',            app: 'Minecraft',  category: 'gaming' },
  { suffix: 'minecraft.net',         app: 'Minecraft',  category: 'gaming' },
  { suffix: 'minecraftservices.com', app: 'Minecraft',  category: 'gaming' },
  { suffix: 'epicgames.com',         app: 'Epic Games', category: 'gaming' },
  { suffix: 'fortnite.com',          app: 'Fortnite',   category: 'gaming' },
  { suffix: 'unrealengine.com',      app: 'Epic Games', category: 'gaming' },
  { suffix: 'steampowered.com',      app: 'Steam',      category: 'gaming' },
  { suffix: 'steamcommunity.com',    app: 'Steam',      category: 'gaming' },
  { suffix: 'steamstatic.com',       app: 'Steam',      category: 'gaming' },
  { suffix: 'steamcontent.com',      app: 'Steam',      category: 'gaming' },
  { suffix: 'steamserver.net',       app: 'Steam',      category: 'gaming' },
  { suffix: 'xboxlive.com',          app: 'Xbox Live',  category: 'gaming' },
  { suffix: 'xbox.com',              app: 'Xbox Live',  category: 'gaming' },
  { suffix: 'playstation.net',       app: 'PlayStation Network', category: 'gaming' },
  { suffix: 'playstation.com',       app: 'PlayStation Network', category: 'gaming' },
  { suffix: 'sonyentertainmentnetwork.com', app: 'PlayStation Network', category: 'gaming' },
  { suffix: 'nintendo.net',          app: 'Nintendo',   category: 'gaming' },
  { suffix: 'nintendo.com',          app: 'Nintendo',   category: 'gaming' },
  { suffix: 'ea.com',                app: 'EA',         category: 'gaming' },
  { suffix: 'origin.com',            app: 'EA',         category: 'gaming' },
  { suffix: 'ubisoft.com',           app: 'Ubisoft',    category: 'gaming' },
  { suffix: 'ubi.com',               app: 'Ubisoft',    category: 'gaming' },
  { suffix: 'riotgames.com',         app: 'Riot Games', category: 'gaming' },
  { suffix: 'leagueoflegends.com',   app: 'League of Legends', category: 'gaming' },
  { suffix: 'blizzard.com',          app: 'Blizzard',   category: 'gaming' },
  { suffix: 'battle.net',            app: 'Blizzard',   category: 'gaming' },
  { suffix: 'supercell.com',         app: 'Supercell',  category: 'gaming' },
  { suffix: 'supercell.net',         app: 'Supercell',  category: 'gaming' },

  // ── Music ─────────────────────────────────────────────────────────
  { suffix: 'spotify.com',           app: 'Spotify',    category: 'music' },
  { suffix: 'scdn.co',               app: 'Spotify',    category: 'music' },
  { suffix: 'pscdn.co',              app: 'Spotify',    category: 'music' },
  { suffix: 'music.apple.com',       app: 'Apple Music',category: 'music' },
  { suffix: 'mzstatic.com',          app: 'Apple Music',category: 'music' },
  { suffix: 'tidal.com',             app: 'Tidal',      category: 'music' },
  { suffix: 'soundcloud.com',        app: 'SoundCloud', category: 'music' },
  { suffix: 'sndcdn.com',            app: 'SoundCloud', category: 'music' },
  { suffix: 'pandora.com',           app: 'Pandora',    category: 'music' },
  { suffix: 'deezer.com',            app: 'Deezer',     category: 'music' },

  // ── Productivity / tools ──────────────────────────────────────────
  { suffix: 'githubusercontent.com', app: 'GitHub',     category: 'productivity' },
  { suffix: 'github.com',            app: 'GitHub',     category: 'productivity' },
  { suffix: 'githubassets.com',      app: 'GitHub',     category: 'productivity' },
  { suffix: 'gitlab.com',            app: 'GitLab',     category: 'productivity' },
  { suffix: 'bitbucket.org',         app: 'Bitbucket',  category: 'productivity' },
  { suffix: 'slack.com',             app: 'Slack',      category: 'productivity' },
  { suffix: 'slack-edge.com',        app: 'Slack',      category: 'productivity' },
  { suffix: 'zoom.us',               app: 'Zoom',       category: 'productivity' },
  { suffix: 'zoomgov.com',           app: 'Zoom',       category: 'productivity' },
  { suffix: 'teams.microsoft.com',   app: 'MS Teams',   category: 'productivity' },
  { suffix: 'sharepoint.com',        app: 'SharePoint', category: 'productivity' },
  { suffix: 'office.com',            app: 'Microsoft 365', category: 'productivity' },
  { suffix: 'office365.com',         app: 'Microsoft 365', category: 'productivity' },
  { suffix: 'docs.google.com',       app: 'Google Docs',category: 'productivity' },
  { suffix: 'drive.google.com',      app: 'Google Drive',category: 'productivity' },
  { suffix: 'mail.google.com',       app: 'Gmail',      category: 'productivity' },
  { suffix: 'notion.so',             app: 'Notion',     category: 'productivity' },
  { suffix: 'notion.site',           app: 'Notion',     category: 'productivity' },
  { suffix: 'figma.com',             app: 'Figma',      category: 'productivity' },
  { suffix: 'atlassian.com',         app: 'Atlassian',  category: 'productivity' },
  { suffix: 'anthropic.com',         app: 'Claude',     category: 'productivity' },
  { suffix: 'claude.ai',             app: 'Claude',     category: 'productivity' },
  { suffix: 'openai.com',            app: 'ChatGPT',    category: 'productivity' },
  { suffix: 'oaistatic.com',         app: 'ChatGPT',    category: 'productivity' },
  { suffix: 'chatgpt.com',           app: 'ChatGPT',    category: 'productivity' },

  // ── News ──────────────────────────────────────────────────────────
  { suffix: 'nytimes.com',           app: 'NY Times',   category: 'news' },
  { suffix: 'nyt.com',               app: 'NY Times',   category: 'news' },
  { suffix: 'bbc.co.uk',             app: 'BBC',        category: 'news' },
  { suffix: 'bbc.com',               app: 'BBC',        category: 'news' },
  { suffix: 'theguardian.com',       app: 'The Guardian', category: 'news' },
  { suffix: 'cnn.com',               app: 'CNN',        category: 'news' },
  { suffix: 'reuters.com',           app: 'Reuters',    category: 'news' },
  { suffix: 'theage.com.au',         app: 'The Age',    category: 'news' },
  { suffix: 'smh.com.au',            app: 'SMH',        category: 'news' },
  { suffix: 'abc.net.au',            app: 'ABC News',   category: 'news' },
  { suffix: 'news.com.au',           app: 'news.com.au',category: 'news' },

  // ── Shopping ──────────────────────────────────────────────────────
  { suffix: 'media-amazon.com',      app: 'Amazon',     category: 'shopping' },
  { suffix: 'ssl-images-amazon.com', app: 'Amazon',     category: 'shopping' },
  { suffix: 'amazon.com',            app: 'Amazon',     category: 'shopping' },
  { suffix: 'amazon.com.au',         app: 'Amazon',     category: 'shopping' },
  { suffix: 'ebay.com',              app: 'eBay',       category: 'shopping' },
  { suffix: 'ebay.com.au',           app: 'eBay',       category: 'shopping' },
  { suffix: 'ebayimg.com',           app: 'eBay',       category: 'shopping' },
  { suffix: 'etsy.com',              app: 'Etsy',       category: 'shopping' },
  { suffix: 'shopify.com',           app: 'Shopify',    category: 'shopping' },
  { suffix: 'aliexpress.com',        app: 'AliExpress', category: 'shopping' },
  { suffix: 'temu.com',              app: 'Temu',       category: 'shopping' },
  { suffix: 'kogan.com',             app: 'Kogan',      category: 'shopping' },
  { suffix: 'jbhifi.com.au',         app: 'JB Hi-Fi',   category: 'shopping' },

  // ── System / cloud / CDN ──────────────────────────────────────────
  // These are deliberately last so more-specific app suffixes win first.
  { suffix: 'push.apple.com',        app: 'Apple Push Notifications', category: 'system' },
  { suffix: 'gateway.push.apple.com',app: 'Apple Push Notifications', category: 'system' },
  { suffix: 'icloud-content.com',    app: 'iCloud',     category: 'system' },
  { suffix: 'icloud.com',            app: 'iCloud',     category: 'system' },
  { suffix: 'apple-cloudkit.com',    app: 'iCloud',     category: 'system' },
  { suffix: 'apple-dns.net',         app: 'Apple Services', category: 'system' },
  { suffix: 'aaplimg.com',           app: 'Apple Services', category: 'system' },
  { suffix: 'apple.com',             app: 'Apple Services', category: 'system' },
  { suffix: 'gvt1.com',              app: 'Google Services',category: 'system' },
  { suffix: 'gvt2.com',              app: 'Google Services',category: 'system' },
  { suffix: 'gstatic.com',           app: 'Google Services',category: 'system' },
  { suffix: 'googleapis.com',        app: 'Google Services',category: 'system' },
  { suffix: 'googlesyndication.com', app: 'Google Ads', category: 'ads' },
  { suffix: 'doubleclick.net',       app: 'Google Ads', category: 'ads' },
  { suffix: 'google-analytics.com',  app: 'Google Analytics', category: 'ads' },
  { suffix: 'googletagmanager.com',  app: 'Google Tag Manager', category: 'ads' },
  { suffix: 'google.com',            app: 'Google',     category: 'productivity' },
  { suffix: 'microsoft.com',         app: 'Microsoft Services', category: 'system' },
  { suffix: 'windowsupdate.com',     app: 'Microsoft Services', category: 'system' },
  { suffix: 'msftncsi.com',          app: 'Microsoft Services', category: 'system' },
  { suffix: 'msedge.net',            app: 'Microsoft Edge', category: 'productivity' },
  { suffix: 'live.com',              app: 'Microsoft Live', category: 'system' },
  { suffix: 'cloudflare.com',        app: 'Cloudflare', category: 'system' },
  { suffix: 'cloudflarestorage.com', app: 'Cloudflare', category: 'system' },
  { suffix: 'cloudfront.net',        app: 'AWS CloudFront', category: 'system' },
  { suffix: 'akamaihd.net',          app: 'Akamai',     category: 'system' },
  { suffix: 'akamaiedge.net',        app: 'Akamai',     category: 'system' },
  { suffix: 'fastly.net',            app: 'Fastly',     category: 'system' },
  { suffix: 'fbcdn.com',             app: 'Facebook CDN', category: 'system' },

  // ── Adult ─────────────────────────────────────────────────────────
  // Kept short — kid-list policy scanner has its own broader nsfw signal.
  { suffix: 'pornhub.com',           app: 'Pornhub',    category: 'adult' },
  { suffix: 'phncdn.com',            app: 'Pornhub',    category: 'adult' },
  { suffix: 'xvideos.com',           app: 'XVideos',    category: 'adult' },
  { suffix: 'xvideos-cdn.com',       app: 'XVideos',    category: 'adult' },
  { suffix: 'xnxx.com',              app: 'XNXX',       category: 'adult' },
  { suffix: 'redtube.com',           app: 'RedTube',    category: 'adult' },
  { suffix: 'youporn.com',           app: 'YouPorn',    category: 'adult' },
  { suffix: 'onlyfans.com',          app: 'OnlyFans',   category: 'adult' },
  { suffix: 'onlyfansassets.com',    app: 'OnlyFans',   category: 'adult' },

  // ── Gambling ──────────────────────────────────────────────────────
  { suffix: 'bet365.com',            app: 'bet365',     category: 'gambling' },
  { suffix: 'sportsbet.com.au',      app: 'Sportsbet',  category: 'gambling' },
  { suffix: 'tab.com.au',            app: 'TAB',        category: 'gambling' },
  { suffix: 'ladbrokes.com.au',      app: 'Ladbrokes',  category: 'gambling' },
  { suffix: 'pokerstars.com',        app: 'PokerStars', category: 'gambling' },
  { suffix: 'draftkings.com',        app: 'DraftKings', category: 'gambling' },
  { suffix: 'fanduel.com',           app: 'FanDuel',    category: 'gambling' },

  // ── Dangerous ─────────────────────────────────────────────────────
  // Conservative seed of unambiguous bad actors. The intent is *visibility*
  // (so traffic to these surfaces in the chart) — not blocking; that's
  // the MikroTik adlist's job. Grow this list from your own DNS traffic
  // via the Apps view.
  { suffix: 'coinhive.com',          app: 'Coinhive (browser cryptominer)', category: 'dangerous' },
  { suffix: 'coin-hive.com',         app: 'Coinhive (browser cryptominer)', category: 'dangerous' },
  { suffix: 'authedmine.com',        app: 'Coinhive variant',               category: 'dangerous' },
  { suffix: 'cryptoloot.pro',        app: 'CryptoLoot (cryptominer)',       category: 'dangerous' },
  { suffix: 'crypto-loot.com',       app: 'CryptoLoot (cryptominer)',       category: 'dangerous' },
  { suffix: 'webminerpool.com',      app: 'WebMinerPool',                   category: 'dangerous' },
  { suffix: 'minergate.com',         app: 'MinerGate pool',                 category: 'dangerous' },
  { suffix: 'nanopool.org',          app: 'Nanopool (mining)',              category: 'dangerous' },
  { suffix: 'supportxmr.com',        app: 'SupportXMR (mining)',            category: 'dangerous' },
  { suffix: 'jsecoin.com',           app: 'JSEcoin (browser cryptominer)',  category: 'dangerous' },
  { suffix: 'malwarebytes-cdn.com',  app: 'Look-alike domain (Malwarebytes)', category: 'dangerous' },
  // Note: real malwarebytes is malwarebytes.com — the -cdn variant is a known
  // look-alike used in phishing. Same trick used by many "{vendor}-cdn.com"
  // and "{vendor}-support.com" squats.
];

// Sort defaults once at module load — longest-suffix first so the most-
// specific match wins.
DEFAULT_ENTRIES.sort((a, b) => b.suffix.length - a.suffix.length);

// ── user-editable overrides (~/.claude-gombwe/network-categories.json) ─
// The file is a JSON array of AppEntry-shaped objects. User overrides win
// over built-in defaults for the same suffix. We re-read the file on every
// categorize() call cheaper alternatives didn't pay off — but the in-memory
// cache below is invalidated on writeUserEntries() so the API can mutate it
// without a server restart.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { categoryFor } from './blocklist-cache.js';

const CATEGORIES_PATH = join(homedir(), '.claude-gombwe', 'network-categories.json');

interface UserOverlay {
  entries: AppEntry[];      // sorted longest-first, like defaults
  bySuffix: Map<string, AppEntry>;
}

let _overlay: UserOverlay | null = null;

function loadUserEntries(): AppEntry[] {
  try {
    if (!existsSync(CATEGORIES_PATH)) return [];
    const raw = JSON.parse(readFileSync(CATEGORIES_PATH, 'utf-8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((e: any) =>
      e && typeof e.suffix === 'string' && typeof e.app === 'string' && typeof e.category === 'string'
    ) as AppEntry[];
  } catch {
    return [];
  }
}

function buildOverlay(): UserOverlay {
  const entries = loadUserEntries();
  entries.sort((a, b) => b.suffix.length - a.suffix.length);
  const bySuffix = new Map<string, AppEntry>();
  for (const e of entries) bySuffix.set(e.suffix.toLowerCase(), e);
  return { entries, bySuffix };
}

function getOverlay(): UserOverlay {
  if (!_overlay) _overlay = buildOverlay();
  return _overlay;
}

/** Invalidate the in-memory user-override cache. Called after writes. */
function invalidateOverlay(): void { _overlay = null; }

function writeUserEntries(entries: AppEntry[]): void {
  mkdirSync(join(homedir(), '.claude-gombwe'), { recursive: true });
  writeFileSync(CATEGORIES_PATH, JSON.stringify(entries, null, 2), { mode: 0o600 });
  invalidateOverlay();
}

// ── public API ─────────────────────────────────────────────────────────

interface LookupResult {
  app: string | null;
  category: AppCategory;
  source?: 'user' | 'default' | 'blocklist';
}

const UNKNOWN: LookupResult = Object.freeze({ app: null, category: 'unknown' });

/** Look up an app / category for a hostname. User overrides win, then defaults,
 *  then a fallback to the community blocklist cache (5b.2.4). The fallback
 *  shrinks the "unknown" bucket from "almost everything" to "only domains
 *  that aren't in any community list" — typically internal services,
 *  IoT phone-home, brand-new CDNs. */
export function categorize(hostname: string | undefined | null): LookupResult {
  if (!hostname) return UNKNOWN;
  const h = hostname.toLowerCase().replace(/\.$/, '');

  const overlay = getOverlay();
  for (const e of overlay.entries) {
    if (h === e.suffix || h.endsWith('.' + e.suffix)) {
      return { app: e.app, category: e.category, source: 'user' };
    }
  }
  for (const e of DEFAULT_ENTRIES) {
    if (h === e.suffix || h.endsWith('.' + e.suffix)) {
      return { app: e.app, category: e.category, source: 'default' };
    }
  }
  // Fallback: ask the local blocklist cache (2M+ entries from Hagezi/OISD/etc).
  // Returns null until the cache has loaded — first cold start sees UNKNOWN.
  // The cache only emits the 5 categories we ship in blocklist-sources, which
  // are all members of AppCategory — narrowing is safe.
  const cat = categoryFor(h);
  if (cat && KNOWN_CATEGORIES.has(cat)) {
    return { app: null, category: cat as AppCategory, source: 'blocklist' };
  }
  return UNKNOWN;
}

const KNOWN_CATEGORIES: Set<string> = new Set([
  'social', 'video', 'messaging', 'gaming', 'music',
  'productivity', 'system', 'news', 'shopping',
  'adult', 'gambling', 'dangerous', 'ads',
]);

/** All entries, defaults + user overrides, annotated with source. */
export function getAllEntries(): Array<AppEntry & { source: 'user' | 'default' }> {
  const overlay = getOverlay();
  const userSuffixes = new Set(overlay.bySuffix.keys());
  const out: Array<AppEntry & { source: 'user' | 'default' }> = [];
  for (const e of overlay.entries) out.push({ ...e, source: 'user' });
  for (const e of DEFAULT_ENTRIES) {
    if (userSuffixes.has(e.suffix.toLowerCase())) continue;   // user version wins, hide the default
    out.push({ ...e, source: 'default' });
  }
  return out;
}

/** Add or update a user entry. Suffix is normalised to lowercase, no leading dot. */
export function addUserEntry(suffix: string, app: string, category: AppCategory): AppEntry {
  const s = String(suffix).toLowerCase().replace(/^\.+/, '').trim();
  if (!s) throw new Error('suffix is required');
  if (!app.trim()) throw new Error('app is required');
  const overlay = getOverlay();
  const filtered = overlay.entries.filter(e => e.suffix !== s);
  const next: AppEntry = { suffix: s, app: app.trim(), category };
  filtered.push(next);
  writeUserEntries(filtered);
  return next;
}

/** Remove a user entry by suffix. Returns true if removed, false if not present. */
export function removeUserEntry(suffix: string): boolean {
  const s = String(suffix).toLowerCase().replace(/^\.+/, '').trim();
  const overlay = getOverlay();
  const filtered = overlay.entries.filter(e => e.suffix !== s);
  if (filtered.length === overlay.entries.length) return false;
  writeUserEntries(filtered);
  return true;
}

/** All known categories in display order — used by the UI palette. */
export const CATEGORY_ORDER: AppCategory[] = [
  'video', 'social', 'messaging', 'gaming', 'music',
  'productivity', 'shopping', 'news', 'system', 'ads',
  'adult', 'gambling', 'dangerous', 'unknown',
];
