/**
 * Agentsform AI SDR — Phase 1.
 *
 * Polls DynamoDB for new leads (ai_status = "new" OR missing).
 * For each new lead, after a randomised delay (humanises timing):
 *   1. Calls Claude (`claude -p`, Max plan, sonnet) to compose a
 *      personalised first-touch email in Ellison's voice.
 *   2. Sends from ellison@agentsform.ai via SES SDK, BCC'ing
 *      ellison@agentsform.ai so it lands in Tendai's Gmail too
 *      (forwarder Lambda routes ellison@ inbound to his Gmail).
 *   3. Updates the lead's ai_status to "awaiting-reply" + stores the
 *      composed email body + sent message-id for thread tracking.
 *
 * Phase 2 adds: inbound reply handling (poll S3 SES inbox), full
 * conversation loop, escalation detection, take-over detection.
 *
 * Replaces AgentsformLeadPoller (which fired Discord pings). For SDR
 * leads we DON'T want Discord noise — escalation goes via [SDR-ACTION]
 * email to Tendai's Gmail when there's an actual human-required moment.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { spawn } from 'node:child_process';

const REGION = process.env.AGENTSFORM_AWS_REGION || 'ap-southeast-2';
const TABLE = process.env.AGENTSFORM_LEADS_TABLE || 'agentsform-leads';
const INBOUND_TABLE = process.env.AGENTSFORM_INBOUND_TABLE || 'agentsform-inbound';
const FROM_EMAIL = process.env.AGENTSFORM_SDR_FROM || 'Ellison Mudavanhu <ellison@agentsform.ai>';
const BCC_EMAIL = process.env.AGENTSFORM_SDR_BCC || 'ellison@agentsform.ai';
const REPLY_TO = process.env.AGENTSFORM_SDR_REPLY_TO || 'ellison@agentsform.ai';
const ESCALATION_EMAIL = process.env.AGENTSFORM_SDR_ESCALATION || 'tmudavanhu@gmail.com';
const CLAUDE_MODEL = process.env.AGENTSFORM_SDR_MODEL || 'claude-sonnet-4-6';
const POLL_PERIOD_MS = 60_000;
const CLAUDE_TIMEOUT_MS = 90_000;

// Send-delay humanises timing. Env-overridable for testing.
// Production default: 2-7 min, no business-hours multiplier (speed
// beats fake-cadence; nobody pattern-matches "you replied at 9pm").
const BASE_DELAY_MIN_MS = Number(process.env.AGENTSFORM_SDR_DELAY_MIN_MS) || 2 * 60_000;
const BASE_DELAY_MAX_MS = Number(process.env.AGENTSFORM_SDR_DELAY_MAX_MS) || 7 * 60_000;

interface LeadItem {
  lead_id: string;
  ts: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  message?: string | null;
  preferred_time?: string | null;
  source?: string;
  ai_status?: 'new' | 'queued' | 'awaiting-reply' | 'in-flight' | 'human-handled' | 'closed' | 'cold' | 'no-email';
  ai_first_email_at?: string;
  ai_send_after?: string;
  ai_last_activity_at?: string;
  ai_conversation?: Array<{ role: 'ai' | 'lead' | 'human'; ts: string; subject?: string; body: string; message_id?: string }>;
}

interface InboundItem {
  message_id: string;
  ts: string;
  recipient: string;
  sender_email: string;
  sender_full?: string;
  subject?: string;
  in_reply_to?: string | null;
  references?: string | null;
  text_body?: string;
  s3_bucket?: string;
  s3_key?: string;
  processed?: boolean;
}

const SYSTEM_PROMPT = `You are Ellison Mudavanhu, founder of Agentsform, a Melbourne business that runs IT and automates the busywork for other small businesses (mortgage brokers, trades, clinics, distribution). You're writing the FIRST email to a lead who just filled out the contact form on agentsform.ai.

Voice: confident professional who DOES this work daily. Australian English. Speak to their specific details. Position yourself as someone delivering a solution, not exploring possibilities.

LENGTH: under 150 words. Sign "Ellison".

STRUCTURE:
1. Acknowledge their specific situation by name (one short sentence, no fluff like "thanks for reaching out")
2. State directly how we solve this kind of thing for businesses like theirs (one specific sentence; show you've done this before)
3. TWO numbered questions, specific to what they wrote, that move the conversation toward a quote or scope
4. Direct close: reply here or call 0401 156 266

BANNED PHRASES (never use):
- "figuring out what's possible" / "explore possibilities" / "see what we can do" / "looking into" / "happy to chat about" / "would love to" / "feel free to" / "let's discuss" / "circle back" / "ping me"
- "Thanks for reaching out" / "Thanks for your interest" / "I appreciate you" / "Hope this finds you well"
- "As discussed" / "as per our chat" (there is no prior chat)
- AI-disclosure language of any kind
- Marketing buzzwords ("solutions", "streamline", "leverage", "synergy", "transform")

BANNED PUNCTUATION:
- Em-dashes (—) NEVER. Use a period or comma instead.
- Triple dashes (---) NEVER.
- Semicolons sparingly (most sentences should be standalone).

If they gave specific details (a job role, a tool, a pain point), engage with THAT detail concretely. If they gave thin context, ask the two questions that would let you scope properly, do not pad with platitudes.

Output ONLY the email body. No subject. No preamble. No markdown.`;

// ── Follow-up composition (after lead has replied) ─────────────────
// Returns JSON of the form:
//   { action: 'respond', body: '...' }
//   { action: 'escalate', reason: '...', suggested_next: '...' }
//   { action: 'wait', reason: '...' }   // lead's message is just an ack/OOO/auto-reply
const FOLLOWUP_SYSTEM_PROMPT = `You are Ellison Mudavanhu of Agentsform (managed IT + operational automation, Melbourne). A lead has replied to your conversation. Read the full thread and decide the next action.

Voice when responding: measured professional, Australian English. Engage with the specifics they've given (numbers, tools, role names, pain points). Sign "Ellison".

DECIDE one of three actions:

1. RESPOND: continue the conversation by email. Use this when the lead is asking questions you can answer, sharing useful information, or moving toward a quote/scope. Compose the reply body. Keep under 150 words. Same banned phrases and punctuation as the first-touch email (no em-dashes, no marketing buzzwords, no "looking into" / "happy to chat" / "explore possibilities").

2. ESCALATE: the lead is ready for a human. Use this when ANY of these are true:
   - They've asked to book a call or proposed a specific time
   - They've asked for pricing for their actual situation (not generic info)
   - They've asked about contracts, references, or onboarding logistics
   - They've asked directly "are you a person / human / AI / automated / a bot"
   - You've already exchanged 5+ messages and a human should now close
   - They've raised something legally or commercially sensitive
   - They're frustrated or asking for the owner specifically

   When escalating, write a short \`reason\` (one sentence) and \`suggested_next\` (one sentence: what Tendai should do next, e.g. "Confirm Thursday 2:30pm in your calendar, send a quick agenda").

3. WAIT: the lead's last message is an auto-reply, out-of-office, bounce, vacation responder, or one-line acknowledgement that doesn't move the conversation. Don't respond. \`reason\` explains why.

Output STRICTLY valid JSON, no markdown code fence, no prose around it. Schema:
{"action":"respond","body":"..."} OR
{"action":"escalate","reason":"...","suggested_next":"..."} OR
{"action":"wait","reason":"..."}`;

/** Pretty-format a datetime-local input or ISO timestamp in Melbourne time
 *  for inclusion in Claude prompts. Returns the original string if unparseable. */
