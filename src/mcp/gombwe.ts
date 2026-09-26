#!/usr/bin/env node
/**
 * MCP Server: gombwe's own tools (memory, approvals, ledger).
 *
 * A thin bridge, deliberately: the registry, the permission checks and the
 * ledger all live in the gateway, and this process only carries calls to it.
 * The tool list comes from `GET /api/tools` on start, so a tool added to
 * `gombwe-tools.ts` needs no change here.
 *
 * Transport: stdio (the Claude CLI spawns this per session).
 * Auth:      the session bearer token in GOMBWE_SESSION_TOKEN, minted by the
 *            gateway for this session and written nowhere but the session's
 *            0600 MCP config.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PORT = process.env.GOMBWE_PORT || '18790';
const TOKEN = process.env.GOMBWE_SESSION_TOKEN || '';
const PRINCIPAL = process.env.GOMBWE_PRINCIPAL || 'unknown';
const SESSION_KEY = process.env.GOMBWE_SESSION_KEY || '';
const BASE = `http://127.0.0.1:${PORT}`;
/** The handshake budget. The CLI waits on us, so failing fast beats hanging. */
const START_TIMEOUT_MS = 3_000;
/** A call may sit on an approval; the gateway caps its own wait at 55 s. */
const CALL_TIMEOUT_MS = 70_000;

interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }

function die(message: string): never {
  console.error(`[gombwe-mcp] ${message}`);
  process.exit(1);
}

function api(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** A tool result, as MCP wants it: text content, and `isError` for a failure. */
function content(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

async function fetchTools(): Promise<ToolSpec[]> {
  let res: Response;
  try {
    res = await api('/api/tools', { method: 'GET' }, START_TIMEOUT_MS);
  } catch (err) {
    die(
      `cannot reach the gombwe gateway at ${BASE} (${err instanceof Error ? err.message : String(err)}). ` +
      'Is it running, and is GOMBWE_PORT right?',
    );
  }
  if (res.status === 401 || res.status === 403) {
    die(`the gateway rejected this session's token (HTTP ${res.status}). Start a new session.`);
  }
  if (!res.ok) die(`the gateway answered ${res.status} for /api/tools.`);
  const body = (await res.json()) as { tools?: ToolSpec[] };
  if (!Array.isArray(body?.tools)) die('the gateway answered /api/tools without a tools array.');
  return body.tools;
}

async function callTool(name: string, args: unknown) {
  let res: Response;
  try {
    const body = JSON.stringify(args ?? {});
    res = await api(`/api/tools/${encodeURIComponent(name)}`, { method: 'POST', body }, CALL_TIMEOUT_MS);
  } catch (err) {
    return content(`gombwe is not answering: ${err instanceof Error ? err.message : String(err)}`, true);
  }
  let body: { ok?: boolean; text?: string; error?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return content(`gombwe answered ${res.status} with something that is not JSON.`, true);
  }
  if (!res.ok || body?.ok === false) return content(body?.error || `gombwe answered ${res.status}.`, true);
  return content(body?.text ?? 'Done.');
}

async function main(): Promise<void> {
  if (!TOKEN) die('GOMBWE_SESSION_TOKEN is not set, so there is no session to act for.');
  const specs = await fetchTools();
  const server = new Server({ name: 'gombwe', version: '0.2.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: specs.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: 'object' },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request.params.name;
    if (!specs.some(t => t.name === name)) return content(`unknown tool: ${name}`, true);
    return callTool(name, request.params.arguments);
  });

  await server.connect(new StdioServerTransport());
  console.error(`[gombwe-mcp] ${specs.length} tool(s) for ${PRINCIPAL}${SESSION_KEY ? ` on ${SESSION_KEY}` : ''}.`);
}

main().catch(err => die(err instanceof Error ? err.message : String(err)));
