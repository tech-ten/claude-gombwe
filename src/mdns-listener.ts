/**
 * Passive mDNS / Bonjour listener.
 *
 * Apple devices (and a lot of IoT) announce themselves on the local link via
 * multicast DNS. We don't probe — every device on the LAN is already shouting
 * about itself periodically (AirPlay every ~30s, HomeKit, AirDrop, _device-info,
 * _services-_dns-sd, etc). We just listen on UDP/5353 and decode the records.
 *
 * Sharing port 5353 with macOS's mDNSResponder works because the multicast-dns
 * package sets SO_REUSEADDR/SO_REUSEPORT. If the bind still fails we log and
 * carry on — the rest of the dashboard is unaffected.
 *
 * What we extract per source IP:
 *   - host           — `.local` hostname (from A / SRV target)
 *   - name           — friendly instance label from PTR data
 *                       (e.g. "Tendai's iPhone" from `Tendai's iPhone._companion-link._tcp.local`)
 *   - model          — Apple model code from _device-info._tcp TXT
 *                       (e.g. "Macmini9,1")
 *   - model_friendly — human-readable mapping ("Mac mini (M1, 2020)")
 *   - category       — coarse device class inferred from HomeKit ci, Chromecast md,
 *                       service types, etc.  e.g. "lightbulb", "speaker", "camera"
 *   - services       — Bonjour service types this device advertises
 *   - txt            — flat map of every TXT key/value we've seen (for the future
 *                       per-device "what mDNS knows" panel)
 *
 * Bound by the network-service when it builds DeviceSummary, looked up by IP.
 */
import { networkInterfaces } from 'node:os';

// Loose typing — multicast-dns ships no TS types.
type MdnsAnswer = {
  name?: string;
  type?: string;
  data?: any;
};
type MdnsResponse = {
  answers?: MdnsAnswer[];
  additionals?: MdnsAnswer[];
};

interface MdnsRecord {
  ip: string;
  host?: string;
  name?: string;
  model?: string;
  model_friendly?: string;
  category?: string;
  services: Set<string>;
  txt: Map<string, string>;
  last_seen: number;
}

/**
 * Apple model codes → human-friendly names. Not exhaustive — covers the
 * mainstream consumer lineup. Unknown codes fall through to a family label.
 */
const APPLE_MODELS: Record<string, string> = {
  // Mac mini
  'Macmini9,1':       'Mac mini (M1, 2020)',
  'Macmini8,1':       'Mac mini (2018)',
  'Mac14,3':          'Mac mini (M2, 2023)',
  'Mac14,12':         'Mac mini (M2 Pro, 2023)',
  'Mac16,10':         'Mac mini (M4, 2024)',
  'Mac16,11':         'Mac mini (M4 Pro, 2024)',
  // MacBook
  'MacBookPro18,1':   'MacBook Pro 16" (M1 Pro/Max, 2021)',
  'MacBookPro18,3':   'MacBook Pro 14" (M1 Pro, 2021)',
  'MacBookPro18,4':   'MacBook Pro 14" (M1 Max, 2021)',
  'Mac14,7':          'MacBook Pro 13" (M2, 2022)',
  'Mac14,5':          'MacBook Pro 14" (M2 Max, 2023)',
  'Mac14,9':          'MacBook Pro 14" (M2 Pro, 2023)',
  'Mac15,3':          'MacBook Pro 14" (M3, 2023)',
  'Mac15,6':          'MacBook Pro 14" (M3 Pro, 2023)',
  'Mac16,1':          'MacBook Pro 14" (M4, 2024)',
  'Mac14,2':          'MacBook Air 13" (M2, 2022)',
  'Mac15,12':         'MacBook Air 13" (M3, 2024)',
  'Mac15,13':         'MacBook Air 15" (M3, 2024)',
  // iPhone
  'iPhone12,1':       'iPhone 11',
  'iPhone12,8':       'iPhone SE (2nd gen)',
  'iPhone13,1':       'iPhone 12 mini',
  'iPhone13,2':       'iPhone 12',
  'iPhone13,3':       'iPhone 12 Pro',
  'iPhone13,4':       'iPhone 12 Pro Max',
  'iPhone14,2':       'iPhone 13 Pro',
  'iPhone14,3':       'iPhone 13 Pro Max',
  'iPhone14,4':       'iPhone 13 mini',
  'iPhone14,5':       'iPhone 13',
  'iPhone14,6':       'iPhone SE (3rd gen)',
  'iPhone14,7':       'iPhone 14',
  'iPhone14,8':       'iPhone 14 Plus',
  'iPhone15,2':       'iPhone 14 Pro',
  'iPhone15,3':       'iPhone 14 Pro Max',
  'iPhone15,4':       'iPhone 15',
  'iPhone15,5':       'iPhone 15 Plus',
  'iPhone16,1':       'iPhone 15 Pro',
  'iPhone16,2':       'iPhone 15 Pro Max',
  'iPhone17,1':       'iPhone 16 Pro',
  'iPhone17,2':       'iPhone 16 Pro Max',
  'iPhone17,3':       'iPhone 16',
  'iPhone17,4':       'iPhone 16 Plus',
  'iPhone17,5':       'iPhone 16e',
  // iPad
  'iPad11,1':         'iPad mini (5th gen)',
  'iPad11,2':         'iPad mini (5th gen, Cellular)',
  'iPad13,1':         'iPad Air (4th gen)',
  'iPad13,2':         'iPad Air (4th gen, Cellular)',
  'iPad13,4':         'iPad Pro 11" (M1)',
  'iPad13,8':         'iPad Pro 12.9" (M1)',
  'iPad13,16':        'iPad Air (M1)',
  'iPad14,1':         'iPad mini (6th gen)',
  'iPad14,3':         'iPad Pro 11" (M2)',
  'iPad14,5':         'iPad Pro 12.9" (M2)',
  'iPad14,8':         'iPad Air (M2, 11")',
  'iPad14,9':         'iPad Air (M2, 13")',
  'iPad16,3':         'iPad Pro 11" (M4)',
  'iPad16,5':         'iPad Pro 13" (M4)',
  // Apple TV
  'AppleTV5,3':       'Apple TV HD',
  'AppleTV6,2':       'Apple TV 4K (1st gen)',
  'AppleTV11,1':      'Apple TV 4K (2nd gen)',
  'AppleTV14,1':      'Apple TV 4K (3rd gen)',
  // HomePod
  'AudioAccessory1,1':'HomePod (1st gen)',
  'AudioAccessory5,1':'HomePod mini',
  'AudioAccessory6,1':'HomePod (2nd gen)',
};

