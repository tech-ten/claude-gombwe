/**
 * AI policy scanner — the "Gombwe 24/7 detection" engine.
 *
 * Every PERIOD_MINUTES:
 *   1. For each device on the kid list, pull recent DNS queries from the
 *      in-memory ring buffer (dnsReceiver().recent() filtered by client IP).
 *   2. If activity is above MIN_QUERIES, send the unique hostnames to Claude
 *      via `claude -p` with a strict prompt asking for a JSON verdict.
 *   3. For each flagged hostname at severity ≥ MIN_AUTO_SEVERITY:
 *        - Auto-block via NetworkService.autoBlockHostnameForKid (per-MAC
 *          firewall rule + kill active connections, audit journal).
 *        - Emit a `network:policy:action` WebSocket event for the dashboard.
 *
 * Strict invariant: this scanner NEVER acts on a device that isn't on the
 * kid list. Even if Claude flags something for an adult device's queries,
 * the scanner won't see them — we filter inputs at step 1, not just outputs.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { dnsReceiver, DnsQueryRecord } from './dns-log-receiver.js';
import { getNetworkService } from './network-service.js';
import { mikrotik } from './mikrotik-client.js';

const PERIOD_MS = 10 * 60 * 1000;      // run every 10 minutes
const MIN_QUERIES = 15;                // skip a device with too little activity
const MIN_AUTO_SEVERITY: 'low' | 'med' | 'high' = 'high';  // conservative default
const MAX_HOSTNAMES_PER_PROMPT = 200;  // protect prompt size

type Severity = 'low' | 'med' | 'high';
interface PolicyVerdict {
  hostname: string;
  severity: Severity;
  reason: string;
  category?: string;
}

const SYSTEM_PROMPT = `You are a strict parental-control policy advisor. You receive a list of DNS hostnames a child's device queried in the last ${PERIOD_MS / 60_000} minutes. Decide which (if any) are inappropriate for a child aged 8-14.

Return JSON ONLY in this exact shape (no prose, no markdown fences):

{"flagged":[{"hostname":"...","severity":"low|med|high","reason":"...","category":"..."}]}

Severity guide:
- high   = clearly harmful for a child (gambling, pornography, drugs, malware, predator-targeted platforms, dating apps, self-harm content)
- med    = inappropriate or age-restricted (alcohol/tobacco marketing, violent games beyond their age rating, social media meant for adults)
- low    = mildly concerning but normal child activity (ad networks, social media used by their age group)

Category is a short tag like "porn", "gambling", "social-media", "ads", "tracking", "gaming", "malware", "vpn", "streaming". Pick the best one.

NEVER flag legitimate kid services (Roblox itself, Minecraft, Khan Academy, school domains, YouTube Kids, Disney, BBC iPlayer kids, Apple/Google update servers, OS telemetry, Microsoft updates, public DNS). If the whole list is fine, return {"flagged":[]}.`;

export class PolicyScanner extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.timer) return;
    console.log(`[policy] AI scanner armed: every ${PERIOD_MS / 60_000} min, min severity to act = ${MIN_AUTO_SEVERITY}`);
    // Don't fire immediately on boot — wait one period so DNS log has data
    this.timer = setInterval(() => this.tick().catch(err => console.error('[policy] tick error:', err)), PERIOD_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Trigger a scan immediately. Useful for the /api/network/policy/scan endpoint. */
  async tick(): Promise<{ scanned: number; flagged: number; blocked: number }> {
    if (this.running) {
      console.log('[policy] previous tick still running, skipping');
      return { scanned: 0, flagged: 0, blocked: 0 };
    }
    this.running = true;
    let scanned = 0, flagged = 0, blocked = 0;
    try {
      const svc = getNetworkService();
      const kidMacs = svc.kidMacs();
      if (kidMacs.length === 0) {
        // Nothing to do — kid list is empty by design. Quiet log so it's not noise.
        return { scanned: 0, flagged: 0, blocked: 0 };
      }

      // Map kid MACs to current IPs via DHCP lease so we can filter the DNS ring.
      const leases = await mikrotik.dhcpLeases();
      const macToIp = new Map<string, string>();
      for (const l of leases) {
        const m = l['mac-address']?.toUpperCase();
        if (m && kidMacs.includes(m) && l.address) macToIp.set(m, l.address);
      }

      const recent = dnsReceiver().recent(5000);

      for (const mac of kidMacs) {
        const ip = macToIp.get(mac);
        if (!ip) continue;  // device offline, no queries to scan
        const queries = recent.filter(q => q.client_ip === ip);
        if (queries.length < MIN_QUERIES) continue;
        scanned++;
        const verdicts = await this.askClaude(queries);
        for (const v of verdicts) {
          flagged++;
          this.emit('flagged', { mac, ...v });
          if (severityRank(v.severity) >= severityRank(MIN_AUTO_SEVERITY)) {
            try {
              const result = await svc.autoBlockHostnameForKid(mac, v.hostname, v.reason, v.severity);
              blocked++;
              this.emit('blocked', { mac, hostname: v.hostname, severity: v.severity, reason: v.reason, ...result });
              console.log(`[policy] AUTO-BLOCK kid=${mac} host=${v.hostname} severity=${v.severity} killed=${result.killed} ips=${result.ips.length}`);
            } catch (err) {
              console.warn(`[policy] autoBlock failed for ${mac}/${v.hostname}:`, err);
            }
          }
        }
      }
    } finally {
      this.running = false;
    }
    return { scanned, flagged, blocked };
  }

  private async askClaude(queries: DnsQueryRecord[]): Promise<PolicyVerdict[]> {
    // Deduplicate hostnames so the model sees the unique set, not the noise.
    const uniq = Array.from(new Set(queries.map(q => q.hostname))).slice(0, MAX_HOSTNAMES_PER_PROMPT);
    const userMsg = SYSTEM_PROMPT + '\n\nHostnames:\n' + uniq.join('\n') + '\n\nReturn JSON now:';

    const output = await new Promise<string>((resolve, reject) => {
      const proc = spawn('claude', [
        '-p', userMsg,
        '--output-format', 'json',
        '--dangerously-skip-permissions',
        '--model', 'claude-haiku-4-5-20251001',   // Haiku is fast + cheap for classification
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      proc.stdout.on('data', c => { stdout += c; });
      proc.stderr.on('data', c => { stderr += c; });
      const t = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('claude scan timeout (60s)')); }, 60_000);
      proc.on('close', code => {
        clearTimeout(t);
        if (code === 0) resolve(stdout);
        else reject(new Error(`claude exit=${code}: ${stderr.slice(-300)}`));
      });
    });

    // claude -p --output-format json returns a wrapper around the result. Extract result.result.
    let resultText = output;
    try {
      const wrapper = JSON.parse(output);
      resultText = wrapper.result ?? output;
    } catch { /* not the wrapper — assume raw JSON */ }

    // Parse the JSON verdict — be lenient about whitespace, fences, prose
    const match = resultText.match(/\{[\s\S]*\}/);
    if (!match) {
      console.warn('[policy] claude returned non-JSON, raw=', resultText.slice(0, 200));
      return [];
    }
    try {
      const parsed = JSON.parse(match[0]);
      const flagged: PolicyVerdict[] = Array.isArray(parsed.flagged) ? parsed.flagged : [];
      // Sanity-filter: require valid severity, non-empty hostname
      return flagged.filter(v =>
        v && typeof v.hostname === 'string' && v.hostname.length > 0 &&
        ['low', 'med', 'high'].includes(v.severity),
      );
    } catch (e) {
      console.warn('[policy] JSON parse failed:', e, 'raw=', resultText.slice(0, 300));
      return [];
    }
  }
}

function severityRank(s: Severity): number {
  return s === 'high' ? 3 : s === 'med' ? 2 : 1;
}

let _instance: PolicyScanner | null = null;
export function policyScanner(): PolicyScanner {
  if (!_instance) _instance = new PolicyScanner();
  return _instance;
}
