# Grocery Data Pipeline

This is the internal architecture doc for how gombwe scrapes, classifies,
and persists Coles + Woolworths product data. User-facing setup lives
in [GROCERY.md](GROCERY.md).

## Why this exists

Two purposes:

1. **Family shopping.** Watchlist items get priced daily, the cheapest
   reliable match per store is recorded, deals get surfaced.
2. **Dataset asset.** Coles + Woolworths are an Australian duopoly with
   no public price-transparency dataset. Every scraped candidate is
   persisted — not just the watchlist picks — so the catalog and time
   series compound into a uniquely valuable asset over time.

## Pipeline

```
  Watchlist item
       │
       ▼
  ┌──────────────────────────┐
  │ Per-store search         │  scripts/grocery-lib.mjs
  │  - Woolies internal API  │  woolworthsSearch / colesSearch
  │  - Coles cached API,     │  + grocery-api-cache.mjs
  │    sniff, or DOM         │
  └──────────────────────────┘
       │ all candidates
       ▼
  ┌──────────────────────────┐
  │ Observation collector    │  scripts/grocery-products.mjs
  │  - dedupe within run     │  newObservationCollector()
  │  - all fields → JSONL    │     → grocery-product-prices.jsonl
  │  - catalog upsert        │     → grocery-products.json
  └──────────────────────────┘
       │
       ▼
  ┌──────────────────────────┐
  │ Regex pre-filter         │  scripts/grocery-lib.mjs
  │  - name overlap          │  productMatchesDetailed
  │  - processed-variant     │
  │  - perKg / each          │
  │  - requires (optional)   │
  └──────────────────────────┘
       │ accepted shortlist
       ▼
  ┌──────────────────────────┐
  │ Resolution cache         │  scripts/grocery-resolutions.mjs
  │  - product_id match?     │  resolveBestMatch
  │  - yes → use cached pick │     → grocery-resolutions.json
  │  - no  → call Haiku      │
  └──────────────────────────┘
       │ classifier call only on cache miss
       ▼
  ┌──────────────────────────┐
  │ Haiku classifier         │  scripts/grocery-classifier.mjs
  │  - rank + cap at 20      │  classifyMatch
  │  - prompt: right product │
  │    first, best $/unit    │
  │  - fallback: cheapest    │
  │    of shortlist          │
  └──────────────────────────┘
       │
       ▼
  Picked product → grocery-prices.jsonl (curated)
                 → grocery-deals-latest.json (snapshot)
```

PDP enrichment runs separately as a slow background backfill:

```
  Catalog product (no pdp_enriched_at OR stale)
       │
       ▼
  scripts/grocery-pdp-enrich.mjs
   - Navigate to product detail page
   - Extract JSON-LD (schema.org/Product)
   - Extract DOM backstops (description, ingredients, nutrition)
   - 4-12s jittered delay between PDPs
       │
       ▼
  grocery-product-details.jsonl   (append-only)
  grocery-products.json           (latest_pdp_* fields)
```

## Data files

All in `~/.claude-gombwe/data/`. Mode 0600.

| File | Type | Purpose | Grows? |
|------|------|---------|--------|
| `grocery-watchlist.json` | hand-edited | Items to track (name, ceiling, search terms) | flat |
| `grocery-prices.jsonl` | append-only | One record per watchlist item per scrape — curated pick | ~80/day |
| `grocery-deals-latest.json` | snapshot | Current best-deal report for watchlist | rewritten |
| `grocery-resolutions.json` | snapshot | Cached Haiku pick per (item, store) | ~160 entries max |
| `grocery-products.json` | snapshot | Full product catalog — every product ever observed | grows to thousands |
| `grocery-product-prices.jsonl` | append-only | Price time series — every candidate every scrape | ~1500-2000/day |
| `grocery-product-details.jsonl` | append-only | PDP enrichment log (one per fetch) | governed by enrich runs |
| `grocery-aliases.json` | derived | Lookup: watchlist item ↔ retailer product names | regenerated |
| `grocery-calibration-latest.json` | snapshot | Last calibration audit | rewritten |
| `grocery-coles-api.json` | snapshot | Cached Coles search-API URL patterns | tiny |

