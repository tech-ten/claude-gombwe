# Cloudflare setup for gombwe.com

> Written for beginners. If you've never used Cloudflare before, this is a complete
> walkthrough. If you have, skip to **Reference** at the bottom for the cheat sheet.
>
> Captures the setup as built on 2026-05-24, with all the gotchas we hit.

---

## What this gives you

After following this guide, you'll have:

1. **gombwe.com** — your public landing page, hosted free by Cloudflare. Updates auto-deploy from git on every push.
2. **dashboard.gombwe.com** — your gombwe dashboard, running on the Mac mini in your house, reachable from anywhere on the internet, with a sign-in gate so only people you've allowed can use it.
3. **All of it survives reboots and runs without you babysitting anything.**

Total ongoing cost: **$0/month** as long as you stay within free tiers (which a personal/family setup easily does).

---

## Concepts you need before starting

A few terms get thrown around constantly. If you're new to this, skim these:

- **DNS** — the address book of the internet. When you type `gombwe.com`, DNS translates that to an IP address (a number) your browser can connect to. Cloudflare hosts the DNS records for our domain.
- **Nameservers** — the *authoritative* servers that hold DNS records for a domain. You tell them at the **registrar** (where you bought the domain, e.g., AWS Route 53). Cloudflare becomes your nameserver provider.
- **Registrar** — where you bought/own the domain. We use AWS Route 53 (separate from "Route 53 hosted zones," which is the DNS-hosting feature). The registrar holds the domain registration; the nameservers hold the actual records.
- **Tunnel** — a persistent connection your server (Mac mini) opens outward to Cloudflare. Lets traffic flow back through it without your home network needing a public IP or port forwarding. Used by `dashboard.gombwe.com`.
- **Cloudflare Pages** — Cloudflare's static site hosting. Connects to a git repo; redeploys on every push. Used by `gombwe.com` landing page.
- **Cloudflare Access** — the sign-in gate. Sits in front of any application; only people whose emails are on your allow-list can get past it.
- **Zero Trust** — Cloudflare's umbrella name for their security products, including Access. Required to use Access.

---

## Prerequisites

