import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const ses = new SESClient({ region: "ap-southeast-2" });
const s3 = new S3Client({ region: "ap-southeast-2" });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-southeast-2" }));

// Addresses where inbound replies feed back into the AI SDR loop. When SES
// receives mail at these addresses, also write a structured row to the
// agentsform-inbound DDB table so gombwe can pick it up and continue the
// conversation.
const SDR_INBOUND_ADDRS = new Set(["ellison@agentsform.ai", "hello@agentsform.ai"]);
const INBOUND_TABLE = "agentsform-inbound";

const FORWARD_MAP = {
  "tendai@agentsform.ai": { to: "tmudavanhu@gmail.com", from: "forwarder.tendai@agentsform.ai" },
  "magret@agentsform.ai": { to: "enhancedsoftsys@gmail.com", from: "forwarder.magret@agentsform.ai" },
  "ellison@agentsform.ai": { to: "tmudavanhu@gmail.com", from: "forwarder.ellison@agentsform.ai" },
  "hello@agentsform.ai":   { to: "tmudavanhu@gmail.com", from: "forwarder.hello@agentsform.ai" },
  "office@agentsform.ai":  { to: "tmudavanhu@gmail.com", from: "forwarder.office@agentsform.ai" },
};
const DEFAULT_FORWARD = { to: "enhancedsoftsys@gmail.com", from: "forwarder.tendai@agentsform.ai" };

function splitHeadersBody(raw) {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  let idx;
  if (crlf !== -1 && lf !== -1) idx = Math.min(crlf, lf);
  else idx = crlf !== -1 ? crlf : lf;
  if (idx === -1) return { headerBlock: raw, body: "" };
  return {
    headerBlock: raw.substring(0, idx),
    body: raw.substring(idx).replace(/^(\r?\n)+/, ""),
  };
}

function parseHeaders(headerBlock) {
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2].trim();
  }
  return headers;
}

function getBoundary(contentType) {
  const m = contentType.match(/boundary="?([^";\s]+)"?/i);
  return m ? m[1] : null;
}

function splitParts(body, boundary) {
  const esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = body.split(new RegExp(`--${esc}(?:--)?`, "g"));
  return parts
    .map(p => p.replace(/^\r?\n/, "").replace(/\r?\n$/, ""))
    .filter(p => p && p !== "--");
}

function decodeBody(body, encoding) {
  const e = (encoding || "").toLowerCase();
  if (e === "quoted-printable") {
    return body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  } else if (e === "base64") {
    return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf-8");
  }
  return body;
}

/**
 * Walk a MIME tree recursively, collecting text/html, text/plain, and attachments.
 * Handles arbitrary nesting of multipart/* containers.
 */
function walkMime(raw, out) {
  const { headerBlock, body } = splitHeadersBody(raw);
  const headers = parseHeaders(headerBlock);
  const ct = (headers["content-type"] || "text/plain").toLowerCase();
  const disposition = (headers["content-disposition"] || "").toLowerCase();
  const te = headers["content-transfer-encoding"] || "";

  if (ct.startsWith("multipart/")) {
    const boundary = getBoundary(headers["content-type"]);
    if (!boundary) return;
    for (const part of splitParts(body, boundary)) {
      walkMime(part, out);
    }
    return;
  }

  const isAttachment =
    disposition.startsWith("attachment") ||
    (disposition.startsWith("inline") && !ct.startsWith("text/")) ||
    /name="?[^";]+"?/i.test(headers["content-type"] || "");

  if (ct.startsWith("text/html") && !isAttachment && !out.htmlBody) {
    out.htmlBody = decodeBody(body, te);
    return;
  }
  if (ct.startsWith("text/plain") && !isAttachment && !out.textBody) {
    out.textBody = decodeBody(body, te);
    return;
  }

  // Otherwise treat as attachment — keep raw bytes (decode from transfer encoding).
  let data;
  const enc = te.toLowerCase();
  if (enc === "base64") {
    data = Buffer.from(body.replace(/\s/g, ""), "base64");
  } else if (enc === "quoted-printable") {
    data = Buffer.from(
      body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))),
      "binary"
    );
  } else {
    data = Buffer.from(body, "binary");
  }

  const nameMatch =
    (headers["content-disposition"] || "").match(/filename="?([^";]+)"?/i) ||
    (headers["content-type"] || "").match(/name="?([^";]+)"?/i);
  const filename = nameMatch ? nameMatch[1] : `attachment-${out.attachments.length + 1}`;
  const cid = (headers["content-id"] || "").replace(/^<|>$/g, "");

  out.attachments.push({
    filename,
    contentType: headers["content-type"] || "application/octet-stream",
    data,
    cid,
    inline: disposition.startsWith("inline"),
  });
}