Backup the whole `~/.claude-gombwe/data/` directory regularly — most of
the value is in the append-only JSONL files.

## Scripts

| Script | What it does | When to run |
|--------|-------------|-------------|
| `grocery-watch.mjs` | Scrape watchlist + record curated picks + catalog | Daily cron |
| `grocery-watch.mjs --deals` | No scraping; report deals from latest prices | On demand |
| `grocery-watch.mjs --force-reclassify` | Bypass resolution cache, re-run Haiku | After watchlist edits |
| `grocery-calibrate.mjs` | Audit run: shows what got accepted/rejected with reasons | Auto every 48h; manual on demand |
| `grocery-calibrate.mjs --items=a,b` | Calibrate specific items only | Targeted iteration |
| `grocery-pdp-enrich.mjs` | Backfill catalog with PDP data (default 20 products) | Daily cron, low rate |
| `grocery-pdp-enrich.mjs --limit 50 --store=coles` | Larger or single-store batch | Catch-up runs |
| `grocery-aliases.mjs` | Generate lookup table from historical observations | Ad-hoc audit |
| `coles-probe.mjs` | Diagnostic — what Coles search returns for given queries | When scraper looks wrong |

## Anti-detection / longevity

The dataset has value only if scraping keeps working. Defensive measures
already in place:

- **Jittered delays.** `jitter(200, 700)` between search terms,
  `jitter(800, 2500)` between watchlist items, `jitter(4000, 12000)`
  between PDP fetches. Defeats fixed-interval bot detection.
- **API endpoint cache.** `grocery-api-cache.mjs` stores known-working
  Coles search URL patterns so we skip the loud network-sniff discovery
  on most runs.
- **Logged-in browsing context.** Uses the user's authenticated Chrome
  profile so requests look like a real shopper.
- **Hard caps per run.** PDP enrichment defaults to 20 products per run
  so a single session never looks like a crawl.

Defensive measures still on the table (not implemented):

- Spread the daily watch into 3-4 smaller batches across the day instead
  of one morning hit (cron schedule change, no code).
- Off-Mac-mini backup to S3/Backblaze (the dataset is the asset; if the
  account or IP gets banned, raw data survives).
- Stealth puppeteer plugin (defeats common bot fingerprinting).
- Residential AU proxy rotation (~$50-100/mo) — different IP per
  session.
- Off-account scraping (no logged-in session) as legal hedge if the
  dataset goes public/commercial.

## Adding fields to the dataset

The scrapers in `grocery-lib.mjs` are aggressive about field extraction
— they pull ~25-30 named fields plus a full `_raw` blob of the raw API
or DOM object. To make a new field queryable in the catalog:

1. Confirm the scraper emits it (add to `woolworthsSearch` /
   `colesSearch` if not).
2. Add the field name to `TRACKED_FIELDS` in `grocery-products.mjs`.
3. New records will pick it up; old records keep the `_raw` blob so
   you can backfill.

## Reading the time series

```bash
# All observations for one product
grep '"product_id":"5398753"' ~/.claude-gombwe/data/grocery-product-prices.jsonl

# All special offers (current day)
python3 -c "
import json
with open('~/.claude-gombwe/data/grocery-products.json'.replace('~', '/Users/...'')) as f:
  c = json.load(f)
for k, v in c['products'].items():
  if v.get('latest_is_on_special'):
    print(f'{v[\"latest_name\"]} {v[\"latest_price\"]} (was {v.get(\"latest_was_price\")})')"

# Count products per store
jq '.stats' ~/.claude-gombwe/data/grocery-products.json
```
