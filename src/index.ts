#!/usr/bin/env node

import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { loadConfig, saveConfig, getConfigDir } from './config.js';
import { Gateway } from './gateway.js';
import { createProxyServer } from './proxy.js';
import { SERVICES, connectService, disconnectService, listConnectedServices } from './setup.js';

const program = new Command();

program
  .name('gombwe')
  .description('claude-gombwe — Autonomous agent control panel powered by Claude Code')
  .version('0.1.0');

program
  .command('start')
  .description('Start gombwe — interactive terminal + dashboard + channels')
  .option('-p, --port <port>', 'Port to listen on')
  .option('--headless', 'Run without interactive prompt (daemon mode)')
  .action(async (opts) => {
    const config = loadConfig();
    if (opts.port) config.port = parseInt(opts.port, 10);

    console.log(`
  ┌─────────────────────────────────────────┐
  │                                         │
  │   claude-gombwe v0.1.0                  │
  │   Powered by Claude Code                │
  │                                         │
  └─────────────────────────────────────────┘
`);
    console.log(`  Dashboard: http://127.0.0.1:${config.port}`);
    console.log(`  Config:    ${getConfigDir()}/gombwe.json`);
    console.log('');

    const gateway = new Gateway(config);
    await gateway.start();

    if (opts.headless) {
      // Daemon mode — just keep running
      process.on('SIGINT', async () => {
        await gateway.stop();
        process.exit(0);
      });
      process.on('SIGTERM', async () => {
        await gateway.stop();
        process.exit(0);
      });
      return;
    }

    // Interactive REPL — type and chat right here
    const sessionKey = `cli:${Date.now()}`;
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket(`ws://127.0.0.1:${config.port}`);

    // Listen for responses via WebSocket
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
            // Our own chat response
            console.log(`\n${d.message}\n`);
            rl.prompt();
          } else if (d.channel && d.channel !== 'web') {
            // Message from another channel (Discord, Telegram, etc.)
            const label = d.channel === 'discord' ? '\x1b[34m[discord]\x1b[0m'
              : d.channel === 'telegram' ? '\x1b[36m[telegram]\x1b[0m'
              : `\x1b[33m[${d.channel}]\x1b[0m`;
            console.log(`\n  ${label} ${d.message.slice(0, 200)}${d.message.length > 200 ? '...' : ''}\n`);
            rl.prompt();
          }
        }
      } catch {}
    });

    // Wait for WebSocket to connect
    await new Promise<void>((resolve) => {
      ws.on('open', resolve);
    });

    console.log('  Type a message to chat. Type /help for commands.');
    console.log('  Type /task <prompt> for autonomous tasks.');
    console.log('  Press Ctrl+C to quit.\n');

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
        ws.close();
        gateway.stop().then(() => process.exit(0));
        return;
      }

      // Send via WebSocket
      ws.send(JSON.stringify({ type: 'chat', text, sessionKey }));
    });

    rl.on('close', async () => {
      console.log('\n[gombwe] Shutting down...');
      ws.close();
      await gateway.stop();
      process.exit(0);
    });
  });

program
  .command('run <prompt>')
  .description('Run a task and stream the output to your terminal')
  .option('--port <port>', 'Gateway port', '18790')
  .option('--no-wait', 'Fire and forget — don\'t wait for result')
  .action(async (prompt, opts) => {
    const port = opts.port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, channel: 'cli', sessionKey: `cli:${Date.now()}` }),
      });
      const task = await res.json();

      if (!opts.wait) {
        console.log(`Task created: ${task.id}`);
        console.log(`Monitor at: http://127.0.0.1:${port}/ui`);
        return;
      }

      // Stream output via WebSocket
      const WebSocket = (await import('ws')).default;
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);

      console.log(`\n  Running: ${prompt}\n`);

      ws.on('message', (raw: Buffer) => {
        const event = JSON.parse(raw.toString());

        if (event.type === 'task:output' && event.data.taskId === task.id) {
          const text = event.data.text;
          if (text.startsWith('[gombwe]')) {
            console.log(`  ${text}`);
          } else if (!text.startsWith('[stderr]')) {
            process.stdout.write(text.endsWith('\n') ? text : text + '\n');
          }
        }

        if ((event.type === 'task:completed' || event.type === 'task:failed') && event.data.id === task.id) {
          if (event.type === 'task:failed') {
            console.error(`\n  Task failed: ${event.data.error}`);
          }
          console.log('');
          ws.close();
          process.exit(event.type === 'task:completed' ? 0 : 1);
        }
      });

      ws.on('error', () => {
        console.error('  Lost connection to gateway.');
        process.exit(1);
      });

    } catch {
      console.error('Could not connect to gateway. Is gombwe running? Try: gombwe start');
    }
  });