export function formatMelbourneTime(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d) + ' (Melbourne)';
}

function jitteredDelayMs(): number {
  return Math.floor(BASE_DELAY_MIN_MS + Math.random() * (BASE_DELAY_MAX_MS - BASE_DELAY_MIN_MS));
}

function runClaude(systemPrompt: string, userPrompt: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', [
      '-p', userPrompt,
      '--append-system-prompt', systemPrompt,
      '--output-format', 'text',
      '--dangerously-skip-permissions',
      '--model', model,
    ]);
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error('claude timeout')); }, CLAUDE_TIMEOUT_MS);
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`claude exit ${code}: ${stderr.slice(0, 200)}`));
      else resolve(stdout.trim());
    });
  });
}

export class AgentsformSdr {
  private timer: NodeJS.Timeout | null = null;
  private ddb: DynamoDBDocumentClient;
  private ses: SESv2Client;
  private running = false;

  constructor() {
    this.ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
    this.ses = new SESv2Client({ region: REGION });
  }

  start(): void {
    if (this.timer) return;
    console.log(`[sdr] AI SDR armed: poll every ${POLL_PERIOD_MS / 1000}s, model ${CLAUDE_MODEL}, from ${FROM_EMAIL}`);
    setTimeout(() => this.tick().catch(err => console.error('[sdr] boot tick error:', err)), 5_000);
    this.timer = setInterval(() => this.tick().catch(err => console.error('[sdr] tick error:', err)), POLL_PERIOD_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async tick(): Promise<{ first_touch: number; inbound: number }> {
    if (this.running) return { first_touch: 0, inbound: 0 };
    this.running = true;
    try {
      const first_touch = await this.processFirstTouch();
      const inbound = await this.processInbound();
      return { first_touch, inbound };
    } finally {
      this.running = false;
    }
  }

  // ── First-touch path (Phase 1) ──────────────────────────────────────
  private async processFirstTouch(): Promise<number> {
    let sent = 0;
    try {
      const res = await this.ddb.send(new ScanCommand({
        TableName: TABLE,
        FilterExpression: '(attribute_not_exists(ai_status) OR ai_status = :new) OR (ai_status = :waiting AND ai_send_after < :now)',
        ExpressionAttributeValues: { ':new': 'new', ':waiting': 'queued', ':now': new Date().toISOString() },
        Limit: 50,
      }));
      const items = (res.Items || []) as LeadItem[];

      for (const lead of items) {
        if (!lead.email) {
          await this.markStatus(lead.lead_id, 'no-email');
          continue;
        }
        if (!lead.ai_status || lead.ai_status === 'new') {
          const delayMs = jitteredDelayMs();
          const sendAfter = new Date(Date.now() + delayMs).toISOString();
          await this.ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: { lead_id: lead.lead_id },
            UpdateExpression: 'SET ai_status = :q, ai_send_after = :s',
            ExpressionAttributeValues: { ':q': 'queued', ':s': sendAfter },
          }));
          console.log(`[sdr] queued ${lead.lead_id} (${lead.name}) for first-touch at ${sendAfter} (${Math.round(delayMs / 1000)}s)`);
          continue;
        }
        try {
          const body = await this.composeFirstEmail(lead);
          const subject = `Re your enquiry. ${this.subjectHint(lead)}`;
          const messageId = await this.sendEmail(lead.email, subject, body, undefined);
          const turn = { role: 'ai' as const, ts: new Date().toISOString(), subject, body, message_id: messageId };
          await this.ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: { lead_id: lead.lead_id },
            UpdateExpression: 'SET ai_status = :a, ai_first_email_at = :now, ai_conversation = :c REMOVE ai_send_after',
            ExpressionAttributeValues: { ':a': 'awaiting-reply', ':now': new Date().toISOString(), ':c': [turn] },
          }));
          console.log(`[sdr] sent first email to ${lead.email} for ${lead.lead_id} (${lead.name})`);
          sent++;
        } catch (err) {
          console.error(`[sdr] first-touch send failed for ${lead.lead_id}:`, err);
        }
      }
    } catch (err) {
      console.error('[sdr] first-touch scan failed:', err);
    }
    return sent;
  }

  // ── Inbound conversation path (Phase 2) ─────────────────────────────
  private async processInbound(): Promise<number> {
    let handled = 0;
    try {
      const res = await this.ddb.send(new ScanCommand({
        TableName: INBOUND_TABLE,
        FilterExpression: '#p = :f',
        ExpressionAttributeNames: { '#p': 'processed' },
        ExpressionAttributeValues: { ':f': false },
        Limit: 25,
      }));
      const items = (res.Items || []) as InboundItem[];

      for (const inbound of items) {
        try {
          await this.handleInbound(inbound);
          handled++;
        } catch (err) {
          console.error(`[sdr] inbound handle failed for ${inbound.message_id}:`, err);
        }
      }
    } catch (err) {
      console.error('[sdr] inbound scan failed:', err);
    }
    return handled;
  }

  private async handleInbound(inbound: InboundItem): Promise<void> {
    // 1. Link to a lead by sender email.
    const lead = await this.findLeadByEmail(inbound.sender_email);
    if (!lead) {
      console.log(`[sdr] inbound ${inbound.message_id} from ${inbound.sender_email}: no matching lead, marking processed`);
      await this.markInboundProcessed(inbound.message_id, 'no-matching-lead');
      return;
    }
    if (lead.ai_status === 'human-handled' || lead.ai_status === 'closed') {
      console.log(`[sdr] lead ${lead.lead_id} already ${lead.ai_status}, skipping reply (still marking processed)`);
      await this.markInboundProcessed(inbound.message_id, `skipped-status-${lead.ai_status}`);
      return;
    }

    // 2. Append the lead's message to conversation.
    const leadTurn = {
      role: 'lead' as const,
      ts: inbound.ts,
      subject: inbound.subject,
      body: this.cleanInboundBody(inbound.text_body || ''),
      message_id: inbound.message_id,
    };
    const conversation = [...(lead.ai_conversation || []), leadTurn];

    // 3. Ask Claude what to do.
    const decision = await this.composeFollowup(lead, conversation);
    console.log(`[sdr] decision for ${lead.lead_id}: ${decision.action}${decision.action === 'escalate' ? ` (${decision.reason})` : ''}`);

    // 4. Act on the decision.
    if (decision.action === 'respond' && decision.body) {
      const replySubject = inbound.subject?.toLowerCase().startsWith('re:')
        ? inbound.subject
        : `Re: ${inbound.subject || 'your reply'}`;
      const sentId = await this.sendEmail(lead.email!, replySubject, decision.body, inbound.message_id);
      conversation.push({
        role: 'ai',
        ts: new Date().toISOString(),
        subject: replySubject,
        body: decision.body,
        message_id: sentId,
      });
      await this.updateConversation(lead.lead_id, conversation, 'awaiting-reply');
      console.log(`[sdr] replied to ${lead.email} for ${lead.lead_id}`);
    } else if (decision.action === 'escalate') {
      await this.escalate(lead, conversation, decision.reason || '', decision.suggested_next || '');
      await this.updateConversation(lead.lead_id, conversation, 'human-handled');
      console.log(`[sdr] escalated ${lead.lead_id}: ${decision.reason}`);
    } else {
      // wait — append the lead turn but don't respond
      await this.updateConversation(lead.lead_id, conversation, 'awaiting-reply');
      console.log(`[sdr] waiting on ${lead.lead_id} (${decision.reason || 'auto-reply'})`);
    }

    await this.markInboundProcessed(inbound.message_id, decision.action);
  }

  private async markStatus(leadId: string, status: LeadItem['ai_status']): Promise<void> {
    await this.ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { lead_id: leadId },
      UpdateExpression: 'SET ai_status = :s',
      ExpressionAttributeValues: { ':s': status },
    }));
  }

  private async composeFirstEmail(lead: LeadItem): Promise<string> {
    const userPrompt = [
      `New lead from agentsform.ai. Draft the first-touch email.`,
      ``,
      `Lead details:`,
      `- Name: ${lead.name}`,
      lead.phone ? `- Phone: ${lead.phone}` : null,
      lead.preferred_time ? `- Preferred call time: ${formatMelbourneTime(lead.preferred_time) || lead.preferred_time}` : null,
      `- Source page: ${lead.source || 'unknown'}`,
      lead.message ? `- Message they wrote: "${lead.message}"` : `- They didn't write a specific message.`,
    ].filter(Boolean).join('\n');
    return runClaude(SYSTEM_PROMPT, userPrompt, CLAUDE_MODEL);
  }

  private subjectHint(lead: LeadItem): string {
    const src = (lead.source || '').toLowerCase();
    if (src === 'before-you-hire') return 'hiring vs managed service';
    if (src === 'talk') return 'quick chat';
    return 'your message';
  }

  // Unified send: used for first-touch (no inReplyTo) AND follow-up (with inReplyTo for threading)
  private async sendEmail(
    toEmail: string,
    subject: string,
    body: string,
    inReplyTo: string | undefined,
  ): Promise<string | undefined> {
    // For follow-ups, we want Gmail-style threading. We can't set arbitrary
    // headers via SES Simple content. Skip In-Reply-To threading for now —
    // subject-line "Re: X" matching is sufficient for both Gmail and Outlook
    // to thread correctly. (Header-level threading would need SendRawEmail.)
    void inReplyTo;
    const command = new SendEmailCommand({
      FromEmailAddress: FROM_EMAIL,
      Destination: { ToAddresses: [toEmail], BccAddresses: [BCC_EMAIL] },
      ReplyToAddresses: [REPLY_TO],
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Text: { Data: body, Charset: 'UTF-8' } },
        },
      },
    });
    const res = await this.ses.send(command);
    return res.MessageId;
  }

  private async composeFollowup(
    lead: LeadItem,
    conversation: NonNullable<LeadItem['ai_conversation']>,
  ): Promise<{ action: 'respond' | 'escalate' | 'wait'; body?: string; reason?: string; suggested_next?: string }> {
    // Render the conversation history compactly for Claude.
    const threadText = conversation
      .map(t => `[${t.role === 'ai' ? 'Ellison (you)' : 'Lead'} at ${t.ts}]\nSubject: ${t.subject || '(none)'}\n\n${t.body}`)
      .join('\n\n---\n\n');
    const userPrompt = [
      `Lead context:`,
      `- Name: ${lead.name}`,
      lead.phone ? `- Phone: ${lead.phone}` : null,
      `- Email: ${lead.email}`,
      lead.preferred_time ? `- Preferred call time: ${formatMelbourneTime(lead.preferred_time) || lead.preferred_time}` : null,
      `- Source page: ${lead.source || 'unknown'}`,
      lead.message ? `- Original form message: "${lead.message}"` : null,
      ``,
      `Conversation so far (oldest first):`,
      ``,
      threadText,
      ``,
      `Decide the next action and return JSON.`,
    ].filter(Boolean).join('\n');

    const raw = await runClaude(FOLLOWUP_SYSTEM_PROMPT, userPrompt, CLAUDE_MODEL);
    return parseDecision(raw);
  }

  private async escalate(
    lead: LeadItem,
    conversation: NonNullable<LeadItem['ai_conversation']>,
    reason: string,
    suggestedNext: string,
  ): Promise<void> {
    const threadDump = conversation
      .map(t => `── ${t.role === 'ai' ? 'Ellison (AI)' : 'Lead'} · ${t.ts} ──\nSubject: ${t.subject || '(none)'}\n\n${t.body}`)
      .join('\n\n');
    const body = [
      `Lead: ${lead.name}  ${lead.email ? `<${lead.email}>` : ''}`,
      lead.phone ? `Phone: ${lead.phone}` : null,
      lead.preferred_time ? `Preferred call time: ${formatMelbourneTime(lead.preferred_time) || lead.preferred_time}` : null,
      `Source: ${lead.source || 'unknown'}`,
      ``,
      `Why escalating: ${reason}`,
      `Suggested next step: ${suggestedNext}`,
      ``,
      `To take over: reply to this thread (or directly to the lead) from your Gmail using ellison@. The AI will detect your reply and step aside.`,
      ``,
      `── Conversation ──`,
      ``,
      threadDump,
    ].filter(Boolean).join('\n');

    await this.ses.send(new SendEmailCommand({
      FromEmailAddress: FROM_EMAIL,
      Destination: { ToAddresses: [ESCALATION_EMAIL] },
      ReplyToAddresses: [REPLY_TO],
      Content: {
        Simple: {
          Subject: { Data: `[SDR-ACTION] ${lead.name}: ${reason.slice(0, 60)}`, Charset: 'UTF-8' },
          Body: { Text: { Data: body, Charset: 'UTF-8' } },
        },
      },
    }));
  }

  private async findLeadByEmail(email: string): Promise<LeadItem | null> {
    // Scan with filter — leads table is small (<1000 rows expected). If it
    // ever grows we'll add a GSI on email.
    const res = await this.ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'email = :e',
      ExpressionAttributeValues: { ':e': email.toLowerCase() },
      Limit: 25,
    }));
    const items = (res.Items || []) as LeadItem[];
    if (items.length === 0) return null;
    // If multiple, prefer the most recent active conversation.
    items.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
    return items[0];
  }

  private async updateConversation(
    leadId: string,
    conversation: NonNullable<LeadItem['ai_conversation']>,
    status: NonNullable<LeadItem['ai_status']>,
  ): Promise<void> {
    await this.ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { lead_id: leadId },
      UpdateExpression: 'SET ai_conversation = :c, ai_status = :s, ai_last_activity_at = :now',
      ExpressionAttributeValues: { ':c': conversation, ':s': status, ':now': new Date().toISOString() },
    }));
  }

  private async markInboundProcessed(messageId: string, decision: string): Promise<void> {
    await this.ddb.send(new UpdateCommand({
      TableName: INBOUND_TABLE,
      Key: { message_id: messageId },
      UpdateExpression: 'SET #p = :t, processed_at = :now, decision = :d',
      ExpressionAttributeNames: { '#p': 'processed' },
      ExpressionAttributeValues: { ':t': true, ':now': new Date().toISOString(), ':d': decision },
    }));
  }

  private cleanInboundBody(raw: string): string {
    // Drop everything from the first "On <date>, <name> wrote:" or "From: ..." quote header
    // so we only feed Claude the NEW content of the reply, not the entire thread quoted below.
    const cutPoints = [
      raw.search(/\n\s*On .{0,80}wrote:/i),
      raw.search(/\n\s*-----Original Message-----/i),
      raw.search(/\n\s*From:\s+.*<.*@.*>/i),
      raw.search(/\n\s*>{1,2}\s/),  // quoted reply with > prefix
    ].filter(i => i > 0);
    const cut = cutPoints.length ? Math.min(...cutPoints) : -1;
    const trimmed = cut > 0 ? raw.slice(0, cut).trim() : raw.trim();
    return trimmed.slice(0, 8000);
  }
}

function parseDecision(raw: string): { action: 'respond' | 'escalate' | 'wait'; body?: string; reason?: string; suggested_next?: string } {
  // Strip markdown fence if present
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  try {
    const j = JSON.parse(s);
    if (j.action === 'respond' || j.action === 'escalate' || j.action === 'wait') return j;
  } catch { /* fall through */ }
  // Fallback: if Claude returned prose, escalate so a human sees the raw output
  console.warn('[sdr] unparseable Claude decision:', raw.slice(0, 200));
  return { action: 'escalate', reason: 'AI returned non-JSON response — review thread', suggested_next: 'Review the conversation manually.' };
}
