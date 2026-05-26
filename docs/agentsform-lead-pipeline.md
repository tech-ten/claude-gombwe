# Agentsform Lead Pipeline (AWS-native)

End-to-end lead-capture flow for agentsform.ai contact forms. Built
entirely on AWS-native services in `ap-southeast-2` — no Cloudflare,
no third-party SaaS, no Mac mini dependency in the customer-facing path.

## Architecture

```
  Visitor on agentsform.ai (S3 + CloudFront)
      │
      │  fills form on /before-you-hire, /talk, or homepage
      │  HTML form POST (no JS, no CORS preflight)
      ▼
  https://api.agentsform.ai/lead
      │  Route 53 alias (A record)
      ▼
  API Gateway HTTP API  (custom domain api.agentsform.ai)
      │
      ▼
  Lambda: agentsform-lead-handler  (Node.js 20.x, arm64, 256MB)
      │
      ├─ honeypot check (_gotcha field empty)
      ├─ validate name + (phone || email)
      ├─ PutItem → DynamoDB table `agentsform-leads`
      └─ HTTP 302 → https://agentsform.ai/thanks.html
```

Future side-flow (deferred, runs on Mac mini):
```
  gombwe daemon
      │  scheduled poll (every N min)
      │  Scan agentsform-leads WHERE processed = false
      │
      ├─ Discord notification per new lead
      ├─ optional: AI-drafted follow-up suggestion via Haiku
      └─ UpdateItem set processed = true
```

## AWS resources (region ap-southeast-2 unless noted)

| Resource | Name / ID | Notes |
|----------|-----------|-------|
| DynamoDB table | `agentsform-leads` | PAY_PER_REQUEST. PK: `lead_id` (UUID). GSI `ts-index` on `ts`. |
| Lambda function | `agentsform-lead-handler` | Node.js 20.x, arm64, 256MB, 10s timeout. Code in `aws/agentsform-lead-handler/index.mjs`. |
| IAM role | `agentsform-lead-handler-role` | Basic execution + inline `agentsform-leads-write` (PutItem only on the leads table). |
| HTTP API | id `dc87zu8fhl` | `POST /lead` → Lambda. CORS allows `https://agentsform.ai` + `https://www.agentsform.ai`. |
| Custom domain | `api.agentsform.ai` | Regional endpoint. TLS 1.2 min. ACM cert in ap-southeast-2. |
| ACM cert | `034a0c32-…` | DNS-validated via Route 53. ap-southeast-2. |
| Route 53 alias | `api.agentsform.ai` (A) | → `d-p5ezcr1wbd.execute-api.ap-southeast-2.amazonaws.com` |

## Lambda source

Source of truth: `aws/agentsform-lead-handler/index.mjs`.

Redeploy after a code change:
```
cd aws/agentsform-lead-handler
zip -q /tmp/lambda-package.zip index.mjs
aws lambda update-function-code \
  --region ap-southeast-2 \
  --function-name agentsform-lead-handler \
  --zip-file fileb:///tmp/lambda-package.zip
```

## Form fields → DynamoDB columns

Standard HTML form POST (application/x-www-form-urlencoded):

| Form field | DDB attribute | Notes |
|------------|---------------|-------|
| `name` (required) | `name` | clamp 200 chars |
| `phone` (required if no email) | `phone` | clamp 50 chars |
| `email` (required if no phone) | `email` | clamp 200 chars |
| `message` (optional) | `message` | clamp 2000 chars |
| `preferred_time` (select) | `preferred_time` | enum: this-morning / this-afternoon / tomorrow-morning / tomorrow-afternoon / later-this-week / next-week / evening |
| `source` (hidden) | `source` | identifies origin page: homepage / before-you-hire / talk |
| `_gotcha` (honeypot) | — | discarded if non-empty |

Lambda-added fields:
- `lead_id` (UUID v4, primary key)
- `ts` (ISO 8601)
- `ip` (from API Gateway request context)
- `user_agent`, `referer` (from headers)
- `processed` (bool, default false — flag for the gombwe poller)

## Reading leads

