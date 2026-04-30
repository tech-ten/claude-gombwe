// NextDNS API client. Auth via X-Api-Key header. Config (key + configId) lives
// at <dataDir>/nextdns-config.json (mode 0600), outside the repo.

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const API = 'https://api.nextdns.io';
const CONFIG_FILE = 'nextdns-config.json';

export interface NextDNSConfig {
  apiKey?: string;
  configId?: string;
  profileName?: string;
}

export class NextDNSClient {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  // ── config ────────────────────────────────────────────────────────────
  loadConfig(): NextDNSConfig {
    const f = join(this.dataDir, CONFIG_FILE);
    if (!existsSync(f)) return {};
    try { return JSON.parse(readFileSync(f, 'utf-8')); } catch { return {}; }
  }

  saveConfig(cfg: NextDNSConfig): NextDNSConfig {
    const merged = { ...this.loadConfig(), ...cfg };
    const f = join(this.dataDir, CONFIG_FILE);
    writeFileSync(f, JSON.stringify(merged, null, 2));
    chmodSync(f, 0o600);
    return merged;
  }

  isConfigured(): boolean {
    const c = this.loadConfig();
    return !!(c.apiKey && c.configId);
  }

  // Resolver IPs derived from config ID — what we point the eero at.
  resolverIPs(): string[] {
    return ['45.90.28.247', '45.90.30.247'];
  }

  dohEndpoint(): string | null {
    const c = this.loadConfig();
    return c.configId ? `https://dns.nextdns.io/${c.configId}` : null;
  }

  // ── transport ─────────────────────────────────────────────────────────
  private async call<T = any>(method: string, path: string, body?: any): Promise<T> {
    const cfg = this.loadConfig();
    if (!cfg.apiKey) throw new Error('NextDNS API key not configured');
    const headers: Record<string, string> = {
      'X-Api-Key': cfg.apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`NextDNS ${res.status}: ${json?.errors?.[0]?.code || text.slice(0, 200)}`);
      (err as any).status = res.status;
      (err as any).body = json;
      throw err;
    }
    return json as T;
  }

  // ── profiles ──────────────────────────────────────────────────────────
  listProfiles() { return this.call('GET', '/profiles'); }
  profile(id?: string) {
    const cid = id || this.loadConfig().configId;
    return this.call('GET', `/profiles/${cid}`);
  }

  // ── parental control (categories + services + safe search) ────────────
  // Services are NextDNS's curated list of apps/sites: tiktok, instagram,
  // roblox, fortnite, youtube, discord, twitch, etc. Each is a separate
  // resource keyed by id.
  parentalServices(id?: string) {
    const cid = id || this.loadConfig().configId;
    return this.call('GET', `/profiles/${cid}/parentalControl/services`);
  }

  // Add a service to the blocked list. body.id is the service id (e.g. 'tiktok').
  addParentalService(serviceId: string, configId?: string) {
    const cid = configId || this.loadConfig().configId;
    return this.call('POST', `/profiles/${cid}/parentalControl/services`, { id: serviceId, active: true });
  }

  removeParentalService(serviceId: string, configId?: string) {
    const cid = configId || this.loadConfig().configId;
    return this.call('DELETE', `/profiles/${cid}/parentalControl/services/${serviceId}`);
  }

  parentalCategories(id?: string) {
    const cid = id || this.loadConfig().configId;
    return this.call('GET', `/profiles/${cid}/parentalControl/categories`);
  }

  addParentalCategory(categoryId: string, configId?: string) {
    const cid = configId || this.loadConfig().configId;
    return this.call('POST', `/profiles/${cid}/parentalControl/categories`, { id: categoryId, active: true });
  }

  removeParentalCategory(categoryId: string, configId?: string) {
    const cid = configId || this.loadConfig().configId;
    return this.call('DELETE', `/profiles/${cid}/parentalControl/categories/${categoryId}`);
  }

  setParentalToggle(field: 'safeSearch' | 'youtubeRestrictedMode' | 'blockBypass', value: boolean, configId?: string) {
    const cid = configId || this.loadConfig().configId;
    return this.call('PATCH', `/profiles/${cid}/parentalControl`, { [field]: value });
  }

  // ── deny / allow lists ────────────────────────────────────────────────
  denylist(id?: string) {
    const cid = id || this.loadConfig().configId;
    return this.call('GET', `/profiles/${cid}/denylist`);
  }

  addDeny(domain: string, configId?: string) {
    const cid = configId || this.loadConfig().configId;
    return this.call('POST', `/profiles/${cid}/denylist`, { id: domain, active: true });
  }

  removeDeny(domain: string, configId?: string) {
    const cid = configId || this.loadConfig().configId;
    // NextDNS uses the domain itself as the resource id, base64-style hex isn't needed.
    return this.call('DELETE', `/profiles/${cid}/denylist/${encodeURIComponent(domain)}`);
  }

  allowlist(id?: string) {
    const cid = id || this.loadConfig().configId;
    return this.call('GET', `/profiles/${cid}/allowlist`);
  }

  addAllow(domain: string, configId?: string) {
    const cid = configId || this.loadConfig().configId;
    return this.call('POST', `/profiles/${cid}/allowlist`, { id: domain, active: true });
  }

  removeAllow(domain: string, configId?: string) {
    const cid = configId || this.loadConfig().configId;
    return this.call('DELETE', `/profiles/${cid}/allowlist/${encodeURIComponent(domain)}`);
  }

  // ── security toggles (threat intel, malware, ai detection, …) ─────────
  setSecurityToggle(field: string, value: boolean, configId?: string) {
    const cid = configId || this.loadConfig().configId;
    return this.call('PATCH', `/profiles/${cid}/security`, { [field]: value });
  }

  setPrivacyToggle(field: string, value: boolean, configId?: string) {
    const cid = configId || this.loadConfig().configId;
    return this.call('PATCH', `/profiles/${cid}/privacy`, { [field]: value });
  }

  // ── logs (only useful if user has enabled log retention) ──────────────
  logs(configId?: string, limit = 50) {
    const cid = configId || this.loadConfig().configId;
    return this.call('GET', `/profiles/${cid}/logs?limit=${limit}`);
  }

  // ── analytics — query stats, status, top domains ─────────────────────
  analyticsStatus(configId?: string) {
    const cid = configId || this.loadConfig().configId;
    return this.call('GET', `/profiles/${cid}/analytics/status`);
  }

  analyticsTopDomains(configId?: string) {
    const cid = configId || this.loadConfig().configId;
    return this.call('GET', `/profiles/${cid}/analytics/domains`);
  }
}
