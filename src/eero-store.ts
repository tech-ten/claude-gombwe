// Persistence + background sampler for the eero dashboard.
//   data/eero-snapshot.json  — most recent full sync (devices, profiles, …)
//   data/eero-history.jsonl  — append-only samples (one JSON object per line)
//   data/eero-actions.jsonl  — audit log of every action taken from the dashboard
//   data/eero-config.json    — sampler interval, default network, alert prefs

import { readFileSync, writeFileSync, existsSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { EeroClient } from './eero.js';
import { detectAlerts, type EeroAlert } from './eero-alerts.js';

const SNAPSHOT_FILE = 'eero-snapshot.json';
const HISTORY_FILE = 'eero-history.jsonl';
const ACTIONS_FILE = 'eero-actions.jsonl';
const CONFIG_FILE = 'eero-config.json';
const ALERTS_FILE = 'eero-alerts.json';

const HISTORY_MAX_BYTES = 5 * 1024 * 1024; // rotate at 5MB

export interface EeroSnapshot {
  syncedAt: string;
  networkUrl: string | null;
  account?: any;
  network?: any;
  eeros?: any[];
  devices?: any[];
  profiles?: any[];
  forwards?: any[];
  reservations?: any[];
  speedtests?: any[];
  usage?: any;
  errors?: Record<string, string>;
}

export interface EeroConfig {
  defaultNetworkUrl?: string;
  samplerEnabled: boolean;
  samplerIntervalMs: number;
  alertOnNewDevice: boolean;
  knownDeviceMacs: string[];
}

export interface SampleEvent {
  type: 'sample' | 'new-device' | 'device-online' | 'device-offline' | 'profile-paused' | 'profile-unpaused' | 'speedtest';
  time: string;
  data: any;
}

export type StoreEvent = SampleEvent | { type: 'alert'; time: string; data: EeroAlert };

const DEFAULT_CONFIG: EeroConfig = {
  samplerEnabled: false,
  samplerIntervalMs: 5 * 60 * 1000,
  alertOnNewDevice: true,
  knownDeviceMacs: [],
};

export class EeroStore {
  private dataDir: string;
  private client: EeroClient;
  private timer: NodeJS.Timeout | null = null;
  private onEvent: (e: StoreEvent) => void;

  constructor(dataDir: string, client: EeroClient, onEvent: (e: StoreEvent) => void = () => {}) {
    this.dataDir = dataDir;
    this.client = client;
    this.onEvent = onEvent;
  }

  // ── alerts ────────────────────────────────────────────────────────────
  loadAlerts(): EeroAlert[] {
    const f = join(this.dataDir, ALERTS_FILE);
    if (!existsSync(f)) return [];
    try { return JSON.parse(readFileSync(f, 'utf-8')); } catch { return []; }
  }

  saveAlerts(alerts: EeroAlert[]): void {
    writeFileSync(join(this.dataDir, ALERTS_FILE), JSON.stringify(alerts, null, 2));
  }

  // Run detectors, merge with existing dismissals, persist. Return final set.
  computeAlerts(): EeroAlert[] {
    const snapshot = this.loadSnapshot();
    const config = this.loadConfig();
    const history = this.readHistory(2000);
    const detected = detectAlerts({ snapshot, config, history, now: Date.now() });

    const existing = this.loadAlerts();
    const byId = new Map(existing.map(a => [a.id, a]));
    const merged: EeroAlert[] = [];
    const newAlerts: EeroAlert[] = [];
    for (const a of detected) {
      const prev = byId.get(a.id);
      if (prev) {
        // Preserve dismissed state and the original firstSeen timestamp.
        merged.push({ ...a, firstSeen: prev.firstSeen, dismissed: prev.dismissed });
      } else {
        merged.push(a);
        newAlerts.push(a);
      }
    }
    this.saveAlerts(merged);
    for (const a of newAlerts) {
      if (!a.dismissed) this.onEvent({ type: 'alert', time: a.firstSeen, data: a });
    }
    return merged;
  }

  dismissAlert(id: string, dismissed = true): EeroAlert[] {
    const alerts = this.loadAlerts();
    const idx = alerts.findIndex(a => a.id === id);
    if (idx >= 0) {
      alerts[idx] = { ...alerts[idx], dismissed };
      this.saveAlerts(alerts);
    }
    return alerts;
  }

  // ── snapshot ──────────────────────────────────────────────────────────
  loadSnapshot(): EeroSnapshot | null {
    const f = join(this.dataDir, SNAPSHOT_FILE);
    if (!existsSync(f)) return null;
    try { return JSON.parse(readFileSync(f, 'utf-8')); } catch { return null; }
  }

  saveSnapshot(snap: EeroSnapshot): void {
    writeFileSync(join(this.dataDir, SNAPSHOT_FILE), JSON.stringify(snap, null, 2));
  }

  // ── config ────────────────────────────────────────────────────────────
  loadConfig(): EeroConfig {
    const f = join(this.dataDir, CONFIG_FILE);
    if (!existsSync(f)) return { ...DEFAULT_CONFIG };
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(f, 'utf-8')) }; }
    catch { return { ...DEFAULT_CONFIG }; }
  }

  saveConfig(cfg: Partial<EeroConfig>): EeroConfig {
    const merged = { ...this.loadConfig(), ...cfg };
    writeFileSync(join(this.dataDir, CONFIG_FILE), JSON.stringify(merged, null, 2));
    return merged;
  }

  // ── history (append-only jsonl, rotated by size) ──────────────────────
  appendHistory(event: SampleEvent): void {
    const f = join(this.dataDir, HISTORY_FILE);
    try {
      if (existsSync(f) && statSync(f).size > HISTORY_MAX_BYTES) {
        renameSync(f, f + '.old');
      }
    } catch { /* ignore rotation errors */ }
    appendFileSync(f, JSON.stringify(event) + '\n');
  }

  readHistory(limit = 1000, typeFilter?: string): SampleEvent[] {
    const f = join(this.dataDir, HISTORY_FILE);
    if (!existsSync(f)) return [];
    const raw = readFileSync(f, 'utf-8').split('\n').filter(Boolean);
    const lines = raw.slice(-limit * 2); // over-read so we can filter
    const out: SampleEvent[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (!typeFilter || obj.type === typeFilter) out.push(obj);
      } catch { /* skip malformed */ }
    }
    return out.reverse();
  }

  // ── audit log ─────────────────────────────────────────────────────────
  logAction(action: string, detail: any): void {
    appendFileSync(
      join(this.dataDir, ACTIONS_FILE),
      JSON.stringify({ time: new Date().toISOString(), action, detail }) + '\n',
    );
  }

  readActions(limit = 100): Array<{ time: string; action: string; detail: any }> {
    const f = join(this.dataDir, ACTIONS_FILE);
    if (!existsSync(f)) return [];
    const lines = readFileSync(f, 'utf-8').split('\n').filter(Boolean).slice(-limit);
    const out: any[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      try { out.push(JSON.parse(lines[i])); } catch { /* skip */ }
    }
    return out;
  }

  // ── full sync ─────────────────────────────────────────────────────────
  async sync(networkUrl?: string): Promise<EeroSnapshot> {
    const errors: Record<string, string> = {};
    const safe = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try { return await fn(); }
      catch (err: any) { errors[name] = err.message; return undefined; }
    };

    const account = await safe('account', () => this.client.account());
    const url = networkUrl || (account?.data?.networks?.data?.[0]?.url ?? null);
    if (!url) {
      const snap: EeroSnapshot = {
        syncedAt: new Date().toISOString(),
        networkUrl: null,
        account: account?.data,
        errors,
      };
      this.saveSnapshot(snap);
      return snap;
    }

    const [network, eeros, devices, profiles, forwards, reservations, speedtests, usage] = await Promise.all([
      safe('network', () => this.client.network(url)),
      safe('eeros', () => this.client.eeros(url)),
      safe('devices', () => this.client.devices(url)),
      safe('profiles', () => this.client.profiles(url)),
      safe('forwards', () => this.client.forwards(url)),
      safe('reservations', () => this.client.reservations(url)),
      safe('speedtests', () => this.client.speedtestHistory(url)),
      safe('usage', () => this.client.dataUsage(url, 7, 'daily')),
    ]);

    const snap: EeroSnapshot = {
      syncedAt: new Date().toISOString(),
      networkUrl: url,
      account: account?.data,
      network: network?.data,
      eeros: eeros?.data || [],
      devices: devices?.data || [],
      profiles: profiles?.data || [],
      forwards: forwards?.data || [],
      reservations: reservations?.data || [],
      speedtests: speedtests?.data || [],
      usage: usage?.data,
      errors: Object.keys(errors).length ? errors : undefined,
    };

    this.detectChanges(snap);
    this.saveSnapshot(snap);
    this.appendHistory({
      type: 'sample',
      time: snap.syncedAt,
      data: {
        networkUrl: url,
        deviceCount: snap.devices?.length || 0,
        onlineCount: snap.devices?.filter((d: any) => d.connected).length || 0,
        usage: this.summariseUsage(snap.usage),
        latestSpeedtest: snap.speedtests?.[0],
      },
    });
    // Recompute alerts on every sync; dismissals persist.
    this.computeAlerts();
    return snap;
  }

  private summariseUsage(usage: any): { downloadBytes: number; uploadBytes: number } {
    const series = usage?.series || [];
    let dl = 0, ul = 0;
    for (const s of series) {
      const total = (s.values || []).reduce((acc: number, v: any) => acc + (v.value || 0), 0);
      if (String(s.type).toLowerCase().includes('down')) dl += total;
      else if (String(s.type).toLowerCase().includes('up')) ul += total;
    }
    return { downloadBytes: dl, uploadBytes: ul };
  }

  // Diff against the previous snapshot to surface new devices / online state changes.
  private detectChanges(next: EeroSnapshot): void {
    const prev = this.loadSnapshot();
    const cfg = this.loadConfig();

    if (next.devices) {
      const knownSet = new Set(cfg.knownDeviceMacs);
      const prevByMac = new Map<string, any>();
      for (const d of (prev?.devices || [])) if (d.mac) prevByMac.set(d.mac, d);

      for (const d of next.devices) {
        if (!d.mac) continue;
        const wasKnown = knownSet.has(d.mac) || prevByMac.has(d.mac);
        if (!wasKnown) {
          const event: SampleEvent = { type: 'new-device', time: next.syncedAt, data: d };
          this.appendHistory(event);
          this.onEvent(event);
        }
        const before = prevByMac.get(d.mac);
        if (before && before.connected !== d.connected) {
          const event: SampleEvent = {
            type: d.connected ? 'device-online' : 'device-offline',
            time: next.syncedAt,
            data: { mac: d.mac, name: d.display_name, profile: d.profile?.name },
          };
          this.appendHistory(event);
          this.onEvent(event);
        }
      }

      // Persist all currently-seen MACs as known so future syncs don't re-flag.
      const allMacs = Array.from(new Set([...knownSet, ...next.devices.map((d: any) => d.mac).filter(Boolean)]));
      this.saveConfig({ knownDeviceMacs: allMacs });
    }
  }

  // ── sampler ───────────────────────────────────────────────────────────
  startSampler(): void {
    const cfg = this.loadConfig();
    if (!cfg.samplerEnabled) return;
    if (this.timer) return;
    const tick = () => {
      this.sync().catch(err => console.error(`[eero-sampler] ${err.message}`));
    };
    tick();
    this.timer = setInterval(tick, cfg.samplerIntervalMs);
  }

  stopSampler(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  setSampler(enabled: boolean, intervalMs?: number): EeroConfig {
    const cfg = this.saveConfig({
      samplerEnabled: enabled,
      ...(intervalMs ? { samplerIntervalMs: intervalMs } : {}),
    });
    this.stopSampler();
    if (enabled) this.startSampler();
    return cfg;
  }
}
