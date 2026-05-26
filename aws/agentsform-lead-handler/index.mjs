// agentsform-lead-handler
// Receives form POSTs from agentsform.ai contact pages.
// Validates honeypot + required fields, stores to DynamoDB,
// redirects browser to /thanks.html on agentsform.ai.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import querystring from "node:querystring";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.LEADS_TABLE || "agentsform-leads";
const THANKS_URL = "https://agentsform.ai/thanks.html";

const clamp = (s, n) => String(s ?? "").trim().slice(0, n);

export const handler = async (event) => {
  // API Gateway HTTP API v2 — body may be base64-encoded; headers lowercased.
  let body = event.body || "";
  if (event.isBase64Encoded) body = Buffer.from(body, "base64").toString("utf8");

  let parsed = {};
  const ct = (event.headers?.["content-type"] || "").toLowerCase();
  try {
    if (ct.includes("application/x-www-form-urlencoded")) {
      parsed = querystring.parse(body);
    } else if (ct.includes("application/json")) {
      parsed = JSON.parse(body);
    } else {
      // best-effort: try urlencoded
      parsed = querystring.parse(body);
    }
  } catch (e) {
    return text(400, "Could not parse request body.");
  }

  // Honeypot — bots fill _gotcha; pretend success but discard.
  if (clamp(parsed._gotcha, 50).length > 0) {
    return redirect(THANKS_URL);
  }

  const name = clamp(parsed.name, 200);
  const phone = clamp(parsed.phone, 50);
  const email = clamp(parsed.email, 200);
  const message = clamp(parsed.message, 2000);
  const preferred = clamp(parsed.preferred_time, 100);
  const source = clamp(parsed.source, 100) || "unknown";

  if (!name || (!phone && !email)) {
    return text(400, "Name and at least one of phone or email required.");
  }

  const reqCtx = event.requestContext || {};
  const ip = event.headers?.["cf-connecting-ip"]
          || event.headers?.["x-forwarded-for"]?.split(",")[0]?.trim()
          || reqCtx.http?.sourceIp
          || "unknown";

  const item = {
    lead_id: randomUUID(),
    ts: new Date().toISOString(),
    ip,
    name,
    phone: phone || null,
    email: email || null,
    message: message || null,
    preferred_time: preferred || null,
    source,
    user_agent: clamp(event.headers?.["user-agent"], 300),
    referer: clamp(event.headers?.["referer"], 300),
    processed: false,        // for gombwe poller — flips true after Discord ping
  };

  try {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  } catch (err) {
    console.error("DDB put failed:", err);
    return text(500, "Could not record lead. Please call 0401 156 266 directly.");
  }

  return redirect(THANKS_URL);
};

const redirect = (url) => ({
  statusCode: 302,
  headers: { Location: url, "Content-Type": "text/plain; charset=utf-8" },
  body: "",
});
const text = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "text/plain; charset=utf-8" },
  body,
});
