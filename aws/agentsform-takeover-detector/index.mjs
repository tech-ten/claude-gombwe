/**
 * agentsform-takeover-detector
 *
 * Triggered by SNS events from the SES configuration set (Delivery /
 * Send events). For each outbound from ellison@ or hello@:
 *   - If the email's messageId is already in some lead's ai_conversation,
 *     the AI SDR sent it. No action.
 *   - Otherwise it was sent manually by Tendai from Gmail (using the
 *     SES SMTP "Send mail as" credentials). Find the lead by recipient
 *     email and flip ai_status to 'human-handled'.
 *
 * This is what makes the take-over fully organic: Tendai replies from
 * Gmail like normal, and the AI silently steps aside.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const REGION = "ap-southeast-2";
const LEADS_TABLE = "agentsform-leads";
const HUMAN_SENDERS = new Set(["ellison@agentsform.ai", "hello@agentsform.ai", "tendai@agentsform.ai"]);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

export const handler = async (event) => {
  for (const record of event.Records || []) {
    if (record.EventSource !== "aws:sns" || !record.Sns?.Message) continue;
    let body;
    try { body = JSON.parse(record.Sns.Message); }
    catch { console.warn("SNS message not JSON, skip:", record.Sns.Message.slice(0, 200)); continue; }

    // Only act on outbound events. SES sends BOTH 'Send' and 'Delivery' for
    // every email; either is fine, but we'll act on 'Send' to be quickest.
    if (body.eventType !== "Send" && body.eventType !== "Delivery") continue;
    const mail = body.mail || {};
    const messageId = mail.messageId;
    const source = (mail.source || "").toLowerCase();
    const destinations = (mail.destination || []).map(d => d.toLowerCase());
    if (!messageId || !source) continue;

    // Strip display name from source: "Name <a@b>" → "a@b"
    const sourceAddr = source.includes("<") ? source.match(/<([^>]+)>/)?.[1]?.toLowerCase() : source;
    if (!sourceAddr || !HUMAN_SENDERS.has(sourceAddr)) continue;

    // Recipient must match a lead by email AND the messageId must NOT already
    // be in that lead's ai_conversation (which would mean the AI sent it).
    for (const dest of destinations) {
      // Skip own BCC echoes (lead BCC is ellison@; that doesn't count)
      if (HUMAN_SENDERS.has(dest)) continue;
      const lead = await findLeadByEmail(dest);
      if (!lead) continue;

      // Has the AI already recorded this messageId?
      const aiMessageIds = (lead.ai_conversation || [])
        .filter(t => t.role === "ai" && t.message_id)
        .map(t => t.message_id);
      if (aiMessageIds.includes(messageId)) {
        // AI sent it. No action.
        continue;
      }

      // Skip if lead already in a terminal state.
      const status = lead.ai_status;
      if (status === "human-handled" || status === "closed" || status === "no-email") {
        continue;
      }

      // Human took over. Flip the flag + append a human turn so the AI
      // sees a marker in case it reprocesses anything.
      console.log(`Human take-over detected for lead ${lead.lead_id} (${dest}) — ${messageId} not from AI`);
      const humanTurn = {
        role: "human",
        ts: new Date().toISOString(),
        subject: "(human reply via Gmail)",
        body: "(content not captured — sent directly from Tendai's Gmail using SES SMTP)",
        message_id: messageId,
      };
      const convo = [...(lead.ai_conversation || []), humanTurn];
      await ddb.send(new UpdateCommand({
        TableName: LEADS_TABLE,
        Key: { lead_id: lead.lead_id },
        UpdateExpression: "SET ai_status = :s, ai_conversation = :c, ai_last_activity_at = :now, human_takeover_at = :now",
        ExpressionAttributeValues: {
          ":s": "human-handled",
          ":c": convo,
          ":now": new Date().toISOString(),
        },
      }));
    }
  }
  return { status: "ok" };
};

async function findLeadByEmail(email) {
  const res = await ddb.send(new ScanCommand({
    TableName: LEADS_TABLE,
    FilterExpression: "email = :e",
    ExpressionAttributeValues: { ":e": email },
    Limit: 25,
  }));
  const items = res.Items || [];
  if (items.length === 0) return null;
  items.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  return items[0];
}
