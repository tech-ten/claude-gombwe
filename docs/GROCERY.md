# Grocery Automation — Woolworths & Coles

Search products, compare prices across both stores, and add items to your cart — all from Discord, the terminal, or on a weekly schedule. Your login is saved so you only authenticate once.

---

## Prerequisites

- **Google Chrome** installed on your Mac
- A **Woolworths** online shopping account (woolworths.com.au)
- A **Coles** online shopping account (coles.com.au)
- **gombwe** installed (`npm install -g claude-gombwe`)

---

## Step 1: First-Time Setup

This saves your Woolworths and Coles login so you never have to do it again.

### 1.1 Run the setup command

Open your terminal and run:

```bash
gombwe grocery-setup
```

You will see:

```
  ┌─────────────────────────────────────────┐
  │                                         │
  │   Grocery Setup                         │
  │   One-time login for Woolworths & Coles │
  │                                         │
  └─────────────────────────────────────────┘

  Created browser profile at ~/.claude-gombwe/chrome-profile
  Launching Chrome...

  Two tabs have opened:
    1. Woolworths login
    2. Coles login

  Log in to both stores. Your session will be saved
  in ~/.claude-gombwe/chrome-profile so you won't
  need to log in again.

  When you're done, come back here and press Enter.
```

### 1.2 Log in to Woolworths

A Chrome window opens with two tabs. The first tab shows the Woolworths login page.

1. Enter your Woolworths email address
2. Enter your password
3. Complete any verification (SMS code, etc.)
4. You should see "Hi, [Your Name]" in the top right — you're logged in

### 1.3 Log in to Coles

Click the second tab in Chrome. It shows the Coles login page.

1. Enter your Coles email address
2. Enter your password
3. Complete any verification
4. You should see your account name — you're logged in

### 1.4 Confirm setup

Go back to your terminal and press **Enter**.

You will see:

```
  Woolworths: logged in
  Coles:      logged in

  Setup complete! Your login is saved.
  Next time, just run: gombwe grocery
  Or from Discord: /buy milk, eggs, bread
```

If it says "not logged in" for either store, go back to Chrome and make sure you're fully logged in, then run `gombwe grocery-setup` again.

### 1.5 Configure payment

Open `~/.claude-gombwe/data/grocery-preferences.json` and add your CVV so checkout completes automatically:

```json
{
  "payment": {
    "cvv": "1234"
  },
  "delivery": {
    "instructions": "Please leave at front door / pouch. Thank you.",
    "preference": "asap"
  },
  "brands": {
    "bbq sauce": "MasterFoods Smokey Barbecue Sauce 500mL"
  },
  "never_substitute": ["MasterFoods BBQ Sauce"]
}
```

Your CVV is stored locally on your machine only — never committed to git, never uploaded anywhere. The script enters it during checkout so payment completes without manual intervention.

### 1.6 What was saved

Your login cookies are saved in `~/.claude-gombwe/chrome-profile/`. This is a local Chrome profile on your computer — your credentials are not sent anywhere. Next time you run a grocery command, Chrome launches in the background with this profile and you're already logged in.

---

## Step 2: Using Grocery Commands

### From the terminal

