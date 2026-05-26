# agentsform-lead-handler

Lambda function behind `https://api.agentsform.ai/lead`. Receives form
POSTs from agentsform.ai contact pages, writes to DynamoDB, redirects
to /thanks.html.

See `docs/agentsform-lead-pipeline.md` for the full architecture and
all AWS resources involved.

## Redeploy

```
cd aws/agentsform-lead-handler
zip -q /tmp/lambda-package.zip index.mjs
aws lambda update-function-code \
  --region ap-southeast-2 \
  --function-name agentsform-lead-handler \
  --zip-file fileb:///tmp/lambda-package.zip
```

## Runtime

- Node.js 20.x, arm64
- 256MB memory, 10s timeout
- Env: `LEADS_TABLE=agentsform-leads`
- IAM role: `agentsform-lead-handler-role` (basic execution +
  `dynamodb:PutItem` on `agentsform-leads` table only)

## Inline aws-sdk

Uses `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` which are
provided by the Node.js 20.x Lambda runtime — no `node_modules` needed
in the deployment zip.
