/**
 * The tool registry: one place that says what gombwe's own agent sessions can
 * do, who may do it, and what gets written down afterwards.
 *
 * A tool is declared once here and reaches the agent three ways without being
 * repeated: `GET /api/tools` renders it as JSON Schema, the stdio bridge in
 * `mcp/gombwe.ts` registers it with the MCP SDK, and `POST /api/tools/:name`
 * runs it through `callTool`. That is deliberate — a tool added to this array
 * cannot be missing a permission check or a ledger line, because neither lives
 * in the handler.
 *
 * Two rules the handlers rely on:
 *   - the grant is checked before the handler runs, against the roster rather
 *     than the `Principal` the caller handed us, so a demotion takes effect on
 *     the next call rather than the next session;
 *   - an act-level tool always leaves a ledger line, ok or failed, unless it
 *     writes its own (`approval_request`, `ledger_record`) — otherwise the
 *     audit trail would show the wrapper twice and the action never.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { shortId } from './approvals.js';
import { MEMORY_KINDS, mayWriteSubject } from './memory.js';
import type { LedgerActor, LedgerOutcome } from './ledger.js';
import type { MemoryKind, MemoryRecord, MemorySource } from './memory.js';
import type { Connector, Level, Principal } from './permissions.js';
import type { Services } from './services.js';

/** Who is calling, on whose behalf, from where. Built by whatever accepted the call. */
export interface ToolContext {
  services: Services;
  principal: Principal;
  sessionKey?: string;
  channel?: string;
  actor: LedgerActor;
}

export type ToolResult =
  | { ok: true; text: string; data?: unknown }
  | { ok: false; error: string };

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  /** The grant this tool sits behind. No connector means everyone may call it. */
  connector?: Connector;
  /** Defaults to `act`: a tool is assumed to change something unless it says otherwise. */
  level?: Level;
  /**
   * Set when the handler writes its own ledger entry, so `callTool` does not
   * wrap it in a second `tool.<name>` line that says nothing extra.
   */
  selfLedgered?: boolean;
  handler: (args: any, ctx: ToolContext) => Promise<ToolResult>;
}

/** What a tool call does not block longer than, so the agent's turn can end. */
export const APPROVAL_WAIT_MS = 55_000;

/** Ledger params are for reading back later, not for storing payloads. */
const MAX_PARAM_STRING = 500;
const MAX_PARAM_DEPTH = 6;

const LEDGER_OUTCOMES: LedgerOutcome[] = ['ok', 'failed', 'denied', 'pending', 'expired'];

const DEFAULT_LEDGER_LIMIT = 20;
const MAX_LEDGER_LIMIT = 200;

/**
 * `Principals.can` reads nothing off the instance, so the same rule applies
 * here without one — `listToolsFor` is handed a principal, not the roster.
 * Enforcement in `callTool` still goes through the real method, so this copy
 * can only ever hide a tool, never allow one.
 */
export function allowsConnector(p: Principal, connector: Connector, level: Level): boolean {
  if (p?.role === 'owner') return true;
  const grant = p?.grants?.[connector];
  if (!grant) return false;
  return level === 'read' ? true : grant === 'act';
}

/** Long strings and deep objects clipped, so one call cannot bloat the ledger. */
function truncate(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_PARAM_STRING ? `${value.slice(0, MAX_PARAM_STRING)}…[truncated]` : value;
  }
  if (depth >= MAX_PARAM_DEPTH || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => truncate(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = truncate(v, depth + 1);
  return out;
}

/** The first zod complaint, phrased for a model reading it in a tool result. */
function schemaError(err: z.ZodError): string {
  const issue = err.issues[0];
  const path = issue?.path?.join('.');
  return `bad arguments: ${path ? `${path}: ` : ''}${issue?.message ?? 'invalid'}`;
}

const kindSchema = z.enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]]);