function friendlyModel(code: string): string | undefined {
  if (APPLE_MODELS[code]) return APPLE_MODELS[code];
  // Family fallbacks for codes we don't have an exact map for.
  if (code.startsWith('Watch')) return 'Apple Watch';
  if (code.startsWith('iPhone')) return 'iPhone';
  if (code.startsWith('iPad')) return 'iPad';
  if (code.startsWith('MacBook')) return 'MacBook';
  if (code.startsWith('Mac')) return 'Mac';
  if (code.startsWith('AppleTV')) return 'Apple TV';
  if (code.startsWith('AudioAccessory')) return 'HomePod';
  return undefined;
}

/** HomeKit Accessory Category Identifier (HAP table 12-3). */
const HOMEKIT_CATEGORIES: Record<string, string> = {
  '1': 'other',          '2': 'bridge',         '3': 'fan',
  '4': 'garage-door',    '5': 'lightbulb',      '6': 'door-lock',
  '7': 'outlet',         '8': 'switch',         '9': 'thermostat',
  '10': 'sensor',        '11': 'security',      '12': 'door',
  '13': 'window',        '14': 'window-covering','15': 'remote',
  '16': 'range-extender','17': 'camera',        '18': 'video-doorbell',
  '19': 'air-purifier',  '20': 'heater',        '21': 'air-conditioner',
  '22': 'humidifier',    '23': 'dehumidifier',  '26': 'speaker',
  '27': 'airport',       '28': 'sprinkler',     '29': 'faucet',
  '30': 'shower-head',   '31': 'television',    '32': 'target-controller',
  '33': 'router',        '34': 'audio-receiver','35': 'set-top-box',
  '36': 'tv-streaming-stick',
};

/** Map a service type to a coarse device class (least-specific signal). */
function categoryFromService(service: string): string | undefined {
  // service format: "_airplay._tcp"
  if (service.includes('_airplay'))         return 'speaker';
  if (service.includes('_raop'))            return 'speaker';
  if (service.includes('_spotify-connect')) return 'speaker';
  if (service.includes('_sonos'))           return 'speaker';
  if (service.includes('_googlecast'))      return 'streaming';
  if (service.includes('_printer'))         return 'printer';
  if (service.includes('_ipp'))             return 'printer';
  if (service.includes('_pdl-datastream'))  return 'printer';
  if (service.includes('_scanner'))         return 'scanner';
  if (service.includes('_smb'))             return 'workstation';
  if (service.includes('_afpovertcp'))      return 'workstation';
  if (service.includes('_workstation'))     return 'workstation';
  if (service.includes('_ssh'))             return 'workstation';
  if (service.includes('_homekit'))         return 'homekit-device';
  if (service.includes('_hap'))             return 'homekit-device';
  if (service.includes('_companion-link'))  return 'apple-device';
  return undefined;
}

