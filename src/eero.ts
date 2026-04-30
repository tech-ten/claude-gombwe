// Eero API client. Talks to api-user.e2ro.com (same backend the official eero
// app uses). Auth is two-step SMS; session cookie persists at <dataDir>/eero-session.

import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const API = 'https://api-user.e2ro.com';
const UA = 'eero/6.18.0 (iPhone; iOS 17.4)';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface EeroResponse<T = any> { meta?: any; data: T }

export class EeroClient {
  private session: string | null = null;
  private sessionFile: string;

  constructor(dataDir: string) {
    this.sessionFile = join(dataDir, 'eero-session');
  }

  private async loadSession(): Promise<string | null> {
    if (this.session) return this.session;
    if (!existsSync(this.sessionFile)) return null;
    this.session = (await readFile(this.sessionFile, 'utf8')).trim();
    return this.session;
  }

  private async saveSession(s: string): Promise<void> {
    await mkdir(dirname(this.sessionFile), { recursive: true });
    await writeFile(this.sessionFile, s);
    await chmod(this.sessionFile, 0o600);
    this.session = s;
  }

  isAuthenticated(): boolean { return existsSync(this.sessionFile); }

  // Generic request — exported so the dashboard can hit any path the eero API
  // exposes (port forwards, DHCP reservations, insights, schedules, anything we
  // didn't wrap explicitly).
  async request<T = any>(method: Method, path: string, body?: any): Promise<EeroResponse<T>> {
    const session = await this.loadSession();
    const headers: Record<string, string> = {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (session) headers['Cookie'] = `s=${session}`;

    const url = path.startsWith('http') ? path : `${API}${path}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const m = setCookie.match(/s=([^;]+)/);
      if (m) await this.saveSession(m[1]);
    }

    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) {
      const msg = json?.meta?.error || json?.error || text.slice(0, 300);
      const err = new Error(`eero ${res.status}: ${msg}`);
      (err as any).status = res.status;
      (err as any).body = json;
      throw err;
    }
    return json as EeroResponse<T>;
  }

  get<T = any>(path: string) { return this.request<T>('GET', path); }
  post<T = any>(path: string, body?: any) { return this.request<T>('POST', path, body); }
  put<T = any>(path: string, body?: any) { return this.request<T>('PUT', path, body); }
  del<T = any>(path: string) { return this.request<T>('DELETE', path); }

  // ── Auth ──────────────────────────────────────────────────────────────
  login(loginId: string) { return this.post('/2.2/login', { login: loginId }); }
  verify(code: string) { return this.post('/2.2/login/verify', { code }); }
  account() { return this.get('/2.2/account'); }
  async logout() {
    try { await this.post('/2.2/logout', {}); } catch { /* ignore */ }
    this.session = null;
    try { await writeFile(this.sessionFile, ''); } catch { /* ignore */ }
  }

  // ── Networks ──────────────────────────────────────────────────────────
  async networks(): Promise<any[]> {
    const me = await this.account();
    return me?.data?.networks?.data || [];
  }

  async defaultNetworkUrl(): Promise<string> {
    const ns = await this.networks();
    if (!ns.length) throw new Error('No networks on this account');
    return ns[0].url;
  }

  network(networkUrl: string) { return this.get(networkUrl); }

  rebootNetwork(networkUrl: string) { return this.post(`${networkUrl}/reboot`, {}); }

  setGuestNetwork(networkUrl: string, enabled: boolean, opts?: { name?: string; password?: string }) {
    const body: any = { enabled };
    if (opts?.name) body.name = opts.name;
    if (opts?.password) body.password = opts.password;
    return this.put(`${networkUrl}/guestnetwork`, body);
  }

  // ── eero hardware nodes ───────────────────────────────────────────────
  eeros(networkUrl: string) { return this.get(`${networkUrl}/eeros`); }

  rebootEero(eeroUrl: string) { return this.post(`${eeroUrl}/reboot`, {}); }

  // ── Devices ───────────────────────────────────────────────────────────
  devices(networkUrl: string) { return this.get(`${networkUrl}/devices`); }

  device(deviceUrl: string) { return this.get(deviceUrl); }

  // Rename a device. eero accepts `nickname` on the device resource.
  renameDevice(deviceUrl: string, nickname: string) {
    return this.put(deviceUrl, { nickname });
  }

  // Move a device to a profile (or null/empty to detach).
  setDeviceProfile(deviceUrl: string, profileUrl: string | null) {
    return this.put(deviceUrl, { profile: profileUrl });
  }

  // Block / unblock a device entirely (separate from profile pause).
  setDeviceBlocked(deviceUrl: string, blocked: boolean) {
    return this.put(deviceUrl, { blacklisted: blocked });
  }

  // Pause an individual device — eero's API exposes `paused` on devices.
  setDevicePaused(deviceUrl: string, paused: boolean) {
    return this.put(deviceUrl, { paused });
  }

  // ── Profiles ──────────────────────────────────────────────────────────
  profiles(networkUrl: string) { return this.get(`${networkUrl}/profiles`); }

  createProfile(networkUrl: string, name: string) {
    return this.post(`${networkUrl}/profiles`, { name });
  }

  updateProfile(profileUrl: string, body: any) { return this.put(profileUrl, body); }

  deleteProfile(profileUrl: string) { return this.del(profileUrl); }

  setProfilePaused(profileUrl: string, paused: boolean) {
    return this.put(profileUrl, { paused });
  }

  // Schedules (bedtimes, school hours). eero uses /schedules under a profile.
  profileSchedules(profileUrl: string) { return this.get(`${profileUrl}/schedules`); }

  createProfileSchedule(profileUrl: string, schedule: any) {
    return this.post(`${profileUrl}/schedules`, schedule);
  }

  deleteProfileSchedule(scheduleUrl: string) { return this.del(scheduleUrl); }

  // ── Usage ─────────────────────────────────────────────────────────────
  // Cadence: 'daily' | 'hourly'. Returns a `series` keyed by upload/download.
  dataUsage(networkUrl: string, days = 7, cadence: 'daily' | 'hourly' = 'daily') {
    const end = new Date().toISOString();
    const start = new Date(Date.now() - days * 86400000).toISOString();
    const q = new URLSearchParams({ start, end, cadence });
    return this.get(`${networkUrl}/data_usage?${q}`);
  }

  // Per-device or per-profile usage. eero exposes /insights for this on most accounts.
  insights(networkUrl: string, period: 'day' | 'week' | 'month' = 'week') {
    return this.get(`${networkUrl}/insights?period=${period}`);
  }

  // ── Speed test ────────────────────────────────────────────────────────
  speedtestHistory(networkUrl: string) { return this.get(`${networkUrl}/speedtest`); }

  runSpeedtest(networkUrl: string) { return this.post(`${networkUrl}/speedtest`, {}); }

  // ── Port forwards ─────────────────────────────────────────────────────
  forwards(networkUrl: string) { return this.get(`${networkUrl}/forwards`); }

  createForward(networkUrl: string, body: any) {
    return this.post(`${networkUrl}/forwards`, body);
  }

  deleteForward(forwardUrl: string) { return this.del(forwardUrl); }

  // ── DHCP reservations ─────────────────────────────────────────────────
  reservations(networkUrl: string) { return this.get(`${networkUrl}/reservations`); }

  createReservation(networkUrl: string, body: any) {
    return this.post(`${networkUrl}/reservations`, body);
  }

  deleteReservation(reservationUrl: string) { return this.del(reservationUrl); }
}

function dirname(p: string) { return p.replace(/\/[^/]*$/, ''); }
