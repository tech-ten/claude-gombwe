# CloudFormation — agentsform-leads

`agentsform-leads.yaml` is the IaC source of truth for the agentsform.ai
lead-capture stack: DynamoDB + IAM + Lambda + ACM cert + API Gateway HTTP
API + custom domain + Route 53 alias.

## Current state

The LIVE resources in account `308045886682` / region `ap-southeast-2`
were created via `aws` CLI on 2026-05-26 (not via this template). They
exist independently of CloudFormation right now.

To reconcile:
- **Option A** (do nothing): keep using the live resources, treat this
  template as the recipe for DR / fresh redeploy / new environments
- **Option B** (import): bring the live resources under CloudFormation
  management via the import procedure below. Recommended once any
  significant change is needed.

## Validate

```
aws cloudformation validate-template \
  --template-body file://aws/cloudformation/agentsform-leads.yaml
```

## Fresh deploy (e.g. new account, new region)

```
aws cloudformation deploy \
  --region ap-southeast-2 \
  --stack-name agentsform-leads-prod \
  --template-file aws/cloudformation/agentsform-leads.yaml \
  --capabilities CAPABILITY_NAMED_IAM
```

Will create everything from scratch in ~5 min. Cert validation waits
for DNS propagation; rest is immediate.

## Import existing resources (Option B)

CloudFormation supports importing existing resources into a stack.
Multi-step but well-supported.

1. Create a "resources to import" file listing each existing resource
   ARN/identifier under the logical IDs in this template
2. Run `aws cloudformation create-change-set --change-set-type IMPORT`
3. Execute the change set

Detailed runbook: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import.html

Not done yet — defer until first stack update is needed.

## Update Lambda code

The Lambda source is duplicated:
- Canonical: `aws/agentsform-lead-handler/index.mjs`
- Inline copy: `ZipFile` block in `agentsform-leads.yaml`

When the canonical source changes:
1. Update the inline `ZipFile` block to match (or refactor to use
   `Code: { S3Bucket, S3Key }` with a build step)
2. `aws cloudformation deploy ...` to push

For now, in-place CLI updates (`aws lambda update-function-code ...`)
are also fine since the live function isn't under stack management.

## Cost

Identical to the CLI-built stack: ~$0/month at expected volumes.