class MdnsListener {
  private byIp: Map<string, MdnsRecord> = new Map();
  private mdns: any | null = null;
  private bound = false;
  private localIps: Set<string>;

  constructor() {
    // Exclude responses from ourselves — gombwe runs on the LAN and we don't
    // want to "discover" the host via its own mDNS chatter (we already self-
    // identify by MAC). Build the local-IP set once at startup.
    this.localIps = new Set<string>();
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const i of ifaces || []) {
        if (i.address && !i.internal) this.localIps.add(i.address);
      }
    }
  }

  async start(): Promise<void> {
    if (this.bound) return;
    try {
      const mdnsMod = await import('multicast-dns');
      const make = (mdnsMod as any).default ?? mdnsMod;
      this.mdns = make({ reuseAddr: true });
      this.mdns.on('response', (resp: MdnsResponse, rinfo: { address: string }) => {
        try { this.absorb(resp, rinfo); } catch { /* swallow malformed records */ }
      });
      this.mdns.on('error', (err: Error) => {
        console.warn(`[mdns] listener error: ${err.message}`);
      });
      this.bound = true;
      console.log('[mdns] passive listener active on 5353');
    } catch (err: any) {
      console.warn(`[mdns] could not start listener: ${err?.message ?? err} — continuing without it`);
    }
  }

  stop(): void {
    if (this.mdns) {
      try { this.mdns.destroy(); } catch { /* */ }
      this.mdns = null;
    }
    this.bound = false;
  }

  /** Look up everything mDNS knows about the device currently at `ip`. */
  getByIp(ip: string): {
    host?: string;
    name?: string;
    model?: string;
    model_friendly?: string;
    category?: string;
    services: string[];
    txt: Record<string, string>;
  } | undefined {
    const r = this.byIp.get(ip);
    if (!r) return undefined;
    return {
      host: r.host,
      name: r.name,
      model: r.model,
      model_friendly: r.model_friendly,
      category: r.category,
      services: [...r.services],
      txt: Object.fromEntries(r.txt),
    };
  }

  all(): Array<{ ip: string } & ReturnType<MdnsListener['getByIp']>> {
    return [...this.byIp.keys()].map(ip => ({ ip, ...this.getByIp(ip)! }));
  }

  private getOrInit(ip: string): MdnsRecord {
    let r = this.byIp.get(ip);
    if (!r) {
      r = { ip, services: new Set(), txt: new Map(), last_seen: Date.now() };
      this.byIp.set(ip, r);
    } else {
      r.last_seen = Date.now();
    }
    return r;
  }

  private absorb(resp: MdnsResponse, rinfo: { address: string }): void {
    const ip = rinfo.address;
    if (!ip || this.localIps.has(ip)) return;

    const all = [...(resp.answers ?? []), ...(resp.additionals ?? [])];
    if (all.length === 0) return;

    const rec = this.getOrInit(ip);

    for (const a of all) {
      if (!a?.name || !a?.type) continue;

      // ── PTR: "<friendly instance name>._service._tcp.local" ─────────
      // The instance name is the human-typed device label. THIS is the
      // gold for owner detection ("Tendai's iPhone").
      if (a.type === 'PTR' && typeof a.data === 'string') {
        // a.name is the service type (e.g. "_companion-link._tcp.local")
        // a.data is the instance form (e.g. "Tendai's iPhone._companion-link._tcp.local")
        if (a.name.endsWith('._tcp.local') || a.name.endsWith('._udp.local')) {
          rec.services.add(a.name.replace(/\.local$/, ''));
        }
        const instance = extractInstanceName(a.data);
        if (instance && !rec.name) rec.name = instance;
      }

      // ── A: maps a .local hostname to an IP — when it matches, this is the host
      if (a.type === 'A' && typeof a.data === 'string' && a.data === ip) {
        if (a.name.endsWith('.local')) rec.host = stripLocal(a.name);
      }

      // ── SRV: instance → host:port. data.target is the .local hostname.
      if (a.type === 'SRV' && a.data) {
        if (typeof a.data.target === 'string' && a.data.target.endsWith('.local')) {
          rec.host = rec.host ?? stripLocal(a.data.target);
        }
        // SRV record's name is the instance form: "<friendly>._svc._tcp.local"
        const instance = extractInstanceName(a.name);
        if (instance && !rec.name) rec.name = instance;
      }

      // ── TXT: the buffet — model codes, friendly names, HomeKit categories,
      // Chromecast device labels, AirPlay metadata. Capture everything.
      if (a.type === 'TXT' && Array.isArray(a.data)) {
        const svcLabel = extractServiceLabel(a.name);   // e.g. "_hap._tcp"
        for (const buf of a.data) {
          const s = bufToString(buf);
          if (!s) continue;
          const eq = s.indexOf('=');
          if (eq < 0) continue;
          const key = s.slice(0, eq).toLowerCase();
          const val = s.slice(eq + 1);
          if (!val) continue;

          // Stash raw key/value (qualified by service so different keys in
          // different services don't collide).
          rec.txt.set(svcLabel ? `${svcLabel}/${key}` : key, val);

          // ── Apple device-info: model code ────────────────────────────
          if (key === 'model') {
            rec.model = val;
            const friendly = friendlyModel(val);
            if (friendly) rec.model_friendly = friendly;
          }
          // ── AirPlay: am=<model code>, deviceid, friendly name in srv name
          if (key === 'am' && !rec.model) {
            rec.model = val;
            const friendly = friendlyModel(val);
            if (friendly) rec.model_friendly = friendly;
          }
          // ── HomeKit: ci=<category id>, md=<model display name> ──────
          if (svcLabel && (svcLabel === '_hap._tcp' || svcLabel === '_homekit._tcp')) {
            if (key === 'ci' && HOMEKIT_CATEGORIES[val]) {
              rec.category = HOMEKIT_CATEGORIES[val];
            }
            if (key === 'md' && !rec.model_friendly) {
              rec.model_friendly = val;   // e.g. "Hue color lamp"
            }
          }
          // ── Chromecast / Google Cast: md=<model name>, fn=<friendly name>
          if (svcLabel === '_googlecast._tcp') {
            if (key === 'md' && !rec.model_friendly) rec.model_friendly = val;
            if (key === 'fn' && !rec.name)           rec.name = val;
            if (!rec.category)                       rec.category = 'streaming';
          }
        }
      }
    }

    // If we still have no category, infer one from the richest service type.
    if (!rec.category) {
      for (const svc of rec.services) {
        const cat = categoryFromService(svc);
        if (cat) { rec.category = cat; break; }
      }
    }
  }
}

