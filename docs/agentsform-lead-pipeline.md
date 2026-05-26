# Agentsform Lead Pipeline

Lead-capture flow for agentsform.ai contact forms. Owned end-to-end —
no Calendly, no Formspree, no third-party SaaS in the loop.

## Architecture

```
  Visitor on agentsform.ai (S3 + CloudFront, AWS)
      │
      │  fills form on /before-you-hire, /talk, or homepage
      │  HTML form POST (no JS, no CORS preflight)
      ▼
  https://api.agentsform.ai/api/agentsform-lead
      │  Cloudflare DNS → CNAME → tunnel UUID
      │  Cloudflare Tunnel → Mac mini
      ▼
  gombwe daemon (src/gateway.ts)
      │
      ├─ rate-limit (5 per IP per minute)
      ├─ honeypot check (_gotcha field empty)
      ├─ validate (name + phone or email)
      ├─ append → ~/.claude-gombwe/data/leads.jsonl
      ├─ notify() → Discord channel
      └─ HTTP 302 → https://agentsform.ai/thanks.html
```

## One-time setup

### 1. Cloudflare DNS record

In the Cloudflare dashboard for the `agentsform.ai` zone, add a CNAME:

| Type  | Name | Target                                          | Proxy   |
|-------|------|-------------------------------------------------|---------|
| CNAME | api  | `2630b446-cf1e-4a99-93e5-add048043e48.cfargotunnel.com` | Proxied |

The tunnel UUID is the same one already used for `dashboard.gombwe.com`
(read from `/etc/cloudflared/config.yml`).

### 2. Cloudflare Tunnel ingress rule

Add to `/etc/cloudflared/config.yml` BEFORE the catch-all `service: http_status:404`:

```yaml
  # Agentsform lead form receiver — public POST endpoint, no Access policy
  - hostname: api.agentsform.ai
    service: http://localhost:18790
```

Then restart cloudflared:

```
sudo launchctl kickstart -k system/com.cloudflare.cloudflared
```

### 3. NO Cloudflare Access policy on this hostname

Form submitters are anonymous visitors — they can't authenticate. Make
sure `api.agentsform.ai` is **NOT** behind any Access application in
the Cloudflare Zero Trust dashboard. (`dashboard.gombwe.com` is — leave
that one alone.)

### 4. Rebuild + restart gombwe daemon

Endpoint is in `src/gateway.ts`. After pulling the new code:

```
cd ~/code/claude-gombwe
npm run build
# restart the daemon — whichever way you start it (launchd, manual, etc.)
```

### 5. Verify

```
curl -i -X POST https://api.agentsform.ai/api/agentsform-lead \
  -d "name=Test" \
  -d "phone=0400000000" \
  -d "message=test from setup verification" \
  -d "source=verify"
```

Expected:
- HTTP 302 with `Location: https://agentsform.ai/thanks.html`
- New row in `~/.claude-gombwe/data/leads.jsonl`
- Discord notification fires

## Receiving leads

Leads land in two places automatically:

1. **`~/.claude-gombwe/data/leads.jsonl`** — durable append-only log.
   One JSON line per submission with timestamp, IP, name, phone, email,
   preferred call time, message, source page, user-agent, referer.

2. **Discord** — `notify()` posts to the configured channel(s). Message
   format:
   ```
   **New lead from agentsform.ai** (before-you-hire)
   Name: Sarah K
   Phone: 0412 345 678
   Preferred time: tomorrow-morning
   Message: looking to replace office admin role
   _(203.0.113.45)_
   ```

Quick query helpers:

```
# All leads today
grep $(date -u +%Y-%m-%d) ~/.claude-gombwe/data/leads.jsonl | jq .

# Lead count per source
jq -r .source ~/.claude-gombwe/data/leads.jsonl | sort | uniq -c

# Leads with phone but no callback yet (manual — there's no callback-tracking)
cat ~/.claude-gombwe/data/leads.jsonl | jq -r 'select(.phone != "") | [.ts, .name, .phone, .preferred_time] | @tsv'
```

## Rate-limit + abuse handling

- **5 submissions per IP per minute** (in-memory, resets on restart).
  Excess returns HTTP 429.
- **Honeypot field `_gotcha`** — hidden CSS, normal users never fill it.
  Bots typically do. Honeypot-tripped submissions get a 302 to /thanks
  (so the bot doesn't know it was caught) but discard the data.
- **Body size limit 64 KB** (Express `urlencoded` middleware).
- **No CAPTCHA** — adding one would tank conversion. Revisit if spam
  becomes meaningful.

## Forms on which pages

| Page                           | Form action                                  | Source value      |
|--------------------------------|----------------------------------------------|-------------------|
| `/` (homepage contact section) | `https://api.agentsform.ai/api/agentsform-lead` | `homepage`        |
| `/before-you-hire.html`        | same                                         | `before-you-hire` |
| `/talk.html`                   | same                                         | `talk`            |

Source value is captured in `leads.jsonl` so you can see which page is
converting.

## Deploy notes

### Static (agentsform.ai)
After editing any HTML/CSS in `site/agentsformation/`:

```
aws s3 cp site/agentsformation/before-you-hire.html s3://www.agentsform.ai/
aws s3 cp site/agentsformation/talk.html s3://www.agentsform.ai/
aws s3 cp site/agentsformation/thanks.html s3://www.agentsform.ai/
aws s3 cp site/agentsformation/index.html s3://www.agentsform.ai/
aws s3 cp site/agentsformation/style.css s3://www.agentsform.ai/
aws s3 cp site/agentsformation/sitemap.xml s3://www.agentsform.ai/
aws cloudfront create-invalidation --distribution-id <YOUR_DIST_ID> --paths "/*"
```

**Do NOT** use `aws s3 sync --delete` against `www.agentsform.ai` — the
bucket also serves a Next.js app at subpaths (see `README.md`).

### Mac mini
```
cd ~/code/claude-gombwe
git pull
npm run build
# restart daemon
```
