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
const FROM_EMAIL = process.env.AGENTSFORM_SDR_FROM || 'Ellison Mudavanhu <ellison@agentsform.ai>';
const BCC_EMAIL = process.env.AGENTSFORM_SDR_BCC || 'ellison@agentsform.ai';
const REPLY_TO = process.env.AGENTSFORM_SDR_REPLY_TO || 'ellison@agentsform.ai';
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
  ai_status?: 'new' | 'awaiting-reply' | 'in-flight' | 'human-handled' | 'closed' | 'cold' | 'no-email';
  ai_first_email_at?: string;
  ai_send_after?: string;  // ISO timestamp; SDR waits until past this
  ai_conversation?: Array<{ role: 'ai' | 'lead' | 'human'; ts: string; subject?: string; body: string; message_id?: string }>;
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

  async tick(): Promise<{ scanned: number; sent: number; queued: number }> {
    if (this.running) return { scanned: 0, sent: 0, queued: 0 };
    this.running = true;
    let sent = 0, queued = 0;
    try {
      // 'status' and 'name' are reserved keywords — alias everything to be safe.
      const res = await this.ddb.send(new ScanCommand({
        TableName: TABLE,
        FilterExpression: '(attribute_not_exists(ai_status) OR ai_status = :new) OR (ai_status = :waiting AND ai_send_after < :now)',
        ExpressionAttributeValues: { ':new': 'new', ':waiting': 'queued', ':now': new Date().toISOString() },
        Limit: 50,
      }));
      const items = (res.Items || []) as LeadItem[];

      for (const lead of items) {
        // Skip if no email — SDR is email-only. Mark so we don't keep scanning.
        if (!lead.email) {
          await this.markStatus(lead.lead_id, 'no-email');
          continue;
        }

        // If first time we've seen this lead, queue with a delay.
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
          queued++;
          continue;
        }

        // It's queued AND past send_after. Compose + send.
        try {
          const body = await this.composeFirstEmail(lead);
          const subject = `Re your enquiry — ${this.subjectHint(lead)}`;
          const messageId = await this.sendFirstEmail(lead.email, subject, body);
          const turn = { role: 'ai' as const, ts: new Date().toISOString(), subject, body, message_id: messageId };
          await this.ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: { lead_id: lead.lead_id },
            UpdateExpression: 'SET ai_status = :a, ai_first_email_at = :now, ai_conversation = :c REMOVE ai_send_after',
            ExpressionAttributeValues: {
              ':a': 'awaiting-reply',
              ':now': new Date().toISOString(),
              ':c': [turn],
            },
          }));
          console.log(`[sdr] sent first email to ${lead.email} for ${lead.lead_id} (${lead.name})`);
          sent++;
        } catch (err) {
          console.error(`[sdr] compose/send failed for ${lead.lead_id}:`, err);
          // Leave status=queued so next tick retries.
        }
      }

      return { scanned: items.length, sent, queued };
    } catch (err) {
      console.error('[sdr] scan failed:', err);
      return { scanned: 0, sent, queued };
    } finally {
      this.running = false;
    }
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

  private async sendFirstEmail(toEmail: string, subject: string, body: string): Promise<string | undefined> {
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
}