/** Extract friendly instance name from a PTR/SRV name like
 *  "Tendai's iPhone._companion-link._tcp.local" → "Tendai's iPhone".
 *  Returns undefined if the input is itself a bare service type. */
function extractInstanceName(s: string): string | undefined {
  if (!s) return undefined;
  // Service-type form has no instance prefix: "_companion-link._tcp.local"
  if (s.startsWith('_')) return undefined;
  // mDNS names are dot-separated. Find the boundary where the service
  // prefix starts (first label that begins with "_").
  const labels = s.split('.');
  const svcStart = labels.findIndex(l => l.startsWith('_'));
  if (svcStart <= 0) return undefined;
  const instance = labels.slice(0, svcStart).join('.');
  // mDNS instances escape dots/backslashes — restore basic escapes.
  return instance.replace(/\\032/g, ' ').replace(/\\\./g, '.').replace(/\\\\/g, '\\').trim() || undefined;
}

/** From a TXT record's name extract the bare service label (e.g. "_hap._tcp"). */
function extractServiceLabel(name: string): string | undefined {
  if (!name) return undefined;
  // Strip everything before the first "_..." label, then strip the trailing ".local".
  const idx = name.indexOf('_');
  if (idx < 0) return undefined;
  return name.slice(idx).replace(/\.local\.?$/, '') || undefined;
}

function bufToString(b: any): string {
  if (typeof b === 'string') return b;
  if (b && typeof b.toString === 'function') {
    try { return b.toString('utf8'); } catch { return ''; }
  }
  return '';
}

function stripLocal(host: string): string {
  return host.replace(/\.local\.?$/, '');
}

let _instance: MdnsListener | null = null;
export function mdnsListener(): MdnsListener {
  if (!_instance) _instance = new MdnsListener();
  return _instance;
}