- A **Cloudflare account** (sign up free at https://dash.cloudflare.com)
- A **domain you own** (e.g., gombwe.com — we registered ours through AWS Route 53 but any registrar works)
- An **always-on Mac** (Mac mini for us) with gombwe running on port 18790
- **Homebrew** installed on the Mac (https://brew.sh) for installing cloudflared
- A **credit card** — required for Cloudflare Zero Trust account even on free tier (fraud prevention; you're not charged unless you exceed free limits)
- **AWS CLI access** (only if your domain is on AWS Route 53 like ours — for nameserver swap)

---

## Part 1 — Move DNS to Cloudflare (10 min, brief downtime if site has live content)

Why: Cloudflare Tunnel and Cloudflare Pages both need Cloudflare to be your DNS provider. Your domain stays *registered* with whoever you bought it from; only the *nameservers* change.

### 1.1 Sign up for Cloudflare

Sign up at https://dash.cloudflare.com using an email you actually check (you'll get security alerts here). Don't use a burner address — losing access to this account would be painful.

### 1.2 Add your domain

In the Cloudflare dashboard:

1. Click **"Add a site"** (you may need to look in **Connect → Websites** in the sidebar; Cloudflare reshuffles nav often)
2. Enter your domain, e.g., `gombwe.com`
3. Choose **Free plan**
4. Cloudflare scans your existing DNS records and imports them. **Review them** — if anything looks wrong, you can fix later.

### 1.3 ⚠️ Gotcha — site currently hosted somewhere?

If your domain currently serves a website (e.g., S3 + CloudFront), the import scan will pick up the CURRENT IP addresses. Two problems:

- If it imports those as **A records (Proxied)**, you have a "double CDN" situation (CF in front of CloudFront) — usually broken
- The IPs will go stale (CloudFront rotates them constantly)

If you're keeping the AWS-hosted site for now, you need a CNAME pointing at the CloudFront distribution domain (not the IPs), set to **DNS-only** (gray cloud, not proxied). See `docs/network.md` if you want the longer rationale.

**For our case:** we deleted the imported A records and instead moved the site to Cloudflare Pages (covered in Part 2). The apex was left empty during the migration.

### 1.4 Get the Cloudflare nameservers

Cloudflare shows you **two nameservers** like `journey.ns.cloudflare.com` and `stanley.ns.cloudflare.com`. **Copy both.** They're randomly assigned per account; yours will differ.

### 1.5 Swap nameservers at the registrar

This is the bit where the *world* starts using Cloudflare DNS instead of your old provider.

For **AWS Route 53** (where ours was):
- AWS Console → Route 53 → **Registered domains** (not "Hosted zones")
- Click your domain → **Add or edit name servers**
- Replace the 4 AWS `ns-*.awsdns-*` nameservers with the 2 Cloudflare ones
- Save

For other registrars (GoDaddy, Namecheap, etc.) the menu path differs but the action is the same: replace the existing nameservers with the Cloudflare pair.

**If you have AWS CLI access**, here's the one-liner (uses `gombwe.com` as example):

```bash
aws route53domains update-domain-nameservers \
  --domain-name gombwe.com \
  --nameservers Name=journey.ns.cloudflare.com Name=stanley.ns.cloudflare.com \
  --region us-east-1
```

### 1.6 Wait for propagation

DNS changes take **5 minutes to a few hours** to propagate worldwide. Usually under 30 minutes. Cloudflare polls automatically and emails you "is now active on Cloudflare" when ready.

You can check manually:

```bash
dig +short NS gombwe.com @1.1.1.1
```

When that returns the Cloudflare nameservers, you're done with Part 1.

---

## Part 2 — Landing page on Cloudflare Pages (15 min)

Why: serves your static landing page (HTML/CSS/JS) from Cloudflare's CDN worldwide. Auto-deploys from git. Free.

### 2.1 Set up your repo layout

Cloudflare Pages serves whatever's in a chosen folder of your git repo. For gombwe.com, our files live in `site/gombwe/` (we split the site folder so the gombwe and agents-formation landing pages don't collide).

If your landing page is in the root or `public/` or `dist/`, the same instructions apply — just adjust the "Build output directory" later.

### 2.2 Create the Pages project

In Cloudflare:

1. Sidebar → **Workers & Pages** (might be under "Compute" or top-level depending on nav version)
2. Click **Create application** → **Pages** tab → **Connect to Git**
3. Authorize Cloudflare's GitHub access (one-time OAuth)
4. Select the `claude-gombwe` repo → **Begin setup**

### 2.3 Configure build

- **Project name:** `gombwe` (becomes `gombwe.pages.dev` auto-URL)
- **Production branch:** `main`
- **Framework preset:** `None` (it's plain HTML)
- **Build command:** *leave empty*
- **Build output directory:** `site/gombwe` ⚠️ **No trailing slash, no leading slash.** A trailing dot (`site/gombwe.`) breaks the build with "directory not found."
- **Root directory:** *leave default*

Click **Save and Deploy**. First build takes ~30 seconds.

### 2.4 Attach the custom domain

Once the first deploy is green:

1. In the Pages project, click **Custom domains** tab
2. **Set up a custom domain** → enter `gombwe.com` → **Continue** → **Activate domain**
3. Repeat for `www.gombwe.com`

Cloudflare auto-creates the DNS records (CNAME-flattened) and provisions SSL. Takes ~60 seconds.

### 2.5 ⚠️ Gotcha — "Active" status

The Custom Domains flow has multiple steps. **Make sure you click all the way through to "Activate domain"** — easy to miss the last button and end up with the domain showing as "Pending" forever (which means no DNS record gets created and your site stays unreachable at `gombwe.com`).

Verify:

```bash
dig +short A gombwe.com @1.1.1.1
curl -sI https://gombwe.com
```

If you see Cloudflare IPs (`172.x.x.x` range) and an HTTP 200, you're done.

---

## Part 3 — Dashboard remote access via Cloudflare Tunnel (15 min)

Why: makes your local gombwe dashboard reachable from anywhere without port-forwarding or a public IP. The Mac mini opens a persistent outbound connection to Cloudflare; visitors connect to Cloudflare, Cloudflare forwards them down the tunnel.

### 3.1 Install cloudflared

On the Mac mini:

```bash
brew install cloudflared
```

### 3.2 Authenticate cloudflared to your Cloudflare account

```bash
cloudflared tunnel login
```

This:
1. Prints a URL to the terminal
2. Opens that URL in your browser
3. Asks you to pick which domain to authorise (pick `gombwe.com`)
4. Downloads a cert to `~/.cloudflared/cert.pem`

### 3.3 Create the tunnel

```bash
cloudflared tunnel create mac-mini
```

Note: we named ours `mac-mini` rather than `dashboard` because one tunnel can route many hostnames to different services on the same machine. Future you might add `whatsapp-webhook.gombwe.com`, `friend1.gombwe.com`, etc. — all routed by the same tunnel.

This prints:
- A **tunnel ID** (UUID, e.g., `2630b446-cf1e-4a99-93e5-add048043e48`)
- A **credentials file** path (`~/.cloudflared/<uuid>.json`) — **treat this as a password**

### 3.4 Write the tunnel config

Create `~/.cloudflared/config.yml` with your tunnel ID and the routes you want:

```yaml
tunnel: 2630b446-cf1e-4a99-93e5-add048043e48
credentials-file: /Users/tendaimudavanhu/.cloudflared/2630b446-cf1e-4a99-93e5-add048043e48.json

ingress:
  - hostname: dashboard.gombwe.com
    service: http://localhost:18790

  - service: http_status:404
```

Replace the UUID with yours, and the username in the path with yours.

The `ingress` rules are matched **in order**. The final `http_status:404` is a required catch-all — cloudflared refuses to start without it.

### 3.5 Route DNS to the tunnel

This creates a DNS record in Cloudflare pointing the hostname at your tunnel:

```bash
cloudflared tunnel route dns mac-mini dashboard.gombwe.com
```

You should see `INF Added CNAME dashboard.gombwe.com which will route to this tunnel`.

### 3.6 Test the tunnel (foreground)

```bash
cloudflared tunnel run mac-mini
```

This runs the tunnel in your terminal (logs streaming). You'll see 4 lines starting `Registered tunnel connection` (cloudflared opens 4 redundant connections to nearby Cloudflare data centers).

**Test:** open `https://dashboard.gombwe.com` in your browser. Your gombwe dashboard should load (the same one you see locally at `192.168.88.245:18790`).

**⚠️ At this point there is NO authentication on the URL — anyone on the internet who guesses it can see your dashboard.** Don't share the URL yet. Part 4 fixes this.

Ctrl+C to stop the foreground tunnel when you're ready to move on.

---

## Part 4 — Sign-in gate via Cloudflare Access (15 min)

Why: puts a Cloudflare-hosted sign-in page in front of `dashboard.gombwe.com`. Only emails on your allow-list can reach the dashboard. Cloudflare handles auth at their edge; no auth code in your app.

### 4.1 Set up Zero Trust

1. In the Cloudflare dashboard sidebar, click **Zero Trust** (may be under "Protect & Connect" group)
2. First time, Cloudflare asks for:
   - **Team name** — becomes part of every Access URL (`<team>.cloudflareaccess.com`). Globally unique. Pick something stable like your domain or last name. Visible to users.
   - **Free plan** — pick this
3. **Payment method required** even for free tier (Cloudflare uses it for fraud prevention; you're not charged unless you exceed 50 users on Access)
4. After payment, you get a Zero Trust onboarding wizard. Pick **"Set up secure access to private apps from any browser"** → **"Connect a private web application"**.

### 4.2 ⚠️ Gotcha — skip the wizard, use direct path

The wizard wants to ALSO create a tunnel + DNS record, which would conflict with what we already set up in Part 3. **Back out of the wizard**.

Instead navigate directly: **Access → Applications → Add an application → Self-hosted → Public DNS**.

### 4.3 Configure the application

You'll see a form with several sections.

**Application details:**
- Application name: `Gombwe Dashboard`
- Session duration: `24 hours` (how often users have to re-sign-in)

**Destinations → Public hostnames:**
- Subdomain: `dashboard`
- Domain: select `gombwe.com` from dropdown
- Path: leave empty

**Browser rendering:** leave **Off** (only relevant for RDP/SSH/VNC apps)

**Access policies → Create new policy:**
- Policy name: `Allowed users`
- Action: `Allow`
- **Include rule:** Selector = `Emails`, Value = your email (e.g., `tech.tendai@gmail.com`)
- If allowing multiple people, click `+ Add include (OR)` and add each as a separate rule, OR put multiple emails in the same Value field (tag-style)
- Save policy

**Identity providers:**
- "Accept all available identity providers" should be **ON**
- This includes **One-time PIN** (OTP) by default — sends a 6-digit code to the user's email
- You can add Google/Apple/Microsoft OAuth later for slicker UX (requires extra setup in Google Cloud Console / Apple Developer)

Click **Create / Save Application**.

### 4.4 Verify the gate is up

```bash
curl -sI https://dashboard.gombwe.com
```

Should return:
- HTTP 302 redirect to `<team>.cloudflareaccess.com/cdn-cgi/access/login/...`
- NOT your gombwe dashboard

Now test the human side. **From your phone on cellular** (off-LAN, proves remote access):
1. Open `https://dashboard.gombwe.com`
2. Cloudflare sign-in page appears
3. Enter your email
4. 6-digit code arrives in Gmail
5. Paste code → dashboard loads

---

## Part 5 — Make the tunnel survive reboots ⚠️ (the gotcha-heavy part)

So far the tunnel is running in your terminal. If you close the terminal or reboot the Mac, the tunnel dies and `dashboard.gombwe.com` returns Error 1033.

The fix: install cloudflared as a **launchd service** so macOS runs it as a system daemon that restarts on boot and restarts itself if it crashes.

### 5.1 Try the official install first (it'll be broken, but try)

```bash
sudo cloudflared --config /Users/tendaimudavanhu/.cloudflared/config.yml service install
```

This creates `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist`.

### 5.2 ⚠️ MAJOR GOTCHA — the install creates a broken plist

As of cloudflared **2026.5.0**, `service install` creates a plist with **no arguments** — just the binary path, no `--config`, no `tunnel run`. This means the service starts, has no idea what to do, and silently does nothing. `dashboard.gombwe.com` returns Error 1033.

Verify yours is broken:

```bash
sudo cat /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
```

If `ProgramArguments` shows just `<string>/opt/homebrew/bin/cloudflared</string>` with no other strings, it's broken.

### 5.3 Fix it — copy config to system location

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/config.yml /etc/cloudflared/
sudo cp ~/.cloudflared/<your-tunnel-uuid>.json /etc/cloudflared/
sudo sed -i '' 's|/Users/<your-username>/.cloudflared/|/etc/cloudflared/|g' /etc/cloudflared/config.yml
```

This puts the config + credentials in the system-wide location AND updates the `credentials-file` path inside the config to point at the new location.

### 5.4 Replace the broken plist

Create `/tmp/cloudflared.plist` with the correct content:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
    <dict>
        <key>Label</key>
        <string>com.cloudflare.cloudflared</string>
        <key>ProgramArguments</key>
        <array>
            <string>/opt/homebrew/bin/cloudflared</string>
            <string>--no-autoupdate</string>
            <string>--config</string>
            <string>/etc/cloudflared/config.yml</string>
            <string>tunnel</string>
            <string>run</string>
        </array>
        <key>RunAtLoad</key>
        <true/>
        <key>StandardOutPath</key>
        <string>/Library/Logs/com.cloudflare.cloudflared.out.log</string>
        <key>StandardErrorPath</key>
        <string>/Library/Logs/com.cloudflare.cloudflared.err.log</string>
        <key>KeepAlive</key>
        <dict>
            <key>SuccessfulExit</key>
            <false/>
        </dict>
        <key>ThrottleInterval</key>
        <integer>5</integer>
    </dict>
</plist>
```

Then replace the broken plist and reload the service:

```bash
sudo cp /tmp/cloudflared.plist /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
sudo launchctl bootout system /Library/LaunchDaemons/com.cloudflare.cloudflared.plist 2>/dev/null
sudo launchctl bootstrap system /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
```

### 5.5 Verify

```bash
ps aux | grep '[c]loudflared'
```

You should see ONE process owned by **root** with args like:
```
/opt/homebrew/bin/cloudflared --no-autoupdate --config /etc/cloudflared/config.yml tunnel run
```

If you see a `tendaimudavanhu`-owned process too, that's your old foreground tunnel — kill it:

```bash
ps aux | grep '[c]loudflared tunnel'  # find PID of the user-owned one
kill -9 <pid>
```

Then verify the tunnel still serves:

```bash
cloudflared tunnel info mac-mini
```

Should show an active connector (the root service). And:

```bash
curl -sI https://dashboard.gombwe.com
```

Should still return the HTTP 302 Access redirect.

### 5.6 Reboot to verify persistence

```bash
sudo shutdown -r now
```

After the Mac comes back up (~1 min), without you doing anything:

```bash
curl -sI https://dashboard.gombwe.com
```

Should return HTTP 302. If yes, persistence works.

---

## Reference — what's where

### Cloudflare resources

| What | Where |
|---|---|
| Domain registration | AWS Route 53 (unchanged from before migration) |
| DNS records | Cloudflare DNS (nameservers `journey.ns.cloudflare.com` + `stanley.ns.cloudflare.com`) |
| Landing page | Cloudflare Pages project `gombwe` — auto-deploys from `claude-gombwe` repo `site/gombwe/` |
| Tunnel | `mac-mini` (UUID `2630b446-cf1e-4a99-93e5-add048043e48`) |
| Zero Trust team | `gombwe.cloudflareaccess.com` |
| Access app | `Gombwe Dashboard` protecting `dashboard.gombwe.com` |
| Allowed users | `tech.tendai@gmail.com` + wife's email |
| IdP | One-time PIN (via email) |

### Files on the Mac mini

| Path | Purpose |
|---|---|
| `/etc/cloudflared/config.yml` | Tunnel routes (read by the launchd service) |
| `/etc/cloudflared/<uuid>.json` | Tunnel credentials |
| `~/.cloudflared/cert.pem` | Origin cert (lets cloudflared CRUD tunnels on this account) |
| `~/.cloudflared/config.yml` | Original config (only used for ad-hoc foreground runs; service uses `/etc/cloudflared/`) |
| `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist` | launchd service definition |
| `/Library/Logs/com.cloudflare.cloudflared.out.log` | Service stdout |
| `/Library/Logs/com.cloudflare.cloudflared.err.log` | Service stderr |

### One-shot health check

```bash
ps aux | grep '[c]loudflared'                # service running?
cloudflared tunnel info mac-mini             # tunnel active?
curl -sI https://dashboard.gombwe.com        # tunnel + Access alive?
curl -sI https://gombwe.com                  # Pages alive?
dig +short NS gombwe.com @1.1.1.1            # nameservers correct?
```

All four should return reassuring data.

---

## Troubleshooting

### Error 1033 ("Cloudflare Tunnel error") on dashboard.gombwe.com

The tunnel is down or unreachable. Either:

- The launchd service died or wasn't installed correctly (see Part 5.2 gotcha)
- The Mac mini lost internet / cloudflared can't reach Cloudflare's edge
- Your config.yml has a bad ingress rule

Diagnose:

```bash
ps aux | grep '[c]loudflared'                # is anything running?
cloudflared tunnel info mac-mini             # are there active connections?
tail /Library/Logs/com.cloudflare.cloudflared.err.log
```

Quick fix while you debug: run the foreground tunnel manually so you can sign in:

```bash
cloudflared tunnel run mac-mini
```

### gombwe.com returns "Site not found" or 522

- Did you Activate the custom domain in Pages? (Part 2.5 gotcha)
- Did nameservers propagate? `dig +short NS gombwe.com @1.1.1.1` should show Cloudflare's nameservers
- Did the Pages build succeed? Check the Deployments tab in the Pages project

### Email never arrives for OTP sign-in

- Check spam folder (`@cloudflare.com` sender)
- Verify the email is exactly on the Access policy allow-list (case sensitive for some providers)
- Cloudflare → Zero Trust → Logs → Access → look for a failed login attempt

### I added a new subdomain — what do I do?

Edit `/etc/cloudflared/config.yml` to add a new ingress rule **above** the `http_status:404` catch-all:

```yaml
ingress:
  - hostname: dashboard.gombwe.com
    service: http://localhost:18790
  - hostname: newthing.gombwe.com         # ← new
    service: http://localhost:18791       # ← new
  - service: http_status:404
```

Then:

```bash
sudo cloudflared tunnel route dns mac-mini newthing.gombwe.com
sudo launchctl bootout system /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
```

If the new subdomain should also be gated by Access, add a new Application in the Zero Trust dashboard (Part 4) with the new hostname.

### Cloudflare's UI moved and I can't find anything

Cloudflare reshuffles their nav every few months. Universal fallbacks:

- **"Add a site"** → URL `https://dash.cloudflare.com/?to=/:account/add-site`
- **"Workers & Pages"** → `https://dash.cloudflare.com/?to=/:account/workers-and-pages`
- **Account home** → click your account/profile name top-right

### I want to undo everything and go back to AWS

Reversible:

- **Nameservers:** at AWS Route 53 Registered Domains, replace Cloudflare nameservers with the 4 AWS ones. DNS reverts to Route 53.
- **Tunnel:** `cloudflared tunnel delete mac-mini` (after stopping service). Also remove the tunnel's DNS record in Cloudflare.
- **Access app:** delete from Zero Trust dashboard.
- **Pages project:** delete from Workers & Pages.

The AWS S3 bucket + CloudFront distribution for `gombwe.com` were left in place after our migration (as a safety net) — they'd start serving again as soon as DNS points back. After a few weeks of confidence in the Cloudflare setup, you can retire them.
