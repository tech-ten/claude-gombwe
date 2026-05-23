import { createInterface } from 'node:readline';
import { readLock } from './daemon-lock.js';
import { listConnectedServices } from './setup.js';

function formatDuration(seconds: number): string {
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function formatStarted(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function fetchJson<T = any>(url: string, timeoutMs = 1500): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}

async function printAttachBanner(port: number): Promise<void> {
  const lock = readLock();
  const base = `http://127.0.0.1:${port}`;

  const [status, triggers, workflows, tasks, sessions, netStatus, netAlerts, eeroAlerts, jobs] = await Promise.all([
    fetchJson<any>(`${base}/api/status`),
    fetchJson<any[]>(`${base}/api/triggers`),
    fetchJson<any[]>(`${base}/api/workflows`),
    fetchJson<any[]>(`${base}/api/tasks`),
    fetchJson<any[]>(`${base}/api/sessions`),
    fetchJson<any>(`${base}/api/network/status`, 2000),
    fetchJson<any[]>(`${base}/api/network/alerts`),
    fetchJson<any[]>(`${base}/api/eero/alerts`),
    fetchJson<any[]>(`${base}/api/cron`),
  ]);

  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
  const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const label = (s: string) => `  ${bold(s.padEnd(11))}`;

  if (!status) {
    console.log(dim('  (status endpoint did not respond — daemon may be busy starting up)'));
    console.log('');
    return;
  }

  // Header
  const pidPort = lock ? `PID ${lock.pid}, port ${lock.port}` : `port ${port}`;
  const up = `up ${formatDuration(status.uptime)}`;
  const startedAt = lock ? ` · started ${formatStarted(lock.startedAt)}` : '';
  console.log(`  ${bold('Daemon')}     ${pidPort} · ${up}${startedAt}`);

  // Resources
  if (status.memory) {
    const rss = formatBytes(status.memory.rss);
    console.log(`${label('Resources')}${rss} memory${status.node ? dim(` · node ${status.node}`) : ''}`);
  }

  // Activity
  const recentTask = (tasks ?? []).slice().sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )[0];
  const failed = (tasks ?? []).filter(t => t.status === 'failed').length;
  const sessionCount = sessions ? sessions.length : 0;
  let activityLine = `${status.tasks.running} running · ${status.tasks.total} total`;
  if (failed > 0) activityLine += ` · ${red(`${failed} failed`)}`;
  activityLine += ` · ${sessionCount} session${sessionCount === 1 ? '' : 's'}`;
  console.log(`${label('Activity')}${activityLine}`);
  if (recentTask) {
    const promptPreview = (recentTask.prompt || '').slice(0, 60).replace(/\s+/g, ' ');
    const statusColor = recentTask.status === 'failed' ? red
      : recentTask.status === 'running' ? yellow
      : (s: string) => s;
    console.log(`${label('Last task')}${dim(`"${promptPreview}"`)} · ${statusColor(recentTask.status)} · ${dim(timeAgo(recentTask.createdAt) + (recentTask.channel ? ` via ${recentTask.channel}` : ''))}`);
  }

  // Channels
  const channelsLine = (status.channels || []).length > 0
    ? (status.channels as string[]).join(', ')
    : dim('none');
  console.log(`${label('Channels')}${channelsLine}`);

  // Services (connected MCPs)
  try {
    const services = listConnectedServices();
    const servicesLine = services.length > 0 ? services.join(', ') : dim('none connected');
    console.log(`${label('Services')}${servicesLine}`);
  } catch {}

  // Automation
  const triggersCount = triggers ? triggers.length : 0;
  const triggersActive = triggers ? triggers.filter((t: any) => t.enabled !== false).length : 0;
  const workflowsCount = workflows ? workflows.length : 0;
  const jobsCount = jobs ? jobs.length : status.cronJobs;
  const jobsActive = jobs ? jobs.filter((j: any) => j.enabled !== false).length : status.cronJobs;
  console.log(`${label('Automation')}${status.skills} skills · ${jobsActive}/${jobsCount} cron · ${triggersActive}/${triggersCount} triggers · ${workflowsCount} workflows`);

  // Network
  if (netStatus) {
    const online = netStatus.online_count ?? 0;
    const known = netStatus.known_count ?? 0;
    const bw = netStatus.current_bandwidth;
    const blocks = netStatus.active_blocks ?? 0;
    const alertCount = netAlerts ? netAlerts.filter((a: any) => !a.dismissed && !a.resolved).length : 0;
    let netLine = `${online}/${known} devices online`;
    if (bw) netLine += ` · ${bw.down_mbps.toFixed(1)}↓ / ${bw.up_mbps.toFixed(1)}↑ Mbps`;
    if (blocks > 0) netLine += ` · ${yellow(`${blocks} blocks`)}`;
    if (alertCount > 0) netLine += ` · ${yellow(`${alertCount} alert${alertCount === 1 ? '' : 's'}`)}`;
    console.log(`${label('Network')}${netLine}`);

    if (netStatus.router) {
      const r = netStatus.router;
      console.log(`${label('Router')}${r.model || 'unknown'} v${r.version || '?'} · up ${r.uptime || '?'} · CPU ${r.cpu_load ?? '?'}%`);
    }
    if (netStatus.data_collector) {
      const dc = netStatus.data_collector;
      const status = dc.running ? dim(`running · ${dc.snapshot_count} snapshots`) : red('stopped');
      console.log(`${label('Collector')}${status}`);
    }
  }

  // Eero (sidecar — only surface when there's something to act on)
  if (eeroAlerts !== null) {
    const unresolved = eeroAlerts.filter((a: any) => !a.dismissed && !a.resolved).length;
    if (unresolved > 0) {
      console.log(`${label('Eero')}${yellow(`${unresolved} alert${unresolved === 1 ? '' : 's'}`)}`);
    }
  }

  // Clients
  const otherClients = Math.max(0, (status.wsClients ?? 1) - 1);
  console.log(`${label('Clients')}${otherClients === 0 ? dim('just you') : `${otherClients} other (dashboard / channels)`}`);

  // Dashboard
  console.log(`${label('Dashboard')}${base}/ui`);

  console.log('');
}

