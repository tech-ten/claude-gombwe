/**
 * MikroTik DNS log receiver.
 *
 * MikroTik is configured (via REST setup) to remote-syslog its `dns` and
 * `dns,packet` topic logs to this Mac on UDP:1514. Each datagram is one
 * BSD-syslog line. We parse those into structured query records:
 *
 *   { ts, client_ip, client_port, hostname, type, status, answer }
 *
 * The MikroTik packet dump is multi-line per query — `--- sending reply to`
 * starts a packet, then `question:`, `answer:`, then the next packet. We
 * accumulate a small state machine and emit on the next packet boundary.
 *
 * Records get appended to a daily JSONL at
 * ~/.claude-gombwe/data/network/dns-YYYY-MM-DD.jsonl  (mode 600)
 * and also held in an in-memory ring buffer for fast dashboard queries.
 */
import { createSocket, Socket } from 'node:dgram';
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';

const DATA_DIR = join(homedir(), '.claude-gombwe', 'data', 'network');
const PORT = 1514;
const RING_SIZE = 5000;  // ~5–10 minutes of household DNS traffic

export interface DnsQueryRecord {
  ts: string;          // ISO timestamp from when we received the datagram
  client_ip: string;   // who asked
  client_port?: number;
  hostname: string;    // what they asked for (trailing dot stripped)
  type: string;        // A | AAAA | HTTPS | CNAME | …
  status: string;      // "no error" | "non-existent domain" | …
  answer?: string;     // first answer IP if any (we keep this terse)
  blocked?: boolean;   // true if MikroTik adlist suppressed the response
}

interface ParserState {
  client_ip?: string;
  client_port?: number;
  hostname?: string;
  type?: string;
  status?: string;
  answer?: string;
}

/**
 * MikroTik's remote-log datagrams arrive as a single line — not BSD-syslog
 * framed. Each line begins with the topics, then the prefix we configured
 * (`mt-dns:`), then the message body. Example:
 *
 *   "dns mt-dns: query from 192.168.88.242: #2137 gdmf.apple.com. UNKNOWN (65)"
 *   "dns,packet mt-dns: question: gdmf.apple.com.:UNKNOWN (65):IN"
 *
 * Strip the `<topics> <prefix>: ` head and we're left with the message.
 */
function stripPrefix(line: string): string {
  const m = line.match(/^[\w,]+\s+\S+:\s*(.+)$/);
  return m ? m[1] : line;
}

export class DnsLogReceiver extends EventEmitter {
  private sock: Socket | null = null;
  private state: ParserState = {};
  private ring: DnsQueryRecord[] = [];

  start(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    this.sock = createSocket('udp4');
    this.sock.on('error', err => console.error('[dns-receiver] socket error:', err));
    this.sock.on('message', (msg, rinfo) => {
      // Only accept from the MikroTik LAN IP — narrow attack surface
      if (rinfo.address !== '192.168.88.1') return;
      const text = msg.toString('utf-8');
      // A datagram is one syslog line; split on newlines just in case
      for (const line of text.split('\n')) {
        const clean = line.trim();
        if (clean) this.processLine(stripPrefix(clean));
      }
    });
    this.sock.bind(PORT, () => {
      console.log(`[dns-receiver] listening on udp:${PORT} for MikroTik dns,packet stream`);
    });
  }

  stop(): void {
    this.sock?.close();
    this.sock = null;
  }

