# agentsform-takeover-detector

Lambda that closes the "human-takeover" loop on the AI SDR pipeline.

## What it does

When Tendai replies to a lead manually from Gmail (using the "Send mail
as" alias `ellison@agentsform.ai` over SES SMTP), the AI SDR should
detect that and stop auto-responding on that thread. This Lambda
provides that detection.

## How

```
Any outbound from ellison@agentsform.ai (or hello@ / tendai@)
  → SES sends + tags with the "agentsform-default" configuration set
  → Config set publishes Send + Delivery events to SNS topic
                                  "agentsform-ses-events"
  → SNS triggers this Lambda

Lambda:
  - Reads event.mail.messageId, source, destination
  - Filters: source must be in HUMAN_SENDERS set
  - For each destination, finds matching lead by email (DDB Scan)
  - If destination email matches a lead AND the messageId is NOT in
    that lead's ai_conversation (i.e., the AI didn't send it):
    → flip ai_status = "human-handled"
    → append a "human" turn with the message_id for audit
    → set human_takeover_at timestamp
```

Outbound from the AI SDR via SDK fires the same event but the messageId
is already in the lead's ai_conversation (the SDR stored it on send),
so this Lambda no-ops cleanly.

## AWS resources

- SES configuration set: `agentsform-default` (default for the
  `agentsform.ai` identity)
- SNS topic: `agentsform-ses-events`
- This Lambda: `agentsform-takeover-detector`
- IAM role: `agentsform-takeover-role` (basic execution + dynamodb:Scan,
  dynamodb:UpdateItem on the leads table)

## Redeploy

```
cd aws/agentsform-takeover-detector
zip -q /tmp/takeover.zip index.mjs
aws lambda update-function-code \
  --region ap-southeast-2 \
  --function-name agentsform-takeover-detector \
  --zip-file fileb:///tmp/takeover.zip
```

## Verification

To verify after deployment:
1. Submit a real lead via the form (must be a real email you control)
2. Wait for the AI's first email to land
3. From Gmail, reply to that email using "Send mail as ellison@"
4. Within seconds, the lead's row in DDB should have:
   - `ai_status: "human-handled"`
   - `human_takeover_at` set
   - A "human" turn appended to `ai_conversation`
5. If you then send the lead another reply via the AI (e.g. by resetting
   ai_status), the AI will skip them because of the terminal status.