export async function runRepl(port: number): Promise<void> {
  const sessionKey = `cli:${Date.now()}`;
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);

  let detaching = false;

  ws.on('message', (raw: Buffer) => {
    try {
      const event = JSON.parse(raw.toString());

      if (event.type === 'task:output') {
        const text = event.data.text;
        if (text.startsWith('[gombwe]')) {
          console.log(`\n  \x1b[2m${text}\x1b[0m`);
        } else if (!text.startsWith('[stderr]')) {
          process.stdout.write(`\n${text}`);
        }
      }

      if (event.type === 'task:completed') {
        console.log('\n');
        rl.prompt();
      }

      if (event.type === 'task:failed') {
        console.log(`\n  \x1b[31mTask failed: ${event.data.error}\x1b[0m\n`);
        rl.prompt();
      }

      if (event.type === 'session:message') {
        const d = event.data;
        if (d.sessionKey === sessionKey) {
          console.log(`\n${d.message}\n`);
          rl.prompt();
        } else if (d.channel && d.channel !== 'web') {
          const label = d.channel === 'discord' ? '\x1b[34m[discord]\x1b[0m'
            : d.channel === 'telegram' ? '\x1b[36m[telegram]\x1b[0m'
            : `\x1b[33m[${d.channel}]\x1b[0m`;
          console.log(`\n  ${label} ${d.message.slice(0, 200)}${d.message.length > 200 ? '...' : ''}\n`);
          rl.prompt();
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    if (!detaching) {
      console.log(`\n  \x1b[31m[gombwe] Lost connection to daemon — it may have stopped or crashed.\x1b[0m`);
      console.log(`  Check with: gombwe status\n`);
      process.exit(1);
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  await printAttachBanner(port);

  console.log('  Type a message to chat. Type /help for commands.');
  console.log('  Type /task <prompt> for autonomous tasks.');
  console.log('  Press Ctrl+C to detach (daemon keeps running). Use `gombwe stop` to shut down.\n');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[35mgombwe>\x1b[0m ',
  });

  rl.prompt();

  rl.on('line', (line: string) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }

    if (text === '/quit' || text === '/exit') {
      detaching = true;
      ws.close();
      process.exit(0);
    }

    ws.send(JSON.stringify({ type: 'chat', text, sessionKey }));
  });

  rl.on('close', () => {
    detaching = true;
    console.log('\n[gombwe] Detaching (daemon still running).');
    ws.close();
    process.exit(0);
  });
}
