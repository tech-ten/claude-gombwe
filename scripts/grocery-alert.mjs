#!/usr/bin/env node
/**
 * GROCERY ALERT — read the latest deals snapshot and notify if anything's
 * actionable. Multi-transport:
 *
 *   1. gombwe /api/notify   — always tries (broadcasts to Discord/Telegram/web
 *                              if those channels are configured in gombwe).
 *   2. Twilio SMS           — if ~/.claude-gombwe/notify-config.json has
 *                              twilio.{sid,token,from}. Sends to every number
 *                              in twilio.to[].
 *   3. WhatsApp Cloud API   — if config has whatsapp.{token,phone_number_id}
 *                              + whatsapp.to[]. Uses Meta's WA Business API.
 *
 * Missing credentials are NOT errors — they're logged ("would send to N
 * via X") and the script keeps going through the other transports.
 *
 * Config template lives at ~/.claude-gombwe/notify-config.example.json.
 *
 * Run conditions:
 *   - Cron every morning (e.g. 06:30) after grocery-watch
 *   - Manually: node scripts/grocery-alert.mjs
 *   - With --dry-run: read snapshot + print what it WOULD send, no transport.
 */
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DATA_DIR   = join(homedir(), '.claude-gombwe', 'data');
const SNAPSHOT   = join(DATA_DIR, 'grocery-deals-latest.json');
const CONFIG     = join(homedir(), '.claude-gombwe', 'notify-config.json');
const GW_PORT    = process.env.GOMBWE_PORT || '18790';

// ── Config + snapshot ────────────────────────────────────────────────

function loadConfig() {
  if (!existsSync(CONFIG)) return {};
  try { return JSON.parse(readFileSync(CONFIG, 'utf-8')); }
  catch (err) { console.warn(`  ! Could not parse ${CONFIG}: ${err.message}`); return {}; }
}

function loadSnapshot() {
  if (!existsSync(SNAPSHOT)) {
    console.error(`No snapshot at ${SNAPSHOT}. Run \`node scripts/grocery-watch.mjs\` first.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(SNAPSHOT, 'utf-8'));
}

// ── Message construction ─────────────────────────────────────────────

function buildAlertText(report) {
  const lines = [];
  lines.push(`gombwe grocery — ${report.rock_bottom.length} rock-bottom item(s) right now`);
  const head = report.rock_bottom.slice(0, 6);
  for (const r of head) {
    lines.push(`• ${r.name} @ $${r.best.price.toFixed(2)} (${r.best.store}, ceiling $${r.max_price})`);
  }
  if (report.rock_bottom.length > 6) lines.push(`… +${report.rock_bottom.length - 6} more`);

  const { woolworths: w, coles: c } = report.carts;
  lines.push('');
  lines.push(`Carts: W $${w.total} ${w.free_delivery ? '✓ free' : `(need $${(75 - w.total).toFixed(2)})`} · C $${c.total} ${c.free_delivery ? '✓ free' : `(need $${(50 - c.total).toFixed(2)})`}`);
  if (w.free_delivery || c.free_delivery) {
    lines.push(`👉 Free-delivery cart ready. Run: gombwe grocery (or skill /grocery-order)`);
  }
  return lines.join('\n');
}

// ── Transports ───────────────────────────────────────────────────────

async function pushGombwe(message) {
  try {
    const res = await fetch(`http://127.0.0.1:${GW_PORT}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) { console.warn(`  gombwe /api/notify → HTTP ${res.status}`); return false; }
    return true;
  } catch (err) {
    console.warn(`  gombwe notify unreachable: ${err.message} (is gombwe running?)`);
    return false;
  }
}

async function pushTwilioSMS(cfg, message) {
  if (!cfg?.sid || !cfg?.token || !cfg?.from) {
    console.log(`  SMS: not configured (set twilio.{sid,token,from,to[]} in ${CONFIG})`);
    if (cfg?.to?.length) console.log(`        Would have sent to: ${cfg.to.join(', ')}`);
    return false;
  }
  const to = cfg.to || [];
  if (!to.length) { console.log(`  SMS: no recipients (twilio.to is empty)`); return false; }
  let sent = 0;
  const auth = 'Basic ' + Buffer.from(`${cfg.sid}:${cfg.token}`).toString('base64');
  for (const number of to) {
    try {
      const params = new URLSearchParams({ From: cfg.from, To: number, Body: message });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      if (res.ok) { console.log(`  SMS → ${number}: sent`); sent++; }
      else { console.warn(`  SMS → ${number}: HTTP ${res.status} ${await res.text().catch(()=>'')}`); }
    } catch (err) {
      console.warn(`  SMS → ${number}: ${err.message}`);
    }
  }
  return sent > 0;
}

async function pushWhatsAppCloud(cfg, message) {
  if (!cfg?.token || !cfg?.phone_number_id) {
    console.log(`  WhatsApp: not configured (set whatsapp.{token,phone_number_id,to[]} in ${CONFIG})`);
    if (cfg?.to?.length) console.log(`            Would have sent to: ${cfg.to.join(', ')}`);
    return false;
  }
  const to = cfg.to || [];
  if (!to.length) { console.log(`  WhatsApp: no recipients (whatsapp.to is empty)`); return false; }
  let sent = 0;
  for (const number of to) {
    try {
      const res = await fetch(`https://graph.facebook.com/v18.0/${cfg.phone_number_id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: number, type: 'text', text: { body: message } }),
      });
      if (res.ok) { console.log(`  WhatsApp → ${number}: sent`); sent++; }
      else { console.warn(`  WhatsApp → ${number}: HTTP ${res.status} ${await res.text().catch(()=>'')}`); }
    } catch (err) {
      console.warn(`  WhatsApp → ${number}: ${err.message}`);
    }
  }
  return sent > 0;
}

// ── Main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

async function main() {
  const report = loadSnapshot();
  const cfg = loadConfig();

  if (report.rock_bottom.length === 0) {
    console.log(`  Nothing at rock-bottom right now (${report.eligible.length} eligible, ${report.waiting.length} above ceiling). No alert sent.`);
    return;
  }

  const message = buildAlertText(report);
  console.log(`\n  ── ALERT MESSAGE ──\n${message}\n  ───────────────────\n`);

  if (dryRun) {
    console.log(`  Dry run: skipping all transports.\n`);
    return;
  }

  await pushGombwe(message);
  await pushTwilioSMS(cfg.twilio, message);
  await pushWhatsAppCloud(cfg.whatsapp, message);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