**Compare prices across both stores (doesn't add to cart):**

```bash
gombwe grocery "milk 2L" "eggs 12 pack" "Masterfoods BBQ Sauce" "bread" --compare
```

Expected output:

```
  Comparing 4 items

  Item                          Woolworths     Coles          Best
  ──────────────────────────────────────────────────────────────────────
  milk 2L                       $3.20          $3.20          Woolworths
  eggs 12 pack                  $6.50          $6.00          Coles
  Masterfoods BBQ Sauce         $3.20          $3.50          Woolworths
  bread                         $3.50          $3.70          Woolworths
```

**Order from a specific store (adds to cart):**

```bash
gombwe grocery "milk 2L" "eggs 12 pack" "bananas" --store woolworths
```

Expected output:

```
  Adding 3 items to woolworths cart

  milk 2L... + $3.20  Woolworths Whole Milk 2L
  eggs 12 pack... + $6.50  Woolworths 12 Extra Large Free Range Eggs 700g
  bananas... + $0.70  Cavendish Bananas each

  3/3 items added. Estimated: $10.40
```

After this, open Chrome and go to woolworths.com.au/shop/cart — your items are in the cart. Review and check out.

**Smart split (cheapest from each store):**

```bash
gombwe grocery "milk" "eggs" "bread" "chicken" "butter" "bananas" "cheese" "pasta" --split
```

Expected output:

```
  Smart Split — comparing 8 items

  Item          Woolworths  Coles    Best
  ──────────────────────────────────────────
  milk          $3.20       $3.20    Woolworths
  eggs          $6.50       $6.00    Coles
  bread         $3.50       $3.70    Woolworths
  chicken       $12.00      $11.50   Coles
  butter        $5.00       $5.50    Woolworths
  bananas       $0.70       $0.75    Woolworths
  cheese        $5.00       $4.80    Coles
  pasta         $2.50       $2.00    Coles

  ── ORDER SPLIT ──

  WOOLWORTHS (4 items):
    milk... + $3.20
    bread... + $3.50
    butter... + $5.00
    bananas... + $0.70
    Total: $12.40

  Woolworths $12.40 below $50 min — moving all to Coles

  ── Final: All items ordered from COLES ──
  Total: $37.45
```

The smart split compares every item, assigns each to the cheaper store, then checks if both orders meet the delivery minimum ($50 by default). If one store's order is too small, everything moves to the other store to avoid delivery fees.

### From Discord

Type in any Discord channel where gombwe is active:

```
/buy                              Order everything on the shopping list
/buy milk, eggs, bread            Add specific items and order them
/list milk, eggs, bread           Add items to the list (order later)
```

Or use natural language: "order the groceries", "buy some milk and eggs"

The `/grocery-order` skill is still available for direct invocation:

```
/grocery-order milk 2L, eggs 12 pack, bread, chicken breast
```

### From the gombwe terminal

If you're running `gombwe start` interactively:

```
gombwe> /buy milk, eggs, bread, chicken
```

---

## Step 3: Weekly Scheduled Order

Set up a weekly job so gombwe prepares your cart automatically.

**From Discord:**

```
/job /grocery-order review my usual list and prepare the cart --schedule "0 9 * * 0"
```

This runs every Sunday at 9am UTC. Gombwe will:
1. Load your saved preferences (brands, sizes)
2. Search both stores
3. Compare prices
4. Add the cheapest items to your cart
5. Send you a summary on Discord

**From the terminal:**

```bash
gombwe job "/grocery-order prepare weekly cart" --schedule "0 9 * * 0"
```

---

## How Preferences Work

The first time you order, gombwe searches for every item — this is the "expensive" run. After you confirm, it saves your choices:

```json
{
  "brands": {
    "bbq sauce": "MasterFoods Smokey Barbecue Sauce 500mL",
    "milk": "Woolworths Whole Milk 2L",
    "eggs": "Woolworths 12 Extra Large Free Range Eggs 700g"
  },
  "never_substitute": ["Masterfoods BBQ Sauce"]
}
```

Next week, those items are matched instantly — no search needed. Only new items require a search. By the third week, most of your order is cached and the run is nearly instant.

Preferences are stored in `~/.claude-gombwe/data/grocery-preferences.json`. You can edit this file directly to add or change brand preferences.

---

## Troubleshooting

### "Chrome not found"

Install Google Chrome from https://www.google.com/chrome/

### "No saved login found"

Run `gombwe grocery-setup` first to save your Woolworths and Coles login.

### "Could not find Add button" or items not added

Woolworths and Coles occasionally change their website structure. If items aren't being added:
1. Open Chrome manually and check if you're still logged in
2. Try adding the item manually on the website to verify it's in stock
3. Run `gombwe grocery-setup` to refresh your login session

### Items added to wrong quantities

The script adds 1 of each item by default. To change quantities, adjust your order in the cart on the Woolworths or Coles website before checking out.

### Coles prices showing as "N/A"

Coles prices are extracted from the rendered web page. If the page layout changes, prices may not be captured. Woolworths prices are more reliable as they come from an internal API. The items will still be added to cart even if the price display fails.

### Chrome opens but you're not logged in

Your login session may have expired. Run `gombwe grocery-setup` again to re-login.

---

## How It Works Under the Hood

```
gombwe grocery "milk" "eggs" --split
    │
    ▼
Chrome launches (or connects to existing)
using saved profile at ~/.claude-gombwe/chrome-profile/
    │
    ├── Woolworths: calls internal API
    │   https://www.woolworths.com.au/apis/ui/Search/products
    │   (same API their website uses, no key needed)
    │   Returns: product name, price, stockcode
    │
    ├── Coles: navigates logged-in browser to search page
    │   https://www.coles.com.au/search/products?q=...
    │   Extracts: product name, price from rendered page
    │
    ▼
Price comparison → smart split → respects delivery minimums
    │
    ▼
Woolworths: navigates to product detail page → clicks "Add to cart"
Coles: navigates to search/product page → clicks "Add to trolley"
    │
    ▼
Results sent to Discord / terminal
```

The script (`scripts/grocery.mjs`) connects to Chrome via remote debugging (port 19222). It uses `puppeteer-core` to control the browser — the same browser where you're logged in. No credentials are stored by gombwe, only the Chrome profile with session cookies.

---

## Beyond ordering — watchlist, deal alerts, meal planning, MCP

The original ordering flow above is the "do the shopping" path. Built on top of
it: a price-watching layer, an alerting layer, a 7-day meal planner, and an MCP
server that lets Claude talk to all of it in natural language.

### Component overview

```
                  ┌─────────────────────────────────────────────────────────────┐
                  │                                                             │
   ┌────────────┐ │   ┌──────────────────┐    ┌───────────────────┐             │
   │ Chrome     │◄┼───┤ grocery-lib.mjs  │◄───┤ grocery-buy.mjs   │  Ordering   │
   │ (logged in)│ │   │ (shared          │    │ (production buy)  │  (Step 2    │
   │            │ │   │  Woolies/Coles   │    └───────────────────┘   above)    │
   └────────────┘ │   │  primitives)     │◄───┤ grocery-watch.mjs │             │
                  │   └──────────────────┘    │ (daily price poll)│  Watching   │
                  │            ▲              └─────────┬─────────┘             │
                  │            │                        │                       │
                  │            │              ┌─────────▼─────────┐             │
                  │            │              │ ~/.claude-gombwe/ │             │
                  │            │              │ data/grocery-*    │  Storage    │
                  │            │              │ .json, .jsonl     │             │
                  │            │              └─────────┬─────────┘             │
                  │            │                        │                       │
                  │   ┌────────┴────────────┐   ┌───────▼──────────┐            │
                  │   │ grocery-monitor.mjs │   │ grocery-alert.mjs│  Notifying │
                  │   │ (AI recovery on     │   │ (Twilio/WA/      │            │
                  │   │  buy-flow failure)  │   │  gombwe push)    │            │
                  │   └─────────────────────┘   └──────────────────┘            │
                  │                                                             │
                  │   ┌─────────────────────┐                                   │
                  │   │ meal-plan.mjs       │  7-day dinner planner             │
                  │   │ meals-view.mjs      │  (uses pantry + deals + budget)   │
                  │   └─────────────────────┘                                   │
                  │                                                             │
                  │   ┌─────────────────────┐                                   │
                  │   │ src/mcp/family.ts   │  MCP server — Claude can call     │
                  │   │                     │  add_meal, get_grocery_deals,     │
                  │   │                     │  add_to_list, etc. in any chat    │
                  │   └─────────────────────┘                                   │
                  └─────────────────────────────────────────────────────────────┘
```

### Shared library — `scripts/grocery-lib.mjs`

The Woolworths/Coles primitives (search, attribute-match, internal-API
discovery) were extracted from the original `grocery-buy.mjs` into a single
library. Everything downstream — `grocery-buy`, `grocery-watch`, `grocery-monitor`
— imports the same shared functions, so behaviour stays consistent.

**Exports:**
- `connectChrome()` — attaches `puppeteer-core` to the long-lived Chrome at port 19222
- `searchWoolworths(items)` — internal Woolies API search; returns name + price + stockcode
- `searchColes(items)` — Coles search via internal-API discovery (auth header lifted from current session)
- `attributeMatch(query, candidates)` — picks the right product from search hits using brand/size/qty heuristics
- `addToWoolworthsCart(stockcode, qty)` — adds via product page
- `addToColesCart(productId, qty)` — adds via trolley API

If you're scripting a new grocery-adjacent thing, import from grocery-lib —
don't re-implement Woolies/Coles plumbing.

### Price watch — `scripts/grocery-watch.mjs`

Daily price poll for the items you care about. Runs in three modes:

| Invocation | Effect |
|---|---|
| `node scripts/grocery-watch.mjs` | Poll Woolies + Coles for every watchlist item, append observations to `grocery-prices.jsonl`, classify, write snapshot |
| `node scripts/grocery-watch.mjs --deals` | No polling — just show latest snapshot |
| `node scripts/grocery-watch.mjs --json` | JSON output, intended for piping into other scripts |

**Files written:**
- `~/.claude-gombwe/data/grocery-prices.jsonl` — one observation per item per store per run (append-only history)
- `~/.claude-gombwe/data/grocery-deals-latest.json` — current snapshot consumed by the alerter and MCP `get_grocery_deals` tool
- `~/.claude-gombwe/data/grocery-watchlist.json` — input list; edit directly or via MCP `add_watchlist_item`

**Watchlist item shape:**
```json
{
  "items": [
    {
      "name": "MasterFoods Smokey Barbecue Sauce 500mL",
      "max_price": 3.50,           // your "I'd buy at this price" ceiling
      "preferred_brand": "MasterFoods",
      "size": "500mL"
    }
  ],
  "free_delivery_threshold": 50    // both stores: spend ≥ $50 for free delivery
}
```

**What the snapshot classifies:**
- All-time-low price per item per store (over the full `.jsonl` history)
- Which items are CURRENTLY at-or-below their `max_price` ceiling (eligible to buy)
- Whether eligible items at either store sum to ≥ the free-delivery threshold
  (so you can do a single delivery instead of waiting)

### Deal alert — `scripts/grocery-alert.mjs`

Reads the latest snapshot and notifies if anything's actionable. Multi-transport:

| Transport | Trigger |
|---|---|
| **gombwe `/api/notify`** | Always tries — broadcasts to Discord / Telegram / web dashboard if those channels are configured in gombwe |
| **Twilio SMS** | If `~/.claude-gombwe/notify-config.json` has `twilio.{sid,token,from}`. Sends to each number in `twilio.to[]` |
| **WhatsApp Cloud API** | If `notify-config.json` has `whatsapp.{access_token,phone_number_id,to}` |

**Sample notification:**
> 🛒 3 rock-bottom items at Woolworths totalling $52.40 — eligible for free
> delivery. MasterFoods BBQ Sauce $3.20 (best ever), Cadbury Dairy Milk $2.50
> (best ever), Lurpak Slightly Salted $7.50 (matches all-time low).

**Manual / dry-run:**
```bash
node scripts/grocery-alert.mjs --dry-run    # prints what would be sent, doesn't send
```

### Setup template:
```bash
cp ~/.claude-gombwe/notify-config.example.json ~/.claude-gombwe/notify-config.json
# edit notify-config.json with your Twilio / WhatsApp credentials
```

The alerter still works without any creds — it'll push through gombwe's
existing channels and print "would send to X via Y" for missing transports.

### AI-monitored buy flow — `scripts/grocery-monitor.mjs`

Wraps `grocery-buy.mjs` with a Claude Sonnet recovery loop. Normal flow runs
the mechanical buy script unchanged. If a step fails (Coles changed a button
selector, Woolies dropped a field), the monitor:

1. Takes a screenshot of the current page
2. Sends to Claude with: *"Step X failed. Here's the error. Here's the screenshot. Fix it."*
3. Claude returns a JavaScript snippet to execute in the browser
4. Monitor executes the fix
5. Retries the step

Most buy runs never invoke Claude. The fallback exists for when Coles/Woolies
ship UI changes that haven't been mechanically captured yet.

Use this instead of `grocery-buy.mjs` directly if you want self-healing checkout.

### 7-day dinner planner — `scripts/meal-plan.mjs` + `scripts/meals-view.mjs`

`meal-plan.mjs` generates a 7-day dinner plan that:
- Honours family dietary requirements (`family.json → members[].dietary`)
- Uses pantry contents (`family.json → pantry`)
- Prefers items currently on deal (reads `grocery-deals-latest.json`)
- Stays within budget (`family.json → budget`)
- Extracts per-meal ingredients and merges them into the shopping list

**Run modes:**
```bash
node scripts/meal-plan.mjs              # generates + writes to family.json
node scripts/meal-plan.mjs --dry-run    # plans + prints, doesn't save
```

`meals-view.mjs` is the read-side: pretty-prints the current plan.

```bash
node scripts/meals-view.mjs              # full view (week + grocery + pantry)
node scripts/meals-view.mjs week         # week plan only
node scripts/meals-view.mjs grocery      # shopping list only
node scripts/meals-view.mjs pantry       # pantry inventory only
```

### MCP server — `src/mcp/family.ts`

Lets Claude (in any chat, via Claude Desktop / Discord / Telegram) call grocery
+ meal + family tools by name. Exposes:

| Tool | What Claude says to invoke it (roughly) |
|---|---|
| `add_meal` | "add butter chicken to Wednesday dinner" — auto-extracts ingredients, adds to shopping list |
| `remove_meal` | "remove Wednesday dinner" |
| `view_meals` | "what's the meal plan this week?" |
| `add_to_list` | "add milk, eggs, and laundry detergent to the list" — auto-sorts food vs non-food |
| `view_list` | "what's on the shopping list?" |
| `remove_from_list` | "I bought milk" |
| `set_family` | "Liam is 14, vegetarian" — used for recipe scaling |
| `view_family` | "who's in the family?" |
| `remove_family_member` | "remove the placeholder member" |
| `get_grocery_deals` | "what's on special this week?" — reads latest watch snapshot |
| `get_meal_plan` | "show me the full plan with per-person modifications" |
| `get_watchlist` | "what are we tracking the price of?" |
| `add_watchlist_item` | "start tracking the price of Lurpak butter" — appends to grocery-watchlist.json |
| `remove_watchlist_item` | "stop tracking the BBQ sauce" |

All state lives in `~/.claude-gombwe/data/family.json` and the grocery JSON files.

### Family tab in the dashboard

The main gombwe dashboard's **Family** tab surfaces the same data without the
MCP layer:
- Calendar view of the 7-day plan
- Meal-planner card with per-day per-slot meal slots
- Grocery list with check-off
- Pantry inventory
- Family members register (used by recipe scaling + dietary filter)

UI in `ui/index.html` under `<section id="tab-family">`. Logic in `ui/app.js`
search for `loadFamily()` and `renderFamily()`. Backend at `/api/family*`.

---

## Cron — daily watch + alert + weekly meal plan

For unattended operation, see [`scripts/grocery-cron-setup.md`](../scripts/grocery-cron-setup.md). Summary:

| Job | Schedule | Script |
|---|---|---|
| **Price watch** | Daily 06:00 | `node scripts/grocery-watch.mjs` |
| **Deal alert** | Daily 06:15 | `node scripts/grocery-alert.mjs` |
| **Meal plan** | Sunday 17:00 | `node scripts/meal-plan.mjs` |

Install via `crontab -e`; **on macOS you must also grant `/usr/sbin/cron` Full Disk Access** in Settings → Privacy & Security, or the jobs silently fail when trying to read/write `~/.claude-gombwe/`.

---

## File reference

### Configuration

| File | Purpose |
|---|---|
| `~/.claude-gombwe/chrome-profile/` | Persistent Chrome session (logged-in cookies). NOT committed. |
| `~/.claude-gombwe/data/grocery-preferences.json` | Saved brand choices + payment CVV + delivery instructions |
| `~/.claude-gombwe/data/grocery-watchlist.json` | Items the price watcher polls |
| `~/.claude-gombwe/notify-config.json` | Twilio + WhatsApp Cloud API credentials for the alerter |
| `~/.claude-gombwe/data/family.json` | Members, dietary requirements, meal plan, pantry, shopping list |

### Generated / state

| File | Purpose |
|---|---|
| `~/.claude-gombwe/data/grocery-prices.jsonl` | Append-only price history (one record per item per store per run) |
| `~/.claude-gombwe/data/grocery-deals-latest.json` | Latest snapshot — what's at rock-bottom, what's eligible, what hits the free-delivery threshold |
| `~/.claude-gombwe/data/grocery-cron.log` | Cron job output (rotate manually if it grows) |
| `~/.claude-gombwe/data/grocery-last-run.json` | Sentinel for the last successful buy run |

### Code

| File | Role |
|---|---|
| `scripts/grocery.mjs` | CLI dispatch (compare / split / order / checkout) — invoked by `gombwe grocery` |
| `scripts/grocery-buy.mjs` | Production buy flow (clear cart → add items → open checkout) |
| `scripts/grocery-lib.mjs` | **Shared library** — Woolies/Coles search, attribute-match, cart add. Re-used by all downstream scripts |
| `scripts/grocery-watch.mjs` | Daily price poller + deal classifier |
| `scripts/grocery-alert.mjs` | Multi-transport notifier (gombwe push / Twilio / WhatsApp) |
| `scripts/grocery-monitor.mjs` | AI-recovery wrapper around `grocery-buy.mjs` |
| `scripts/meal-plan.mjs` | 7-day dinner planner |
| `scripts/meals-view.mjs` | Read-side for the meal plan |
| `scripts/chrome-setup.mjs` | First-time login wizard |
| `scripts/grocery-cron-setup.md` | Cron + macOS Full Disk Access setup notes |
| `src/mcp/family.ts` | MCP server exposing 14 tools for natural-language interaction |
