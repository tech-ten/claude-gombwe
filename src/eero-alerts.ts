// Alert detectors. Pure functions over the eero history + snapshot + config.
// Each detector returns zero or more alerts; the store merges them with any
// dismissed-state from disk so dismissals survive across syncs.

import type { EeroSnapshot, EeroConfig, SampleEvent } from './eero-store.js';

export type AlertSeverity = 'info' | 'warning' | 'error';
export type AlertType =
  | 'flapping-device'
  | 'noisy-new-devices'
  | 'stale-sampler'
  | 'sampler-disabled'
  | 'persistent-error'
  | 'no-history';

export interface EeroAlert {
  id: string;            // stable across reruns so dismissals stick
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  detail: string;
  suggestion?: string;
  data?: any;
  firstSeen: string;
  lastSeen: string;
  dismissed?: boolean;
}

interface DetectInput {
  snapshot: EeroSnapshot | null;
  config: EeroConfig;
  history: SampleEvent[];     // most-recent-first or chronological — both work
  now: number;
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Threshold: more than this many on/off transitions in 24h is flapping.
const FLAPPING_THRESHOLD = 10;
// More than this many new-device events in 24h means alertOnNewDevice is too noisy.
const NOISY_NEW_DEVICE_24H = 20;
// Sampler considered stale at 3× the configured interval.
const STALE_FACTOR = 3;

export function detectAlerts(input: DetectInput): EeroAlert[] {
  const out: EeroAlert[] = [];
  const { snapshot, config, history, now } = input;

  out.push(...detectFlappingDevices(history, snapshot, now));
  out.push(...detectNoisyNewDevices(history, config, now));
  out.push(...detectStaleSampler(history, config, now));
  out.push(...detectPersistentErrors(snapshot, history));

  return out;
}

function detectFlappingDevices(history: SampleEvent[], snapshot: EeroSnapshot | null, now: number): EeroAlert[] {
  const cutoff = now - DAY;
  const transitions = new Map<string, { online: number; offline: number; first: string; last: string; name?: string }>();
  for (const e of history) {
    if (e.type !== 'device-online' && e.type !== 'device-offline') continue;
    if (new Date(e.time).getTime() < cutoff) continue;
    const mac = e.data?.mac;
    if (!mac) continue;
    const entry = transitions.get(mac) || { online: 0, offline: 0, first: e.time, last: e.time, name: e.data?.name };
    if (e.type === 'device-online') entry.online += 1; else entry.offline += 1;
    if (e.time < entry.first) entry.first = e.time;
    if (e.time > entry.last) entry.last = e.time;
    if (e.data?.name) entry.name = e.data.name;
    transitions.set(mac, entry);
  }

  const alerts: EeroAlert[] = [];
  for (const [mac, t] of transitions) {
    const total = t.online + t.offline;
    if (total < FLAPPING_THRESHOLD) continue;
    const device = (snapshot?.devices || []).find((d: any) => d.mac === mac);
    const name = device?.display_name || device?.hostname || t.name || mac;
    alerts.push({
      id: `flapping:${mac}`,
      type: 'flapping-device',
      severity: total >= FLAPPING_THRESHOLD * 2 ? 'warning' : 'info',
      title: `${name} is flapping`,
      detail: `${total} online/offline transitions in the last 24 hours (${t.online} up, ${t.offline} down).`,
      suggestion: 'Possible weak signal, failing radio, or aggressive client power-saving. Consider a DHCP reservation and checking which eero node it associates with.',
      data: { mac, count: total, online: t.online, offline: t.offline },
      firstSeen: t.first,
      lastSeen: t.last,
    });
  }
  return alerts;
}

function detectNoisyNewDevices(history: SampleEvent[], config: EeroConfig, now: number): EeroAlert[] {
  if (!config.alertOnNewDevice) return [];
  const cutoff = now - DAY;
  const fresh = history.filter(e => e.type === 'new-device' && new Date(e.time).getTime() >= cutoff);
  if (fresh.length < NOISY_NEW_DEVICE_24H) return [];
  return [{
    id: 'noisy-new-devices',
    type: 'noisy-new-devices',
    severity: 'info',
    title: `${fresh.length} new-device alerts in 24h`,
    detail: `Your network is reporting many new devices — likely guests cycling Wi-Fi, IoT MAC randomisation, or a first-time enable.`,
    suggestion: 'Turn off "Alert on new device" under Advanced, or accept the current devices as known by syncing once.',
    data: { count: fresh.length },
    firstSeen: fresh[fresh.length - 1].time,
    lastSeen: fresh[0].time,
  }];
}

function detectStaleSampler(history: SampleEvent[], config: EeroConfig, now: number): EeroAlert[] {
  if (!config.samplerEnabled) {
    if (history.length === 0) {
      return [{
        id: 'sampler-disabled-empty',
        type: 'sampler-disabled',
        severity: 'info',
        title: 'Background sampler is off',
        detail: 'No history is being collected, so trend charts and flapping detection cannot run.',
        suggestion: 'Enable the sampler under Advanced. The default 5-minute interval is light on the eero API.',
        firstSeen: new Date(now).toISOString(),
        lastSeen: new Date(now).toISOString(),
      }];
    }
    return [];
  }

  const samples = history.filter(e => e.type === 'sample');
  if (samples.length === 0) {
    return [{
      id: 'sampler-no-samples',
      type: 'no-history',
      severity: 'warning',
      title: 'Sampler is on but has not collected anything',
      detail: 'The sampler is enabled but no samples have been recorded yet.',
      suggestion: 'Trigger a manual sync, or check that the eero session is still valid (sign in again under Advanced if needed).',
      firstSeen: new Date(now).toISOString(),
      lastSeen: new Date(now).toISOString(),
    }];
  }

  const last = samples.reduce((a, b) => (a.time > b.time ? a : b));
  const ageMs = now - new Date(last.time).getTime();
  if (ageMs <= STALE_FACTOR * config.samplerIntervalMs) return [];
  return [{
    id: 'sampler-stale',
    type: 'stale-sampler',
    severity: 'warning',
    title: 'Sampler has gone quiet',
    detail: `Last sample was ${Math.round(ageMs / 60000)} minutes ago — over ${STALE_FACTOR}× the configured interval.`,
    suggestion: 'Eero session may have expired. Sign in again under Advanced, or restart gombwe.',
    data: { lastSampleAt: last.time, intervalMs: config.samplerIntervalMs },
    firstSeen: last.time,
    lastSeen: new Date(now).toISOString(),
  }];
}

function detectPersistentErrors(snapshot: EeroSnapshot | null, history: SampleEvent[]): EeroAlert[] {
  if (!snapshot?.errors || Object.keys(snapshot.errors).length === 0) return [];
  // Recurring errors across multiple recent syncs — only flag if it's been
  // there for more than one sync in a row (transient errors are noise).
  const recentSamples = history.filter(e => e.type === 'sample').slice(-5);
  const errorKeys = new Set(Object.keys(snapshot.errors));
  if (recentSamples.length < 2) return [];
  return Array.from(errorKeys).map(key => ({
    id: `error:${key}`,
    type: 'persistent-error' as const,
    severity: key === 'account' || key === 'network' ? 'error' as const : 'warning' as const,
    title: `Recurring error syncing ${key}`,
    detail: snapshot.errors![key],
    suggestion: key === 'account'
      ? 'Likely an expired session — sign in again under Advanced.'
      : 'The eero API is rejecting this endpoint. Try the Raw API console to inspect.',
    firstSeen: snapshot.syncedAt,
    lastSeen: snapshot.syncedAt,
  }));
}
