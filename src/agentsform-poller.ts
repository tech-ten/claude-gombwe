/**
 * Agentsform lead poller.
 *
 * Polls the DynamoDB `agentsform-leads` table (in ap-southeast-2) for
 * rows where `processed = false`. For each new lead, fires a Discord
 * notification via the gateway's notify() function, then flips
 * `processed = true` so it isn't notified twice.
 *
 * Runs independently of the customer-facing path (which is AWS-native:
 * agentsform.ai form POST → API Gateway → Lambda → DynamoDB). This
 * poller is the Mac mini's read-only subscriber to that data.
 *
 * Schedule: every POLL_PERIOD_MS. Adjust by changing the constant or
 * (later) wiring to config.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AGENTSFORM_AWS_REGION || 'ap-southeast-2';
const TABLE = process.env.AGENTSFORM_LEADS_TABLE || 'agentsform-leads';
const POLL_PERIOD_MS = 60_000;  // 1 minute — leads are not high-frequency
const SCAN_LIMIT = 25;          // cap items per tick to keep notify volume sane

type NotifyFn = (message: string, targets?: string[]) => unknown;

interface LeadItem {
  lead_id: string;
  ts: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  message?: string | null;
  preferred_time?: string | null;
  source?: string;
  ip?: string;
  processed?: boolean;
}

export class AgentsformLeadPoller {
  private timer: NodeJS.Timeout | null = null;
  private ddb: DynamoDBDocumentClient;
  private running = false;
  private notify: NotifyFn;

  constructor(notify: NotifyFn) {
    this.notify = notify;
    this.ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  }

  start(): void {
    if (this.timer) return;
    console.log(`[agentsform] lead poller armed: every ${POLL_PERIOD_MS / 1000}s against ${TABLE} in ${REGION}`);
    // Fire once shortly after boot so cached leads from offline hours
    // get picked up quickly, then settle into the regular cadence.
    setTimeout(() => this.tick().catch(err => console.error('[agentsform] boot tick error:', err)), 5_000);
    this.timer = setInterval(() => this.tick().catch(err => console.error('[agentsform] tick error:', err)), POLL_PERIOD_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async tick(): Promise<{ scanned: number; notified: number }> {
    if (this.running) return { scanned: 0, notified: 0 };
    this.running = true;
    let notified = 0;
    try {
      // Filter on the unprocessed flag. Scan is fine at expected volume
      // (<100 leads/month); switch to a GSI on processed if it ever grows.
      // 'processed' is a DynamoDB reserved keyword — alias via #p.
      const res = await this.ddb.send(new ScanCommand({
        TableName: TABLE,
        FilterExpression: '#p = :f',
        ExpressionAttributeNames: { '#p': 'processed' },
        ExpressionAttributeValues: { ':f': false },
        Limit: SCAN_LIMIT * 4,  // overscan because the filter runs after the read
      }));
      const items = (res.Items || []) as LeadItem[];

      for (const lead of items.slice(0, SCAN_LIMIT)) {
        try {
          this.notify(this.formatLead(lead));
          await this.ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: { lead_id: lead.lead_id },
            UpdateExpression: 'SET #p = :t, processed_at = :now',
            ExpressionAttributeNames: { '#p': 'processed' },
            ExpressionAttributeValues: { ':t': true, ':now': new Date().toISOString() },
          }));
          notified++;
        } catch (err) {
          console.error(`[agentsform] notify/update failed for lead ${lead.lead_id}:`, err);
          // Leave processed=false so we retry on the next tick.
        }
      }

      return { scanned: items.length, notified };
    } catch (err) {
      console.error('[agentsform] scan failed:', err);
      return { scanned: 0, notified };
    } finally {
      this.running = false;
    }
  }

  private formatLead(lead: LeadItem): string {
    const lines = [
      `**New lead from agentsform.ai** (${lead.source || 'unknown'})`,
      `Name: ${lead.name}`,
      lead.phone ? `Phone: ${lead.phone}` : null,
      lead.email ? `Email: ${lead.email}` : null,
      lead.preferred_time ? `Preferred time: ${lead.preferred_time}` : null,
      lead.message ? `Message: ${lead.message}` : null,
      lead.ip ? `_(${lead.ip} · ${lead.ts})_` : `_(${lead.ts})_`,
    ].filter(Boolean);
    return lines.join('\n');
  }
}
