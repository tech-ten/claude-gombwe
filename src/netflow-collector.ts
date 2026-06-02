/**
 * NetFlow v9 collector — records EVERY connection (session) the MikroTik
 * exports, with bytes, packets, and start/end/duration. This is the engine
 * behind the per-device usage dossier (the byte/time data DNS logs can't give).
 *
 * MikroTik side: /ip/traffic-flow enabled, target <gombwe-host>:2055 version=9,
 * active-flow-timeout 1m (long flows export each minute; idle flows after 15s).
 *
 * Storage: ~/.claude-gombwe/data/network/flows-YYYY-MM-DD.jsonl, one flow per
 * line. Retention: files older than RETENTION_DAYS are pruned (kept 90 days).
 *
 * v9 wire format: a header, then FlowSets. FlowSet id 0 = templates (cached by
 * sourceId+templateId), id>=256 = data records parsed via the matching template.
 */
import { createSocket, Socket } from 'node:dgram';
import { appendFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PORT = 2055;
const DATA_DIR = join(homedir(), '.claude-gombwe', 'data', 'network');
const RETENTION_DAYS = 90;

// NetFlow v9 field type IDs we care about.
const F = {
  IN_BYTES: 1, IN_PKTS: 2, PROTOCOL: 4, L4_SRC_PORT: 7, IPV4_SRC_ADDR: 8,
  L4_DST_PORT: 11, IPV4_DST_ADDR: 12, LAST_SWITCHED: 21, FIRST_SWITCHED: 22,
  IPV6_SRC_ADDR: 27, IPV6_DST_ADDR: 28,
};

interface TemplateField { type: number; length: number; }
export interface FlowRecord {
  ts: string;          // export packet time (ISO)
  start: string;       // flow first packet (ISO)
  end: string;         // flow last packet (ISO)
  dur_s: number;       // duration seconds
  src: string; sport: number;
  dst: string; dport: number;
  proto: number;
  bytes: number; packets: number;
}

function readUInt(buf: Buffer, off: number, len: number): number {
  // big-endian unsigned, up to 6 bytes safely in a JS number
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[off + i];
  return v;
}
function readIPv4(buf: Buffer, off: number): string {
  return `${buf[off]}.${buf[off + 1]}.${buf[off + 2]}.${buf[off + 3]}`;
}
function readIPv6(buf: Buffer, off: number): string {
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(off + i).toString(16));
  return parts.join(':');
}

class NetflowCollector {
  private sock: Socket | null = null;
  // templates keyed by `${sourceId}:${templateId}`
  private templates = new Map<string, TemplateField[]>();
  private pruneTimer: NodeJS.Timeout | null = null;
  flowsWritten = 0;

  start(): void {
    if (this.sock) return;
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    this.pruneOld();
    this.pruneTimer = setInterval(() => this.pruneOld(), 24 * 60 * 60 * 1000);

    const sock = createSocket('udp4');
    sock.on('message', (msg) => { try { this.parse(msg); } catch (e) { /* tolerate a bad packet */ } });
    sock.on('error', (err) => console.warn('[netflow] socket error:', err.message));
    sock.bind(PORT, () => console.log(`[netflow] collector listening on udp/${PORT}`));
    this.sock = sock;
  }

  stop(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.sock?.close();
    this.sock = null;
  }

  private parse(buf: Buffer): void {
    if (buf.length < 20) return;
    const version = buf.readUInt16BE(0);
    if (version !== 9) return;
    const sysUptime = buf.readUInt32BE(4);     // ms since router boot
    const unixSecs = buf.readUInt32BE(8);      // export time
    const sourceId = buf.readUInt32BE(16);
    const bootMs = unixSecs * 1000 - sysUptime; // wall-clock of router boot
    const exportIso = new Date(unixSecs * 1000).toISOString();

    let off = 20;
    while (off + 4 <= buf.length) {
      const fsId = buf.readUInt16BE(off);
      const fsLen = buf.readUInt16BE(off + 2);
      if (fsLen < 4 || off + fsLen > buf.length) break;
      const fsEnd = off + fsLen;
      let p = off + 4;

      if (fsId === 0) {
        // Template FlowSet — may carry multiple templates.
        while (p + 4 <= fsEnd) {
          const templateId = buf.readUInt16BE(p);
          const fieldCount = buf.readUInt16BE(p + 2);
          p += 4;
          const fields: TemplateField[] = [];
          for (let i = 0; i < fieldCount && p + 4 <= fsEnd; i++) {
            fields.push({ type: buf.readUInt16BE(p), length: buf.readUInt16BE(p + 2) });
            p += 4;
          }
          this.templates.set(`${sourceId}:${templateId}`, fields);
        }
      } else if (fsId === 1) {
        // Options template — ignore.
      } else if (fsId >= 256) {
        const tmpl = this.templates.get(`${sourceId}:${fsId}`);
        if (tmpl) {
          const recSize = tmpl.reduce((s, f) => s + f.length, 0);
          if (recSize > 0) {
            while (p + recSize <= fsEnd) {
              this.emitRecord(tmpl, buf, p, bootMs, exportIso);
              p += recSize;
            }
          }
        } // else: data before template seen — dropped until next template refresh
      }
      off = fsEnd;
    }
  }

  private emitRecord(tmpl: TemplateField[], buf: Buffer, start: number, bootMs: number, exportIso: string): void {
    const rec: Partial<Record<number, number>> = {};
    let src = '', dst = ''; let p = start;
    for (const f of tmpl) {
      switch (f.type) {
        case F.IPV4_SRC_ADDR: src = readIPv4(buf, p); break;
        case F.IPV4_DST_ADDR: dst = readIPv4(buf, p); break;
        case F.IPV6_SRC_ADDR: src = readIPv6(buf, p); break;
        case F.IPV6_DST_ADDR: dst = readIPv6(buf, p); break;
        default: rec[f.type] = readUInt(buf, p, f.length);
      }
      p += f.length;
    }
    const firstMs = bootMs + (rec[F.FIRST_SWITCHED] ?? 0);
    const lastMs = bootMs + (rec[F.LAST_SWITCHED] ?? 0);
    const flow: FlowRecord = {
      ts: exportIso,
      start: new Date(firstMs).toISOString(),
      end: new Date(lastMs).toISOString(),
      dur_s: Math.max(0, Math.round((lastMs - firstMs) / 100) / 10),
      src, sport: rec[F.L4_SRC_PORT] ?? 0,
      dst, dport: rec[F.L4_DST_PORT] ?? 0,
      proto: rec[F.PROTOCOL] ?? 0,
      bytes: rec[F.IN_BYTES] ?? 0,
      packets: rec[F.IN_PKTS] ?? 0,
    };
    if (!src || !dst) return;
    const day = exportIso.slice(0, 10);
    try {
      appendFileSync(join(DATA_DIR, `flows-${day}.jsonl`), JSON.stringify(flow) + '\n', { mode: 0o600 });
      this.flowsWritten++;
    } catch (e) { /* disk issue — drop */ }
  }

  private pruneOld(): void {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    try {
      for (const f of readdirSync(DATA_DIR)) {
        const m = f.match(/^flows-(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (m && new Date(m[1]).getTime() < cutoff) unlinkSync(join(DATA_DIR, f));
      }
    } catch { /* ignore */ }
  }
}

let _instance: NetflowCollector | null = null;
export function netflowCollector(): NetflowCollector {
  if (!_instance) _instance = new NetflowCollector();
  return _instance;
}