```
# Most recent leads
aws dynamodb scan --region ap-southeast-2 \
  --table-name agentsform-leads \
  --query 'Items[*].{ts:ts.S,name:name.S,phone:phone.S,source:source.S}' \
  --output table

# Leads from a specific page
aws dynamodb scan --region ap-southeast-2 \
  --table-name agentsform-leads \
  --filter-expression "#s = :src" \
  --expression-attribute-names '{"#s":"source"}' \
  --expression-attribute-values '{":src":{"S":"before-you-hire"}}'

# Unprocessed leads
aws dynamodb scan --region ap-southeast-2 \
  --table-name agentsform-leads \
  --filter-expression "processed = :f" \
  --expression-attribute-values '{":f":{"BOOL":false}}'
```

## Notification (deferred)

Customer-facing path doesn't fire any notification today. To get a
Discord ping when a lead arrives, add a poller on the Mac mini (gombwe)
that scans `agentsform-leads` for `processed = false`, fires Discord
via `notify()`, then `UpdateItem` flips `processed = true`. Trivial to
add — not blocking lead capture.

Cheaper-and-faster alternative if real-time matters: DynamoDB Streams +
EventBridge → SNS (email or SMS). Costs pennies/month. Skipped for v1.

## Static-site deploy

After editing any HTML/CSS in `site/agentsformation/`:

```
aws s3 cp site/agentsformation/index.html s3://www.agentsform.ai/ \
  --content-type "text/html; charset=utf-8" --cache-control "public, max-age=300"
# repeat for before-you-hire.html, talk.html, thanks.html, style.css, sitemap.xml
aws cloudfront create-invalidation --distribution-id E1QP7Q4V8GZBLK --paths "/*"
```

**Do NOT** `aws s3 sync --delete` against `www.agentsform.ai` — the
bucket also serves a Next.js app at subpaths (see `site/agentsformation/README.md`).

## Costs

For ~100 leads/month: ~$0.00, effectively free.
- API Gateway HTTP API: 100 reqs ≈ $0.0001
- Lambda: 100 invocations × ~200ms ≈ $0.000003
- DynamoDB PAY_PER_REQUEST: 100 writes ≈ $0.0001
- Route 53: $0.50/mo per hosted zone (already paid)
- ACM cert: free

Static site (S3 + CloudFront) dominates at maybe $1-3/mo.

## Anti-abuse

In place:
- **Honeypot** (`_gotcha`) — bots fill it, get discarded silently with
  a 302 to /thanks so the bot doesn't know it was caught.
- **CORS** scoped to `https://agentsform.ai` + `https://www.agentsform.ai`
  on the API Gateway side. Limits browser cross-origin abuse from random
  pages (doesn't stop direct curl, but those aren't the threat model).
- **Body size limit** via Lambda's natural input cap.

Worth adding if spam shows up:
- WAF rule for IP-based rate limit (~$5/mo + per-request)
- CAPTCHA (kills conversion — last resort)

## Teardown / reproduce

A CloudFormation template encoding everything below is a worthwhile
follow-up (the AWS account has no IaC today). To recreate from scratch
in another account / region manually:

1. Create DynamoDB table `agentsform-leads` (PAY_PER_REQUEST, PK
   `lead_id`, GSI `ts-index` on `ts`)
2. Create IAM role `agentsform-lead-handler-role` (trust: lambda),
   attach `AWSLambdaBasicExecutionRole`, add inline policy with
   `dynamodb:PutItem` on the leads table ARN
3. `zip` + `aws lambda create-function` from `aws/agentsform-lead-handler/index.mjs`
   (nodejs20.x, arm64, 256MB, 10s, env LEADS_TABLE=agentsform-leads)
4. `aws apigatewayv2 create-api` (HTTP, name agentsform-lead-api,
   CORS = agentsform.ai)
5. `create-integration` (AWS_PROXY, payload v2.0, target = Lambda ARN)
6. `create-route POST /lead`, target = integration
7. `lambda add-permission` for API Gateway to invoke
8. `create-stage $default --auto-deploy`
9. `acm request-certificate` for `api.agentsform.ai` (DNS-validated;
   add the CNAME ACM returns to Route 53)
10. `apigatewayv2 create-domain-name` (REGIONAL, TLS 1.2, attach cert)
11. `apigatewayv2 create-api-mapping` linking custom domain to `$default`
12. Route 53 A-alias `api.agentsform.ai` → `ApiGatewayDomainName`
    with HostedZoneId from the custom-domain config
13. Static site form action → `https://api.agentsform.ai/lead`
