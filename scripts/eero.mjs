#!/usr/bin/env node

/**
 * eero control — talks to api-user.e2ro.com (the same backend the eero app uses).
 *
 * Auth is two-step: login sends SMS, verify exchanges the code for a long-lived
 * session cookie persisted at ~/.claude-gombwe/data/eero-session.
 *
 * Commands:
 *   login <email-or-phone>     Request SMS code
 *   verify <code>              Exchange code for session
 *   whoami                     Show signed-in account
 *   networks                   List networks
 *   devices [network_url]      Per-device list with profile assignment
 *   profiles [network_url]     Profiles + paused state
 *   pause <profile_name>       Pause a profile (kid offline now)
 *   unpause <profile_name>     Unpause
 *   usage [days]               Network data usage (daily series, bytes)
 *   speedtest                  Recent speed-test history (down/up mbps)
 */

import { mkdir, readFile, writeFile, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const API = 'https://api-user.e2ro.com';
const UA = 'eero/6.18.0 (iPhone; iOS 17.4)';
const DATA_DIR = join(homedir(), '.claude-gombwe', 'data');
const SESSION_FILE = join(DATA_DIR, 'eero-session');

async function loadSession() {
  if (!existsSync(SESSION_FILE)) return null;
  return (await readFile(SESSION_FILE, 'utf8')).trim();
}

async function saveSession(s) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SESSION_FILE, s);
  await chmod(SESSION_FILE, 0o600);
}

async function call(method, path, body) {
  const session = await loadSession();
  const headers = { 'User-Agent': UA, 'Content-Type': 'application/json' };
  if (session) headers['Cookie'] = `s=${session}`;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/s=([^;]+)/);
    if (m) await saveSession(m[1]);
  }

  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.meta?.error || json?.error || text.slice(0, 200);
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return json;
}

const post = (p, b) => call('POST', p, b);
const get = (p) => call('GET', p);
const put = (p, b) => call('PUT', p, b);

async function networks() {
  const me = await get('/2.2/account');
  return me.data.networks.data;
}

async function defaultNetworkUrl() {
  const ns = await networks();
  if (!ns.length) throw new Error('No networks on this account');
  return ns[0].url;
}

const fmt = (o) => JSON.stringify(o, null, 2);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'login': {
      if (!rest[0]) throw new Error('usage: login <email-or-phone>');
      const out = await post('/2.2/login', { login: rest[0] });
      console.log('Code requested. Run: eero.mjs verify <6-digit-code>');
      console.log(`token: ${out?.data?.user_token?.slice(0, 8) ?? '?'}...`);
      break;
    }
    case 'verify': {
      if (!rest[0]) throw new Error('usage: verify <code>');
      const out = await post('/2.2/login/verify', { code: rest[0] });
      console.log('Verified. Session saved to', SESSION_FILE);
      console.log(fmt(out.data).slice(0, 400));
      break;
    }
    case 'whoami': {
      const me = await get('/2.2/account');
      const d = me.data;
      console.log(`${d.name || '(no name)'} <${d.email?.value || '?'}>`);
      console.log(`phone: ${d.phone?.value || '-'}  premium: ${d.premium_status || 'free'}`);
      console.log(`networks: ${d.networks.count}`);
      break;
    }
    case 'networks': {
      for (const n of await networks()) {
        console.log(`${n.name.padEnd(30)} ${n.url}  members=${n.members ?? '?'}`);
      }
      break;
    }
    case 'devices': {
      const url = rest[0] || (await defaultNetworkUrl());
      const out = await get(`${url}/devices`);
      for (const d of out.data) {
        const pf = d.profile?.name || '-';
        console.log(
          `${(d.display_name || '?').padEnd(30)} ${(d.mac || '').padEnd(17)} ` +
          `profile=${pf.padEnd(15)} last=${d.last_active || ''}`
        );
      }
      break;
    }
    case 'profiles': {
      const url = rest[0] || (await defaultNetworkUrl());
      const out = await get(`${url}/profiles`);
      for (const p of out.data) {
        console.log(
          `${p.name.padEnd(20)} paused=${p.paused}  devices=${p.devices?.length ?? 0}`
        );
      }
      break;
    }
    case 'pause':
    case 'unpause': {
      if (!rest[0]) throw new Error(`usage: ${cmd} <profile_name>`);
      const url = await defaultNetworkUrl();
      const profs = (await get(`${url}/profiles`)).data;
      const p = profs.find((x) => x.name.toLowerCase() === rest[0].toLowerCase());
      if (!p) throw new Error(`No profile named "${rest[0]}". Have: ${profs.map((x) => x.name).join(', ')}`);
      await put(p.url, { paused: cmd === 'pause' });
      console.log(`${cmd}d ${p.name}`);
      break;
    }
    case 'usage': {
      const days = Number(rest[0] || 7);
      const url = await defaultNetworkUrl();
      const end = new Date().toISOString();
      const start = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
      const q = new URLSearchParams({ start, end, cadence: 'daily' });
      const out = await get(`${url}/data_usage?${q}`);
      const fmtBytes = (b) => {
        const u = ['B','KB','MB','GB','TB']; let i = 0;
        while (b >= 1024 && i < u.length-1) { b /= 1024; i++; }
        return `${b.toFixed(1)}${u[i]}`;
      };
      for (const s of out.data?.series || []) {
        console.log(`\n${s.type.toUpperCase()} (total ${fmtBytes(s.sum)})`);
        for (const v of s.values || []) {
          const day = v.time.slice(0, 10);
          console.log(`  ${day}  ${fmtBytes(v.value).padStart(8)}`);
        }
      }
      break;
    }
    case 'speedtest': {
      const url = await defaultNetworkUrl();
      const out = await get(`${url}/speedtest`);
      for (const t of (out.data || []).slice(0, 10)) {
        console.log(`${t.date}  down=${t.down_mbps?.toFixed(1)}Mbps  up=${t.up_mbps?.toFixed(1)}Mbps`);
      }
      break;
    }
    default:
      console.log('usage: eero.mjs {login|verify|whoami|networks|devices|profiles|pause|unpause|usage|speedtest} [args]');
      process.exit(cmd ? 2 : 0);
  }
}

main().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
