# Agents Formation static landing — deploy notes

This folder contains the static landing-page assets for **agentsform.ai**.

## ⚠️ DO NOT USE `aws s3 sync --delete` against this site

The S3 bucket `s3://www.agentsform.ai/` is a **hybrid**:

- The bucket **root** (`index.html`, `style.css`, blog HTML files, robots/sitemap)
  is the static landing page in this folder.
- The bucket also contains **a separate Next.js application** under
  subdirectories like `_next/`, `admin/`, `dashboard/`, `pricing/`,
  `choose-plan/`, `child-login/`, `exam/`, `curriculum/`, etc. That app is
  deployed from a different codebase entirely (shared with `tutor.agentsform.ai`
  and `grademychild.com.au`).

If you run `aws s3 sync site/agentsformation/ s3://www.agentsform.ai/ --delete`
**you will wipe the Next.js app**. Do not do this.

## Safe deploy pattern (surgical copy only)

Copy individual files explicitly. Never `--delete`. Never bulk-sync the folder.

```bash
# From the repo root:
aws s3 cp site/agentsformation/index.html              s3://www.agentsform.ai/index.html
aws s3 cp site/agentsformation/style.css               s3://www.agentsform.ai/style.css
aws s3 cp site/agentsformation/blog.html               s3://www.agentsform.ai/blog.html
aws s3 cp site/agentsformation/blog-managed-agents.html s3://www.agentsform.ai/blog-managed-agents.html
aws s3 cp site/agentsformation/robots.txt              s3://www.agentsform.ai/robots.txt
aws s3 cp site/agentsformation/sitemap.xml             s3://www.agentsform.ai/sitemap.xml

# Then invalidate CloudFront so the new versions land at the edge:
aws cloudfront create-invalidation \
  --distribution-id E1QP7Q4V8GZBLK \
  --paths /index.html /style.css /blog.html /blog-managed-agents.html /robots.txt /sitemap.xml
```

## Long-term plan

This bucket's hybrid layout is fragile — any Next.js redeploy from the other
codebase could overwrite our `index.html`. The proper fix is to **move the
agentsform.ai static landing to its own Cloudflare Pages project** (the way
gombwe.com is being migrated), then have the Next.js app live at a separate
subdomain (e.g., `app.agentsform.ai`).

That's a deliberate separate sprint, not a quick fix. Until it's done, treat
this folder as read-from-this-repo, deploy-via-surgical-cp.

## Distribution + bucket reference

| Resource | Value |
|---|---|
| S3 bucket | `s3://www.agentsform.ai/` (region `ap-southeast-2`) |
| CloudFront distribution | `E1QP7Q4V8GZBLK` |
| CloudFront aliases | `agentsform.ai`, `www.agentsform.ai` |
| Live URL | https://agentsform.ai |