/** What the agent should say while an approval is still outstanding. */
export function pendingApprovalResult(id: string): ToolResult {
  return {
    ok: true,
    text:
      `Approval ${shortId(id)} is pending. Tell the user you are waiting for their ` +
      'approval and end your turn; the conversation resumes automatically when they decide.',
    data: { status: 'pending', id },
  };
}

function memorySource(ctx: ToolContext): MemorySource {
  return {
    channel: ctx.channel ?? 'mcp',
    sessionKey: ctx.sessionKey ?? 'mcp',
    timestamp: new Date().toISOString(),
  };
}

/** One memory record, flattened to what the agent needs to reason about it. */
function summariseRecord(r: MemoryRecord) {
  return { id: r.id, text: r.text, subject: r.subject, kind: r.kind, updatedAt: r.updatedAt };
}

export const tools: ToolDef[] = [
  {
    name: 'memory_remember',
    description:
      'Remember something about the household worth carrying into later conversations: a ' +
      'preference, a standing instruction, a fact. Defaults to filing it under the person ' +
      'speaking; pass subject "household" for something everyone should know.',
    connector: 'memory',
    level: 'act',
    inputSchema: z.object({
      text: z.string().min(1).describe('The one sentence to remember, in the household\'s own words.'),
      subject: z.string().optional().describe('A principal id, or "household". Defaults to the caller.'),
      kind: kindSchema.describe('What sort of thing this is.'),
    }),
    handler: async (args: { text: string; subject?: string; kind: MemoryKind }, ctx) => {
      const subject = args.subject?.trim() || ctx.principal.id;
      if (!mayWriteSubject(ctx.principal, subject)) {
        return { ok: false, error: `${ctx.principal.name} may not file a memory under ${subject}` };
      }
      const saved = ctx.services.memory.remember(args.text, subject, args.kind, memorySource(ctx));
      return {
        ok: true,
        text: `Remembered for ${saved.subject}: ${saved.text}`,
        data: summariseRecord(saved),
      };
    },
  },
  {
    name: 'memory_recall',
    description:
      'Look up what is remembered that bears on a question. Returns only records the ' +
      'person you are talking to is allowed to see.',
    connector: 'memory',
    level: 'read',
    inputSchema: z.object({
      query: z.string().min(1).describe('The question or topic to search for.'),
      subject: z.string().optional().describe('Narrow to one principal id, or "household".'),
      kind: kindSchema.optional(),
      limit: z.number().int().positive().max(50).optional(),
    }),
    handler: async (
      args: { query: string; subject?: string; kind?: MemoryKind; limit?: number },
      ctx,
    ) => {
      // recallFor, never recall: the visibility cut happens in the store, before
      // anything is scored or counted as used.
      const hits = ctx.services.memory.recallFor(ctx.principal, args.query, {
        subject: args.subject,
        kind: args.kind,
        limit: args.limit,
      });
      const records = hits.map(summariseRecord);
      return {
        ok: true,
        text: records.length
          ? records.map(r => `- (${r.kind}, ${r.subject}) ${r.text}`).join('\n')
          : 'Nothing remembered about that.',
        data: { records },
      };
    },
  },
  {
    name: 'memory_forget',
    description:
      'Forget a memory, by its id or by exactly what it says. The text is tombstoned, so a ' +
      'later reflection pass cannot write it back — only a person saying it again can.',
    connector: 'memory',
    level: 'act',
    inputSchema: z.object({
      idOrText: z.string().min(1).describe('The record id, or the sentence to forget.'),
    }),
    handler: async (args: { idOrText: string }, ctx) => {
      const existing = ctx.services.memory
        .list({ includeForgotten: false })
        .find(r => r.id === args.idOrText || r.text === args.idOrText);
      // Forgetting something filed under another member is a read of theirs by
      // another name, so it needs the same test as writing one.
      if (existing && !mayWriteSubject(ctx.principal, existing.subject)) {
        return { ok: false, error: `${ctx.principal.name} may not forget a memory held for ${existing.subject}` };
      }
      const forgotten = ctx.services.memory.forget(args.idOrText);
      if (!forgotten) return { ok: false, error: `nothing remembered matches "${args.idOrText}"` };
      return {
        ok: true,
        text: `Forgotten for ${forgotten.subject}: ${forgotten.text}`,
        data: summariseRecord(forgotten),
      };
    },
  },
  {
    name: 'approval_request',
    description:
      'Ask the household to approve something before you do it: a payment, a message to ' +
      'someone outside the house, a deletion. Returns approved, denied, or pending — if it ' +
      'is pending, say so and end your turn rather than waiting.',
    level: 'act',
    // approvals.request opens its own ledger entry and tracks its outcome.
    selfLedgered: true,
    inputSchema: z.object({
      class: z.string().min(1).describe('The dotted action class, e.g. pay, send.external, delete.'),
      summary: z.string().min(1).describe('One line a person can decide on without asking you anything.'),
      params: z.record(z.unknown()).optional().describe('The specifics: amount, recipient, what would be deleted.'),
    }),
    handler: async (args: { class: string; summary: string; params?: Record<string, unknown> }, ctx) => {
      const asked = ctx.services.approvals.request({
        class: args.class,
        summary: args.summary,
        params: args.params,
        principal: ctx.principal.id,
        sessionKey: ctx.sessionKey,
        channel: ctx.channel,
      });
      if (asked.policy === 'auto') {
        return { ok: true, text: `No approval needed for ${args.class}. Go ahead.`, data: { status: 'auto' } };
      }
      if (asked.policy === 'never') return { ok: false, error: asked.reason };

      const id = asked.approval.id;
      const settled = await ctx.services.approvals.wait(id, APPROVAL_WAIT_MS);
      if (settled.status === 'pending') return pendingApprovalResult(id);
      if (settled.status === 'approved') {
        return {
          ok: true,
          text: `Approved by ${settled.decidedBy ?? 'the household'}. Go ahead.`,
          data: { status: 'approved', id },
        };
      }
      return {
        ok: false,
        error: settled.status === 'denied'
          ? `Denied by ${settled.decidedBy ?? 'the household'}. Do not do it, and say so.`
          : `Approval ${shortId(id)} expired without a decision. Do not do it.`,
      };
    },
  },
  {
    name: 'approval_status',
    description:
      'Check where an approval you asked for stands, without waiting on it. Use this when ' +
      'you come back to a request that was pending.',
    level: 'read',
    inputSchema: z.object({
      id: z.string().min(1).describe('The approval id you were given.'),
    }),
    handler: async (args: { id: string }, ctx) => {
      const req = ctx.services.approvals.get(args.id);
      if (!req) return { ok: false, error: `no approval with id ${args.id}` };
      return {
        ok: true,
        text: `Approval ${shortId(req.id)} (${req.class}) is ${req.status}: ${req.summary}`,
        data: {
          status: req.status,
          id: req.id,
          class: req.class,
          summary: req.summary,
          decidedBy: req.decidedBy,
          expiresAt: req.expiresAt,
        },
      };
    },
  },
  {
    name: 'ledger_record',
    description:
      'Write down a side effect you had somewhere gombwe cannot see — an order placed, an ' +
      'email sent, a file uploaded. Do this straight after the thing happens, with whatever ' +
      'reference number you got back, so the household can find it later.',
    level: 'act',
    // The whole point of the tool is the entry it writes; a wrapper line would
    // record the call and lose the action.
    selfLedgered: true,
    inputSchema: z.object({
      action: z.string().min(1).describe('Dotted name for what happened, e.g. grocery.order or email.sent.'),
      target: z.string().optional().describe('What it happened to: a shop, a recipient, a filename.'),
      params: z.record(z.unknown()).optional().describe('The specifics of what you did.'),
      receipt: z.record(z.unknown()).optional().describe('Anything that proves it: an order id, a message id, a URL.'),
      outcome: z.enum(LEDGER_OUTCOMES as [LedgerOutcome, ...LedgerOutcome[]]).optional(),
    }),
    handler: async (
      args: {
        action: string;
        target?: string;
        params?: Record<string, unknown>;
        receipt?: Record<string, unknown>;
        outcome?: LedgerOutcome;
      },
      ctx,
    ) => {
      const entry = ctx.services.ledger.record({
        actor: ctx.actor,
        principal: ctx.principal.id,
        action: args.action,
        target: args.target,
        params: args.params ? truncate(args.params) as Record<string, unknown> : undefined,
        receipt: args.receipt ? truncate(args.receipt) as Record<string, unknown> : undefined,
        outcome: args.outcome ?? 'ok',
        sessionKey: ctx.sessionKey,
      });
      return { ok: true, text: `Recorded ${entry.action} as ${entry.outcome}.`, data: { id: entry.id } };
    },
  },
  {
    name: 'ledger_recent',
    description:
      'What gombwe has done lately, newest first. Read this before repeating an action, to ' +
      'check whether it already happened.',
    level: 'read',
    inputSchema: z.object({
      limit: z.number().int().positive().max(MAX_LEDGER_LIMIT).optional(),
    }),
    handler: async (args: { limit?: number }, ctx) => {
      // The ledger is the whole household's, so only an owner reads all of it.
      // Everyone else sees the actions taken in their own name.
      const entries = ctx.services.ledger.list({
        limit: args.limit ?? DEFAULT_LEDGER_LIMIT,
        principal: ctx.principal.role === 'owner' ? undefined : ctx.principal.id,
      });
      return {
        ok: true,
        text: entries.length
          ? entries
            .map(e => `${e.time} ${e.principal} ${e.action}${e.target ? ` → ${e.target}` : ''} [${e.outcome}]`)
            .join('\n')
          : 'Nothing recorded yet.',
        data: { entries },
      };
    },
  },
];

