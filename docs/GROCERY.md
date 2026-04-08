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
  Or from Discord: /grocery-order milk, eggs, bread
```

If it says "not logged in" for either store, go back to Chrome and make sure you're fully logged in, then run `gombwe grocery-setup` again.

### 1.5 What was saved

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
/grocery-order milk 2L, eggs 12 pack, bread, Masterfoods BBQ Sauce, chicken breast
```

Gombwe will search both stores, compare prices, add items to your cart, and send you the results in Discord.

### From the gombwe terminal

If you're running `gombwe start` interactively:

```
gombwe> /grocery-order milk, eggs, bread, chicken
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