function parseEmail(raw) {
  const { headerBlock } = splitHeadersBody(raw);
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");
  const getHeader = (name) => {
    const m = unfolded.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
    return m ? m[1].trim() : "";
  };

  const out = { htmlBody: "", textBody: "", attachments: [] };
  walkMime(raw, out);

  return {
    subject: getHeader("Subject"),
    from: getHeader("From"),
    replyTo: getHeader("Reply-To"),
    htmlBody: out.htmlBody,
    textBody: out.textBody,
    attachments: out.attachments,
  };
}

function encodeBase64Wrapped(buf) {
  const b64 = buf.toString("base64");
  return b64.match(/.{1,76}/g).join("\r\n");
}

export const handler = async (event) => {
  for (const record of event.Records) {
    const sesNotification = record.ses;
    const messageId = sesNotification.mail.messageId;
    const bucket = "agentsform.ai-ses-emails";
    const key = `inbox/${messageId}`;

    const recipients = sesNotification.receipt.recipients || [];
    const matchedRecipient = recipients.find(r => FORWARD_MAP[r.toLowerCase()]);
    const route = matchedRecipient ? FORWARD_MAP[matchedRecipient.toLowerCase()] : DEFAULT_FORWARD;
    const forwardTo = route.to;
    const fromEmail = route.from;

    console.log(`Processing: ${messageId}, to: ${recipients}, forwarding to: ${forwardTo} via ${fromEmail}`);

    try {
      const s3Response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const rawEmail = await s3Response.Body.transformToString();

      const { subject, from, replyTo, htmlBody, textBody, attachments } = parseEmail(rawEmail);

      const cleanSubject = subject || "No Subject";
      const fromHeader = from || sesNotification.mail.source || "unknown";

      const displayNameMatch = fromHeader.match(/^"?([^"<]+)"?\s*</);
      let displayName = displayNameMatch ? displayNameMatch[1].trim() : "";
      if (!displayName) {
        const emailMatch = fromHeader.match(/@([^.>]+)/);
        if (emailMatch) {
          const domain = emailMatch[1].replace(/^bounce-sg\./, "");
          displayName = domain.charAt(0).toUpperCase() + domain.slice(1);
        } else {
          displayName = fromHeader;
        }
      }

      const replyToEmail = replyTo
        || (fromHeader.match(/<([^>]+)>/) || [])[1]
        || sesNotification.mail.source
        || "";

      const mixedBoundary = `----=_Mixed_${Date.now()}`;
      const altBoundary = `----=_Alt_${Date.now()}`;
      const hasAttachments = attachments.length > 0;

      const headers = [
        `From: "${displayName}" <${fromEmail}>`,
        `To: ${forwardTo}`,
        `Subject: ${cleanSubject}`,
        replyToEmail ? `Reply-To: ${replyToEmail}` : null,
        `MIME-Version: 1.0`,
      ].filter(Boolean);

      // Build the body portion (text/html alternative or single)
      let bodyPart;
      if (htmlBody && textBody) {
        bodyPart = [
          `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
          ``,
          `--${altBoundary}`,
          `Content-Type: text/plain; charset=UTF-8`,
          `Content-Transfer-Encoding: 8bit`,
          ``,
          textBody,
          `--${altBoundary}`,
          `Content-Type: text/html; charset=UTF-8`,
          `Content-Transfer-Encoding: 8bit`,
          ``,
          htmlBody,
          `--${altBoundary}--`,
        ].join("\r\n");
      } else if (htmlBody) {
        bodyPart = [
          `Content-Type: text/html; charset=UTF-8`,
          `Content-Transfer-Encoding: 8bit`,
          ``,
          htmlBody,
        ].join("\r\n");
      } else {
        bodyPart = [
          `Content-Type: text/plain; charset=UTF-8`,
          `Content-Transfer-Encoding: 8bit`,
          ``,
          textBody || "(empty email)",
        ].join("\r\n");
      }

      let mimeBody;
      if (hasAttachments) {
        headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
        const segments = [
          `--${mixedBoundary}`,
          bodyPart,
        ];
        for (const att of attachments) {
          const disp = att.inline ? "inline" : "attachment";
          segments.push(`--${mixedBoundary}`);
          segments.push(`Content-Type: ${att.contentType}`);
          segments.push(`Content-Transfer-Encoding: base64`);
          segments.push(`Content-Disposition: ${disp}; filename="${att.filename.replace(/"/g, "")}"`);
          if (att.cid) segments.push(`Content-ID: <${att.cid}>`);
          segments.push(``);
          segments.push(encodeBase64Wrapped(att.data));
        }
        segments.push(`--${mixedBoundary}--`);
        mimeBody = segments.join("\r\n");
      } else {
        // Inline the body part's headers into the top-level message
        mimeBody = bodyPart;
      }

      const fullMessage = hasAttachments
        ? headers.join("\r\n") + "\r\n\r\n" + mimeBody
        : headers.join("\r\n") + "\r\n" + mimeBody; // bodyPart already has its Content-Type line

      await ses.send(new SendRawEmailCommand({
        RawMessage: { Data: Buffer.from(fullMessage) },
        Source: fromEmail,
        Destinations: [forwardTo],
      }));

      console.log(`Forwarded to ${forwardTo} (attachments: ${attachments.length})`);

      // ── SDR inbound capture ────────────────────────────────────────
      // If the email was destined for an address we use for the AI SDR,
      // also write a structured manifest entry to DynamoDB. Gombwe polls
      // this table to drive the conversation loop. Sender forwarder.*
      // addresses are ignored (those are our own outbound copies coming
      // back via BCC, not lead replies).
      const sdrTarget = recipients.find(r => SDR_INBOUND_ADDRS.has(r.toLowerCase()));
      const senderEmail = parseAddress(fromHeader);
      const isOurOwnForwarder = senderEmail.startsWith("forwarder.") && senderEmail.endsWith("@agentsform.ai");
      const isOurAiSender = senderEmail === "ellison@agentsform.ai" || senderEmail === "hello@agentsform.ai";

      if (sdrTarget && !isOurOwnForwarder && !isOurAiSender) {
        try {
          const inReplyTo = extractHeader(rawEmail, "In-Reply-To");
          const references = extractHeader(rawEmail, "References");
          await ddb.send(new PutCommand({
            TableName: INBOUND_TABLE,
            Item: {
              message_id: messageId,
              ts: new Date().toISOString(),
              recipient: sdrTarget,
              sender_email: senderEmail,
              sender_full: fromHeader,
              subject: cleanSubject,
              in_reply_to: inReplyTo || null,
              references: references || null,
              text_body: (textBody || "").slice(0, 20000),
              s3_bucket: bucket,
              s3_key: key,
              processed: false,
            },
          }));
          console.log(`SDR inbound captured: ${senderEmail} → ${sdrTarget} (${messageId})`);
        } catch (err) {
          console.error("SDR inbound capture failed:", err);
        }
      }
    } catch (error) {
      console.error("Error forwarding:", error);
      throw error;
    }
  }

  return { status: "success" };
};

/** Strip display-name from "Name <addr@host>" → "addr@host". Lowercased. */
function parseAddress(s) {
  if (!s) return "";
  const m = s.match(/<([^>]+)>/);
  const addr = m ? m[1] : s;
  return addr.trim().toLowerCase();
}

/** Extract a single MIME header (case-insensitive, multi-line aware). */
function extractHeader(raw, name) {
  const lines = raw.split(/\r?\n/);
  const lower = name.toLowerCase();
  let captured = "";
  let collecting = false;
  for (const line of lines) {
    if (collecting) {
      // continuation lines start with whitespace
      if (/^\s/.test(line)) { captured += " " + line.trim(); continue; }
      else break;
    }
    const i = line.indexOf(":");
    if (i < 0) {
      if (line === "") break;  // end of headers
      continue;
    }
    if (line.slice(0, i).toLowerCase() === lower) {
      captured = line.slice(i + 1).trim();
      collecting = true;
    }
  }
  return captured;
}
