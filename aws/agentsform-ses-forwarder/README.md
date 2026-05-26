# agentsform-ses-forwarder

Lambda that re-sends emails arriving at `*@agentsform.ai` to the
appropriate Gmail inbox. Pre-existing infrastructure; brought into the
repo on 2026-05-26 when adding `ellison@` to the routing.

## How the path works

```
External sender → ellison@agentsform.ai (or tendai@, magret@, …)
        │
        ▼
SES receipt rule `forward-tendai-agentsform-ai`
        │   (writes the raw email to S3, then invokes this Lambda)
        ▼
S3: agentsform.ai-ses-emails/inbox/<message-id>
        │
        ▼
THIS Lambda
        - reads the raw MIME from S3
        - looks up the recipient in FORWARD_MAP
        - rewrites headers (preserves Subject, Reply-To, attachments)
        - sends via SES with the mapped "from" address as envelope-sender
        - inbox: the mapped Gmail
```

## Routing map (top of `index.mjs`)

```js
const FORWARD_MAP = {
  "tendai@agentsform.ai":  { to: "tmudavanhu@gmail.com",     from: "forwarder.tendai@agentsform.ai" },
  "magret@agentsform.ai":  { to: "enhancedsoftsys@gmail.com", from: "forwarder.magret@agentsform.ai" },
  "ellison@agentsform.ai": { to: "tmudavanhu@gmail.com",     from: "forwarder.ellison@agentsform.ai" },
};
const DEFAULT_FORWARD = { to: "enhancedsoftsys@gmail.com", from: "forwarder.tendai@agentsform.ai" };
```

To add a new alias: add a line to `FORWARD_MAP`, also add that alias to
the SES receipt rule's `Recipients` list (`aws ses update-receipt-rule`),
then `aws lambda update-function-code`.

## Redeploy after a code change

```
cd aws/agentsform-ses-forwarder
zip -q /tmp/forwarder.zip index.mjs
aws lambda update-function-code \
  --region ap-southeast-2 \
  --function-name agentsform-ses-forwarder \
  --zip-file fileb:///tmp/forwarder.zip
```

## Runtime

- Node.js 20.x, 128MB, default timeout
- No `node_modules` — uses only AWS SDK v3 built into the Lambda runtime
- IAM: needs `s3:GetObject` on `agentsform.ai-ses-emails/inbox/*` +
  `ses:SendRawEmail` on the verified `agentsform.ai` identity

## Files

- `index.mjs` — live source
- `index.mjs.before-ellison-mapping` — reference copy of the pre-2026-05-26
  version, kept for audit. Safe to delete once we trust the new map.

## Why it forwards through a `forwarder.*@agentsform.ai` envelope-sender

Gmail and other big mailbox providers reject messages where the SPF /
DKIM domain doesn't match the envelope `From:`. By rewriting the
envelope-sender to a domain SES owns (`agentsform.ai`), the message
passes SPF for `agentsform.ai`, signed with the domain's DKIM key.

The original sender's address is preserved as the `Reply-To:` header so
replies from the inbox owner go back to the real correspondent, not to
this forwarder.

## Relationship to the SDR pipeline

The AI SDR (`src/agentsform-sdr.ts` in this repo) sends emails from
`ellison@agentsform.ai` via SES SDK with BCC `ellison@agentsform.ai`.
That BCC arrives back at SES → triggers this forwarder → lands the
copy in `tmudavanhu@gmail.com` so Tendai sees every AI outbound
naturally threaded with inbound replies.
