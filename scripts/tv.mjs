#!/usr/bin/env node

/**
 * tv — control an Android / Google TV over ADB from gombwe.
 *
 * Lets gombwe set Private DNS, launch apps, send remote keys, reboot, and
 * check status without ever touching the TV's physical remote — once ADB
 * has been enabled on the TV one time.
 *
 * One-time TV setup (needs the remote OR a phone remote app):
 *   Settings → Device Preferences → About → Build (tap 7×) → developer mode
 *   Settings → Device Preferences → Developer options:
 *     - USB debugging      = ON
 *     - Network debugging  = ON  (note the IP:port shown, usually :5555)
 *
 * Commands:
 *   register <ip[:port]>   Save the TV's IP to config (default port 5555)
 *   connect                adb connect — TV will pop up "Allow ADB?" once
 *   disconnect             adb disconnect
 *   status                 Show connection + current Private DNS
 *   set-dns <hostname>     Set Private DNS to a DoT/DoH hostname
 *   clear-dns              Clear Private DNS (back to "automatic")
 *   block-youtube          Set Private DNS to NextDNS (uses your config)
 *   unblock                Clear Private DNS so YouTube works again
 *   reboot                 Reboot the TV
 *   key <name|code>        Send a key event (HOME, BACK, OK, UP, …)
 *   launch <pkg>           Launch an app by package id (e.g. com.google.android.youtube.tv)
 *   apps                   List installed packages
 *   shell <cmd>            Run an arbitrary adb shell command
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR = join(homedir(), '.claude-gombwe', 'data');
const CONFIG_FILE = join(DATA_DIR, 'tv-config.json');

// NextDNS DoT/DoH hostname for the user's config — pulled from the existing
// gombwe nextdns config so we don't hardcode it.
const NEXTDNS_CONFIG_FILE = join(DATA_DIR, 'nextdns-config.json');

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')); } catch { return {}; }
}

function saveConfig(cfg) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  chmodSync(CONFIG_FILE, 0o600);
}

function nextdnsHostname() {
  if (!existsSync(NEXTDNS_CONFIG_FILE)) return null;
  try {
    const cfg = JSON.parse(readFileSync(NEXTDNS_CONFIG_FILE, 'utf-8'));
    return cfg.configId ? `${cfg.configId}.dns.nextdns.io` : null;
  } catch { return null; }
}

function runAdb(args, opts = {}) {
  const r = spawnSync('adb', args, { encoding: 'utf-8', ...opts });
  return {
    code: r.status ?? -1,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

function ensureAdb() {
  const r = spawnSync('which', ['adb']);
  if (r.status !== 0) {
    console.error('adb is not installed. Install with: brew install android-platform-tools');
    process.exit(2);
  }
}

function target() {
  const cfg = loadConfig();
  if (!cfg.ip) {
    console.error('TV not registered. Run: tv register <ip[:port]>');
    process.exit(2);
  }
  return cfg.port ? `${cfg.ip}:${cfg.port}` : cfg.ip;
}

function ensureConnected() {
  const t = target();
  // Check current devices list
  const list = runAdb(['devices']);
  if (list.stdout.includes(`${t}\tdevice`)) return t;
  // Try to connect
  const c = runAdb(['connect', t]);
  if (c.code !== 0 || /failed|cannot|refused/i.test(c.stdout + c.stderr)) {
    console.error(`Cannot connect to ${t}.`);
    console.error(`  Reason: ${c.stdout || c.stderr}`);
    console.error('  Likely: ADB not enabled on the TV. See Skill docs for one-time setup.');
    process.exit(3);
  }
  // Wait a beat for handshake
  for (let i = 0; i < 5; i++) {
    const l = runAdb(['devices']);
    if (l.stdout.includes(`${t}\tdevice`)) return t;
    if (l.stdout.includes(`${t}\tunauthorized`)) {
      console.error(`TV needs to authorise ADB. On the TV, check the popup and tap "Allow" / "Always allow from this computer".`);
      process.exit(4);
    }
    spawnSync('sleep', ['1']);
  }
  console.error(`Connected to ${t} but not yet "device" state. Try: tv status`);
  process.exit(5);
}

const KEY_NAMES = {
  home: 'KEYCODE_HOME', back: 'KEYCODE_BACK', ok: 'KEYCODE_DPAD_CENTER',
  enter: 'KEYCODE_ENTER', up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT',
  power: 'KEYCODE_POWER', menu: 'KEYCODE_MENU',
  voldown: 'KEYCODE_VOLUME_DOWN', volup: 'KEYCODE_VOLUME_UP',
  mute: 'KEYCODE_VOLUME_MUTE', play: 'KEYCODE_MEDIA_PLAY_PAUSE',
};

async function main() {
  ensureAdb();
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'register': {
      if (!rest[0]) { console.error('usage: tv register <ip[:port]>'); process.exit(2); }
      const [ip, port] = rest[0].split(':');
      saveConfig({ ip, port: port ? Number(port) : 5555, registeredAt: new Date().toISOString() });
      console.log(`Registered TV at ${ip}:${port || 5555}`);
      break;
    }
    case 'connect': {
      const t = target();
      const c = runAdb(['connect', t]);
      console.log(c.stdout || c.stderr);
      break;
    }
    case 'disconnect': {
      const t = target();
      const c = runAdb(['disconnect', t]);
      console.log(c.stdout || c.stderr);
      break;
    }
    case 'status': {
      const t = target();
      const list = runAdb(['devices']);
      const connected = list.stdout.includes(`${t}\tdevice`);
      console.log(`TV: ${t}`);
      console.log(`Connected via ADB: ${connected ? 'yes' : 'no'}`);
      if (!connected) {
        console.log(`(state from adb devices: ${list.stdout})`);
        break;
      }
      const mode = runAdb(['-s', t, 'shell', 'settings', 'get', 'global', 'private_dns_mode']);
      const spec = runAdb(['-s', t, 'shell', 'settings', 'get', 'global', 'private_dns_specifier']);
      console.log(`Private DNS mode: ${mode.stdout || '(unset)'}`);
      console.log(`Private DNS host: ${spec.stdout || '(unset)'}`);
      break;
    }
    case 'set-dns': {
      const host = rest[0];
      if (!host) { console.error('usage: tv set-dns <hostname>'); process.exit(2); }
      const t = ensureConnected();
      runAdb(['-s', t, 'shell', 'settings', 'put', 'global', 'private_dns_mode', 'hostname']);
      runAdb(['-s', t, 'shell', 'settings', 'put', 'global', 'private_dns_specifier', host]);
      console.log(`Private DNS set to ${host}`);
      break;
    }
    case 'clear-dns': {
      const t = ensureConnected();
      runAdb(['-s', t, 'shell', 'settings', 'put', 'global', 'private_dns_mode', 'opportunistic']);
      runAdb(['-s', t, 'shell', 'settings', 'delete', 'global', 'private_dns_specifier']);
      console.log('Private DNS cleared (now opportunistic / automatic).');
      break;
    }
    case 'block-youtube': {
      const host = nextdnsHostname();
      if (!host) {
        console.error('NextDNS config not found at', NEXTDNS_CONFIG_FILE);
        console.error('Run: gombwe nextdns config <api-key> first.');
        process.exit(2);
      }
      const t = ensureConnected();
      runAdb(['-s', t, 'shell', 'settings', 'put', 'global', 'private_dns_mode', 'hostname']);
      runAdb(['-s', t, 'shell', 'settings', 'put', 'global', 'private_dns_specifier', host]);
      console.log(`TV now resolves via NextDNS (${host}).`);
      console.log('YouTube is blocked if it\'s on your NextDNS block list.');
      console.log('Click "YouTube" pill in the gombwe Access Control tab if not already blocked.');
      break;
    }
    case 'unblock': {
      const t = ensureConnected();
      runAdb(['-s', t, 'shell', 'settings', 'put', 'global', 'private_dns_mode', 'opportunistic']);
      runAdb(['-s', t, 'shell', 'settings', 'delete', 'global', 'private_dns_specifier']);
      console.log('TV DNS back to automatic.');
      break;
    }
    case 'reboot': {
      const t = ensureConnected();
      runAdb(['-s', t, 'reboot']);
      console.log('Reboot signalled.');
      break;
    }
    case 'key': {
      const name = (rest[0] || '').toLowerCase();
      const code = KEY_NAMES[name] || name.toUpperCase();
      const t = ensureConnected();
      const r = runAdb(['-s', t, 'shell', 'input', 'keyevent', code]);
      console.log(r.stdout || `sent ${code}`);
      break;
    }
    case 'launch': {
      const pkg = rest[0];
      if (!pkg) { console.error('usage: tv launch <package>'); process.exit(2); }
      const t = ensureConnected();
      const r = runAdb(['-s', t, 'shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
      console.log(r.stdout || r.stderr);
      break;
    }
    case 'apps': {
      const t = ensureConnected();
      const r = runAdb(['-s', t, 'shell', 'pm', 'list', 'packages']);
      console.log(r.stdout);
      break;
    }
    case 'shell': {
      const t = ensureConnected();
      const r = runAdb(['-s', t, 'shell', ...rest]);
      console.log(r.stdout || r.stderr);
      break;
    }
    default:
      console.log('usage: tv {register|connect|status|set-dns|clear-dns|block-youtube|unblock|reboot|key|launch|apps|shell} [args]');
      process.exit(cmd ? 2 : 0);
  }
}

main().catch(e => { console.error('error:', e.message); process.exit(1); });
