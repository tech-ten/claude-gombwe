# Grocery cron — daily watch + alert + weekly meal plan

## What runs when

| Job | Schedule | Script | Purpose |
|---|---|---|---|
| **Price watch** | Daily 06:00 | `node scripts/grocery-watch.mjs` | Polls Woolworths + Coles for every watchlist item, appends to `~/.claude-gombwe/data/grocery-prices.jsonl`, writes `~/.claude-gombwe/data/grocery-deals-latest.json` |
| **Deal alert** | Daily 06:15 | `node scripts/grocery-alert.mjs` | Reads the snapshot; if anything is rock-bottom, fans out via gombwe channels (Discord/Telegram) + SMS (Twilio) + WhatsApp (Cloud API) when credentials are configured |
| **Meal plan** | Sunday 17:00 | `node scripts/meal-plan.mjs` | Generates 7-day dinner plan honouring dietary constraints + budget |

## One-time crontab install (macOS)

Open your crontab:
```
crontab -e
```

Paste these three lines (adjust the absolute path if your repo lives elsewhere):

```
0 6 * * * cd /Users/tendaimudavanhu/code/claude-gombwe && /opt/homebrew/bin/node scripts/grocery-watch.mjs >> ~/.claude-gombwe/data/grocery-cron.log 2>&1
15 6 * * * cd /Users/tendaimudavanhu/code/claude-gombwe && /opt/homebrew/bin/node scripts/grocery-alert.mjs >> ~/.claude-gombwe/data/grocery-cron.log 2>&1
0 17 * * 0 cd /Users/tendaimudavanhu/code/claude-gombwe && /opt/homebrew/bin/node scripts/meal-plan.mjs >> ~/.claude-gombwe/data/grocery-cron.log 2>&1
```

Verify it took:
```
crontab -l
```

Watch the log live (when next firing):
```
tail -f ~/.claude-gombwe/data/grocery-cron.log
```

## Important: macOS Full Disk Access

`cron` jobs run under a sandbox by default and can't reach `~/.claude-gombwe/`
on modern macOS without explicit Full Disk Access for `/usr/sbin/cron`.

Settings → Privacy & Security → Full Disk Access → add `/usr/sbin/cron`.

If you skip this, the cron will run but fail silently when trying to read/write
under `~/.claude-gombwe/`.

## Notification setup (SMS + WhatsApp)

To enable phone alerts:

1. Copy the template:
   ```
   cp ~/.claude-gombwe/notify-config.example.json ~/.claude-gombwe/notify-config.json
   ```

2. **Twilio SMS** — sign up at twilio.com, copy Account SID + Auth Token + a
   purchased AU number into the `twilio` block. Free trial gives ~$15 credit.

3. **WhatsApp Cloud API** — sign up for Meta Business at
   developers.facebook.com, create a WhatsApp Business app, copy the permanent
   access token + phone number ID into the `whatsapp` block.

Until you do either step, the alerter still pushes through gombwe's existing
channels (Discord, Telegram, web dashboard) — and prints "would send to X via
Y" for the missing transports.

## Manual operation (no cron)

You can run any of these by hand at any time:

```bash
# Poll prices + classify + write snapshot
node scripts/grocery-watch.mjs

# Don't poll — just show the latest snapshot
node scripts/grocery-watch.mjs --deals

# JSON output (for scripts)
node scripts/grocery-watch.mjs --json

# Send alert based on the latest snapshot (test transports)
node scripts/grocery-alert.mjs --dry-run

# Generate 7-day meal plan from current watchlist + pantry + deals
node scripts/meal-plan.mjs --dry-run
```