const byName = new Map(tools.map(t => [t.name, t]));

/** The tools this principal's grants let them see. */
export function listToolsFor(p: Principal): ToolDef[] {
  return tools.filter(t => !t.connector || allowsConnector(p, t.connector, t.level ?? 'act'));
}

/** `listToolsFor`, rendered for the wire: what `GET /api/tools` returns. */
export function toolManifestFor(
  p: Principal,
): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return listToolsFor(p).map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema, { target: 'jsonSchema7' }) as Record<string, unknown>,
  }));
}

/**
 * Validate, check the grant, run, write it down.
 *
 * A malformed call is the model getting the shape wrong and leaves no ledger
 * line; a refused or failed call on an act tool does, because both are things
 * the household should be able to see someone tried.
 */
export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tool = byName.get(name);
  if (!tool) return { ok: false, error: `unknown tool: ${name}` };

  const parsed = tool.inputSchema.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: schemaError(parsed.error) };

  const level = tool.level ?? 'act';
  const ledgered = level === 'act' && !tool.selfLedgered;
  const write = (outcome: LedgerOutcome, error?: string) => {
    if (!ledgered) return;
    ctx.services.ledger.record({
      actor: ctx.actor,
      principal: ctx.principal.id,
      action: `tool.${name}`,
      params: truncate(parsed.data) as Record<string, unknown>,
      outcome,
      sessionKey: ctx.sessionKey,
      error,
    });
  };

  if (tool.connector && !ctx.services.principals.can(ctx.principal, tool.connector, level)) {
    const error = `${ctx.principal.name} may not ${level} ${tool.connector}`;
    write('denied', error);
    return { ok: false, error };
  }

  let result: ToolResult;
  try {
    result = await tool.handler(parsed.data, ctx);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  write(result.ok ? 'ok' : 'failed', result.ok ? undefined : result.error);
  return result;
}