  /**
   * Process one (de-syslogged) MikroTik log line. The dns,packet topic dumps
   * multi-line packets in sequence — we accumulate state and emit when the
   * next packet starts.
   */
  private processLine(msg: string): void {
    // CLEAN single-line summary on topic `dns` (not `dns,packet`):
    //   "query from 192.168.88.242: #2137 gdmf.apple.com. UNKNOWN (65)"
    // This is the gold path — has client IP, hostname, and type in one shot.
    // Flushes any in-progress packet state and emits immediately.
    const singleLine = msg.match(/^query from ([\d.]+):\s+#\d+\s+(\S+?)\.?\s+(.+)$/);
    if (singleLine) {
      this.flush();
      this.state = {
        client_ip: singleLine[1],
        hostname: singleLine[2],
        type: singleLine[3].trim(),
      };
      this.flush();
      return;
    }

    // ── Multi-line packet topic — kept as fallback for richer data ──

    // "--- sending reply to 192.168.88.242:48844:"  ← reply being sent
    const send = msg.match(/sending reply to ([\d.]+):(\d+)/);
    if (send) {
      this.flush();
      this.state = { client_ip: send[1], client_port: parseInt(send[2], 10) };
      return;
    }

    // "--- got query from 192.168.88.245:53:"  ← incoming query (alt entry point)
    const recv = msg.match(/got query from ([\d.]+):(\d+)/);
    if (recv) {
      this.flush();
      this.state = { client_ip: recv[1], client_port: parseInt(recv[2], 10) };
      return;
    }

    // "id:1725 rd:1 tc:0 aa:0 qr:1 ra:1 QUERY 'no error'"
    const status = msg.match(/qr:\d.*'([^']+)'/);
    if (status) {
      this.state.status = status[1];
      return;
    }

    // "question: signaler-pa.clients6.google.com.:A:IN"
    // Also "question: foo.example.com.:UNKNOWN (65):IN"  ← HTTPS records etc.
    const q = msg.match(/question:\s*([^:]+):([^:]+):IN/);
    if (q) {
      this.state.hostname = q[1].replace(/\.$/, '');
      this.state.type = q[2].trim();
      return;
    }

    // "<signaler-pa.clients6.google.com.:A:138=192.178.187.95>"
    const ans = msg.match(/<[^:]+:[A-Z]+:\d+=([\d.]+|[\da-f:]+)>/);
    if (ans && !this.state.answer) {
      this.state.answer = ans[1];
      return;
    }

    // "done query: #2077 signaler-pa.clients6.google.com. 192.178.187.95"
    // — alternative summary line. If we have no hostname yet, take it.
    const done = msg.match(/done query: #\d+ ([^\s]+)\.?(?:\s+([\d.]+|[\da-f:]+))?/);
    if (done && !this.state.hostname) {
      this.state.hostname = done[1].replace(/\.$/, '');
      if (done[2]) this.state.answer = done[2];
    }

    // Adlist blocked the query
    if (/blocked by adlist|matched adlist/i.test(msg)) {
      this.state.status = 'blocked';
    }
  }

  /** Flush the in-progress record (called when a new packet boundary appears). */
  private flush(): void {
    const s = this.state;
    if (s.client_ip && s.hostname) {
      const rec: DnsQueryRecord = {
        ts: new Date().toISOString(),
        client_ip: s.client_ip,
        client_port: s.client_port,
        hostname: s.hostname,
        type: s.type ?? 'A',
        status: s.status ?? 'unknown',
        ...(s.answer ? { answer: s.answer } : {}),
        ...(s.status === 'blocked' ? { blocked: true } : {}),
      };
      // Append to today's JSONL
      try {
        const dayPath = join(DATA_DIR, `dns-${rec.ts.slice(0, 10)}.jsonl`);
        appendFileSync(dayPath, JSON.stringify(rec) + '\n', { mode: 0o600 });
      } catch (err) { console.error('[dns-receiver] write failed:', err); }
      // Push to ring + emit
      this.ring.push(rec);
      if (this.ring.length > RING_SIZE) this.ring.shift();
      this.emit('query', rec);
    }
    this.state = {};
  }

  /** Snapshot of recent queries (most recent last). */
  recent(limit = 200): DnsQueryRecord[] {
    return this.ring.slice(-limit);
  }

  /** Per-client aggregate over the in-memory ring — used by the dashboard. */
  perClientSummary(): Record<string, { count: number; hostnames: Map<string, number>; blocked: number }> {
    const out: Record<string, { count: number; hostnames: Map<string, number>; blocked: number }> = {};
    for (const r of this.ring) {
      const e = out[r.client_ip] ??= { count: 0, hostnames: new Map(), blocked: 0 };
      e.count++;
      if (r.blocked) e.blocked++;
      e.hostnames.set(r.hostname, (e.hostnames.get(r.hostname) ?? 0) + 1);
    }
    return out;
  }
}

let _instance: DnsLogReceiver | null = null;
export function dnsReceiver(): DnsLogReceiver {
  if (!_instance) _instance = new DnsLogReceiver();
  return _instance;
}