program
  .command('tasks')
  .description('List tasks')
  .option('--port <port>', 'Gateway port', '18790')
  .option('--status <status>', 'Filter by status')
  .action(async (opts) => {
    const port = opts.port;
    const url = opts.status
      ? `http://127.0.0.1:${port}/api/tasks?status=${opts.status}`
      : `http://127.0.0.1:${port}/api/tasks`;
    try {
      const res = await fetch(url);
      const tasks = await res.json();
      if (tasks.length === 0) {
        console.log('No tasks.');
        return;
      }
      for (const t of tasks) {
        const age = timeAgo(t.createdAt);
        console.log(`  [${t.status.padEnd(9)}] ${t.id.slice(0,8)}  ${t.prompt.slice(0,60).padEnd(60)}  ${age}`);
      }
    } catch {
      console.error('Could not connect to gateway.');
    }
  });

program
  .command('status')
  .description('Show gateway status')
  .option('--port <port>', 'Gateway port', '18790')
  .action(async (opts) => {
    try {
      const res = await fetch(`http://127.0.0.1:${opts.port}/api/status`);
      const status = await res.json();
      console.log(`  Name:      ${status.name}`);
      console.log(`  Uptime:    ${Math.floor(status.uptime)}s`);
      console.log(`  Tasks:     ${status.tasks.running} running / ${status.tasks.total} total`);
      console.log(`  Channels:  ${status.channels.join(', ')}`);
      console.log(`  Skills:    ${status.skills}`);
      console.log(`  Cron jobs: ${status.cronJobs}`);
      console.log(`  WS clients: ${status.wsClients}`);
    } catch {
      console.error('Gateway is not running.');
    }
  });

program
  .command('config')
  .description('Show or edit configuration')
  .option('--set <key=value>', 'Set a config value')
  .option('--port <port>', 'Gateway port', '18790')
  .action(async (opts) => {
    const config = loadConfig();
    if (opts.set) {
      const [key, ...rest] = opts.set.split('=');
      const value = rest.join('=');
      const keys = key.split('.');
      let obj: any = config;
      for (let i = 0; i < keys.length - 1; i++) {
        obj = obj[keys[i]] = obj[keys[i]] || {};
      }
      // Try to parse as JSON, fall back to string
      try { obj[keys[keys.length - 1]] = JSON.parse(value); }
      catch { obj[keys[keys.length - 1]] = value; }
      saveConfig(config);
      console.log(`Set ${key} = ${value}`);
    } else {
      console.log(JSON.stringify(config, null, 2));
    }
  });

program
  .command('proxy')
  .description('Start OpenAI-compatible API proxy (Route third-party tools through your subscription)')
  .option('-p, --port <port>', 'Proxy port', '18791')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    console.log(`
  ┌─────────────────────────────────────────┐
  │                                         │
  │   claude-gombwe API proxy               │
  │   OpenAI-compatible → claude -p         │
  │   Uses your Max subscription            │
  │                                         │
  └─────────────────────────────────────────┘
`);
    console.log('  Configure any OpenAI-compatible tool:');
    console.log(`    API Base URL:  http://127.0.0.1:${port}/v1`);
    console.log('    API Key:       anything (not checked)');
    console.log('    Model:         claude-via-subscription');
    console.log('');

    const proxy = createProxyServer(port);

    process.on('SIGINT', () => {
      console.log('\n[proxy] Shutting down...');
      proxy.stop();
      process.exit(0);
    });

    await proxy.start();
  });

program
  .command('up')
  .description('Start EVERYTHING — gateway + proxy + all channels (the one command you need)')
  .option('--gateway-port <port>', 'Gateway port', '18790')
  .option('--proxy-port <port>', 'Proxy port', '18791')
  .action(async (opts) => {
    const config = loadConfig();
    const gatewayPort = parseInt(opts.gatewayPort, 10);
    const proxyPort = parseInt(opts.proxyPort, 10);
    config.port = gatewayPort;

    console.log(`
  ┌─────────────────────────────────────────────────────┐
  │                                                     │
  │   claude-gombwe v0.1.0                              │
  │   Everything is starting up...                      │
  │                                                     │
  │   All services use your Max subscription via         │
  │   the 'claude' CLI. Zero API costs.                 │
  │                                                     │
  └─────────────────────────────────────────────────────┘
`);

    // Start gateway (dashboard + channels + skills + cron)
    const gateway = new Gateway(config);
    await gateway.start();

    // Start proxy (OpenAI-compatible API)
    const proxy = createProxyServer(proxyPort);
    await proxy.start();

    console.log('');
    console.log('  ✓ Everything is running:');
    console.log(`    Dashboard:    http://127.0.0.1:${gatewayPort}/ui`);
    console.log(`    Gateway API:  http://127.0.0.1:${gatewayPort}/api`);
    console.log(`    LLM Proxy:    http://127.0.0.1:${proxyPort}/v1`);
    if (config.channels.telegram?.botToken) console.log('    Telegram:     connected');
    if (config.channels.discord?.botToken) console.log('    Discord:      connected');
    console.log('');
    console.log('  To use with third-party tools:');
    console.log(`    API base: http://127.0.0.1:${proxyPort}/v1`);
    console.log('    Model: claude-via-subscription');
    console.log('');

    const shutdown = async () => {
      console.log('\n[gombwe] Shutting down everything...');
      proxy.stop();
      await gateway.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// --- Event triggers ("when X happens, do Y") ---

program
  .command('watch <name>')
  .description('Create an event trigger — "when X happens, do Y"')
  .requiredOption('--when <prompt>', 'What to watch for (Claude checks this periodically)')
  .requiredOption('--do <prompt>', 'What to do when triggered')
  .option('--notify <channels>', 'Channels to notify (comma-separated, e.g. telegram,web)', 'web')
  .option('--every <seconds>', 'How often to check (seconds)', '300')
  .option('--port <port>', 'Gateway port', '18790')
  .action(async (name, opts) => {
    const body = {
      name,
      source: { type: 'poll_prompt', prompt: opts.when },
      action: {
        prompt: opts.do,
        notify: opts.notify.split(','),
      },
      pollInterval: parseInt(opts.every, 10),
    };
    try {
      const res = await fetch(`http://127.0.0.1:${opts.port}/api/triggers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const trigger = await res.json();
      console.log(`\n  Trigger created: ${trigger.name}`);
      console.log(`  Watching: ${opts.when}`);
      console.log(`  Action:   ${opts.do}`);
      console.log(`  Checks every: ${opts.every}s`);
      console.log(`  Notify: ${opts.notify}\n`);
    } catch {
      console.error('  Gateway not running. Start it with: gombwe up');
    }
  });

program
  .command('triggers')
  .description('List active event triggers')
  .option('--port <port>', 'Gateway port', '18790')
  .action(async (opts) => {
    try {
      const res = await fetch(`http://127.0.0.1:${opts.port}/api/triggers`);
      const triggers = await res.json();
      if (triggers.length === 0) {
        console.log('  No triggers. Create one with: gombwe watch <name> --when "..." --do "..."');
        return;
      }
      console.log('\n  Event triggers:\n');
      for (const t of triggers) {
        const status = t.enabled ? 'active' : 'paused';
        console.log(`    [${status}] ${t.name} (fired ${t.triggerCount}x)`);
        console.log(`      Watch: ${t.source.prompt || t.source.path || t.source.url || t.source.expression}`);
        console.log(`      Do:    ${t.action.prompt.slice(0, 60)}`);
        if (t.lastTriggered) console.log(`      Last:  ${t.lastTriggered}`);
        console.log('');
      }
    } catch {
      console.error('  Gateway not running.');
    }
  });

// --- Workflows ("step 1 → step 2 → step 3") ---

program
  .command('workflow <name>')
  .description('Create a multi-step workflow')
  .requiredOption('--trigger <type>', 'Trigger type: webhook:<path> or poll:<prompt>')
  .requiredOption('--steps <json>', 'Steps as JSON array: [{"name":"...","prompt":"...","notify":["telegram"]}]')
  .option('--description <desc>', 'Workflow description', '')
  .option('--port <port>', 'Gateway port', '18790')
  .action(async (name, opts) => {
    let trigger;
    if (opts.trigger.startsWith('webhook:')) {
      trigger = { type: 'webhook', path: opts.trigger.slice(8) };
    } else if (opts.trigger.startsWith('poll:')) {
      trigger = { type: 'poll_prompt', prompt: opts.trigger.slice(5) };
    } else {
      console.error('  Trigger must start with webhook: or poll:');
      return;
    }

    let steps;
    try { steps = JSON.parse(opts.steps); }
    catch { console.error('  Steps must be valid JSON'); return; }

    try {
      const res = await fetch(`http://127.0.0.1:${opts.port}/api/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: opts.description, trigger, steps }),
      });
      const wf = await res.json();
      console.log(`\n  Workflow created: ${wf.name} (${wf.steps.length} steps)`);
    } catch {
      console.error('  Gateway not running. Start it with: gombwe up');
    }
  });

program
  .command('workflows')
  .description('List workflows')
  .option('--port <port>', 'Gateway port', '18790')
  .action(async (opts) => {
    try {
      const res = await fetch(`http://127.0.0.1:${opts.port}/api/workflows`);
      const workflows = await res.json();
      if (workflows.length === 0) {
        console.log('  No workflows.');
        return;
      }
      console.log('\n  Workflows:\n');
      for (const wf of workflows) {
        console.log(`    ${wf.name} (${wf.steps.length} steps, run ${wf.runCount}x)`);
        console.log(`    ${wf.description || 'No description'}`);
        for (let i = 0; i < wf.steps.length; i++) {
          console.log(`      ${i + 1}. ${wf.steps[i].name}: ${wf.steps[i].prompt.slice(0, 50)}`);
        }
        console.log('');
      }
    } catch {
      console.error('  Gateway not running.');
    }
  });

// --- Service management ---

program
  .command('services')
  .description('List available services and which are connected')
  .action(() => {
    const connected = listConnectedServices();

    console.log('\n  Available services:\n');
    for (const [id, svc] of Object.entries(SERVICES)) {
      const status = connected.includes(id) ? '  [connected]' : '';
      console.log(`    ${id.padEnd(20)} ${svc.description}${status}`);
    }

    console.log('\n  To connect a service:');
    console.log('    gombwe connect <service> --env KEY=value\n');
  });

program
  .command('connect <service>')
  .description('Connect a service (Gmail, GitHub, Slack, etc.)')
  .option('-e, --env <vars...>', 'Environment variables (KEY=value)')
  .action((service, opts) => {
    const svc = SERVICES[service];
    if (!svc) {
      console.error(`  Unknown service: ${service}`);
      console.log('  Run "gombwe services" to see available services.');
      return;
    }

    // Parse env vars from flags
    const envVars: Record<string, string> = {};
    if (opts.env) {
      for (const item of opts.env) {
        const eqIdx = item.indexOf('=');
        if (eqIdx > 0) {
          envVars[item.slice(0, eqIdx)] = item.slice(eqIdx + 1);
        }
      }
    }

    // Check required env vars
    const missing = svc.envVars
      .filter(v => v.required && !envVars[v.key])
      .map(v => `    ${v.key}: ${v.description}`);

    if (missing.length > 0) {
      console.log(`\n  ${svc.name} requires these environment variables:\n`);
      for (const v of svc.envVars) {
        const status = envVars[v.key] ? ' (provided)' : v.required ? ' (REQUIRED)' : ' (optional)';
        console.log(`    ${v.key}${status}`);
        console.log(`      ${v.description}\n`);
      }
      console.log(`  Usage:`);
      const envFlags = svc.envVars.filter(v => v.required).map(v => `-e ${v.key}=YOUR_VALUE`).join(' ');
      console.log(`    gombwe connect ${service} ${envFlags}\n`);
      return;
    }

    connectService(service, envVars);
    console.log(`\n  Connected ${svc.name}!`);
    console.log(`  Claude Code can now access ${svc.description}.\n`);

    if (svc.exampleJobs.length > 0) {
      console.log('  Example jobs you can schedule:\n');
      for (const job of svc.exampleJobs) {
        console.log(`    gombwe job "${job}"\n`);
      }
    }
  });

program
  .command('disconnect <service>')
  .description('Disconnect a service')
  .action((service) => {
    if (disconnectService(service)) {
      console.log(`  Disconnected ${service}.`);
    } else {
      console.log(`  ${service} is not connected.`);
    }
  });

program
  .command('job <prompt>')
  .description('Create a scheduled job')
  .option('-s, --schedule <cron>', 'Cron expression (e.g. "0 9 * * *" for 9am daily)')
  .option('--once', 'Run once right now instead of scheduling')
  .option('--port <port>', 'Gateway port', '18790')
  .action(async (prompt, opts) => {
    const port = opts.port;

    if (opts.once) {
      // Run immediately
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, channel: 'cli', sessionKey: `job:${Date.now()}` }),
        });
        const task = await res.json();
        console.log(`  Job running: ${task.id}`);
        console.log(`  Monitor at: http://127.0.0.1:${port}/ui`);
      } catch {
        console.error('  Gateway not running. Start it with: gombwe up');
      }
      return;
    }

    if (!opts.schedule) {
      console.log('\n  Usage:');
      console.log('    gombwe job "check my email" --schedule "0 9 * * *"   (every day at 9am)');
      console.log('    gombwe job "check my email" --once                    (run right now)');
      console.log('\n  Common schedules:');
      console.log('    "*/30 * * * *"   every 30 minutes');
      console.log('    "0 9 * * *"      every day at 9am');
      console.log('    "0 9 * * 1"      every Monday at 9am');
      console.log('    "0 9,18 * * *"   every day at 9am and 6pm');
      return;
    }

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/cron`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expression: opts.schedule, prompt, channel: 'cron', sessionKey: `cron:${Date.now()}` }),
      });
      const job = await res.json();
      console.log(`  Job scheduled: ${job.id}`);
      console.log(`  Schedule: ${opts.schedule}`);
      console.log(`  Next run: ${job.nextRun}`);
      console.log(`  Prompt: ${prompt}`);
    } catch {
      console.error('  Gateway not running. Start it with: gombwe up');
    }
  });

program
  .command('jobs')
  .description('List scheduled jobs')
  .option('--port <port>', 'Gateway port', '18790')
  .action(async (opts) => {
    try {
      const res = await fetch(`http://127.0.0.1:${opts.port}/api/cron`);
      const jobs = await res.json();
      if (jobs.length === 0) {
        console.log('  No scheduled jobs.');
        console.log('  Create one with: gombwe job "do something" --schedule "0 9 * * *"');
        return;
      }
      console.log('\n  Scheduled jobs:\n');
      for (const j of jobs) {
        const status = j.enabled ? 'active' : 'paused';
        console.log(`    [${status}] ${j.id.slice(0, 8)}  ${j.expression.padEnd(15)}  ${j.prompt.slice(0, 50)}`);
        if (j.nextRun) console.log(`${''.padEnd(14)}next: ${j.nextRun}`);
      }
    } catch {
      console.error('  Gateway not running.');
    }
  });

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

program.parse();
