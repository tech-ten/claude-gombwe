#!/usr/bin/env node
/**
 * MEAL PLAN — 7-day dinner planner for the household.
 *
 * Reads:
 *   ~/.claude-gombwe/data/family.json         (members, dietary, pantry,
 *                                              meal_pattern, budget, existing
 *                                              meals)
 *   ~/.claude-gombwe/data/dinner-bank.json    (curated dinners with metadata)
 *   ~/.claude-gombwe/data/grocery-deals-latest.json
 *                                             (current rock-bottom / eligible
 *                                              items — informs picks)
 *   /Users/tendaimudavanhu/code/fin-statements/output/transactions.csv
 *                                             (internal budget tracking —
 *                                              user explicitly said "internal")
 *
 * Writes:
 *   ~/.claude-gombwe/data/meal-plan-latest.json
 *                                             (7-day dinner plan with portions,
 *                                              ingredients-needed list, est
 *                                              cost, diet notes)
 *
 * Honest about the budget: $800/mo for a household of 6 is ambitious. The
 * planner flags days that push over the implied per-day allowance rather
 * than silently picking the cheapest meals only.
 *
 * Generates ONLY dinners — per family.json/meal_pattern, breakfast = cereal,
 * lunch = lunchbox_rotation (kids only), snacks = approved_snacks. Adult
 * lunches are not planned.
 *
 * Usage:
 *   node scripts/meal-plan.mjs              → generate next 7 days, print + write
 *   node scripts/meal-plan.mjs --days 14    → next 14 days
 *   node scripts/meal-plan.mjs --from 2026-05-22  → from a specific date
 *   node scripts/meal-plan.mjs --dry-run    → show pick but don't write
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

const DATA_DIR = join(homedir(), '.claude-gombwe', 'data');
const FAMILY      = join(DATA_DIR, 'family.json');
const BANK        = join(DATA_DIR, 'dinner-bank.json');
const DEALS       = join(DATA_DIR, 'grocery-deals-latest.json');
const PLAN_OUT    = join(DATA_DIR, 'meal-plan-latest.json');
const TRANSACTIONS = '/Users/tendaimudavanhu/code/fin-statements/output/transactions.csv';

// ── tiny helpers ─────────────────────────────────────────────────────

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch (err) { console.warn(`  ! could not parse ${path}: ${err.message}`); return fallback; }
}

function ymd(d) { return d.toISOString().slice(0, 10); }

function* dateRange(fromIso, days) {
  const start = new Date(fromIso + 'T00:00:00');
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    yield ymd(d);
  }
}

// ── budget tracking (internal — read transactions.csv) ───────────────

function thisMonthGrocerySpend() {
  if (!existsSync(TRANSACTIONS)) return { spent: 0, month: ymd(new Date()).slice(0, 7), source: 'no-data' };
  const text = readFileSync(TRANSACTIONS, 'utf-8');
  const lines = text.split('\n');
  const header = lines[0].split(',');
  const idx = (col) => header.indexOf(col);
  const dCol = idx('Date'), aCol = idx('Amount'), cCol = idx('Category'), sCol = idx('Subcategory'),
        dscCol = idx('Description'), itmCol = idx('Item');
  const month = ymd(new Date()).slice(0, 7);
  let spent = 0, count = 0;
  const groceryKW = ['woolworths', 'coles', 'aldi', 'iga', 'costco', 'foodworks'];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (!row.trim()) continue;
    // Simple CSV split — fields don't contain commas in this dataset (audited).
    const cells = row.split(',');
    if (!cells[dCol]?.startsWith(month)) continue;
    const amt = parseFloat(cells[aCol] || '0') || 0;
    if (amt >= 0) continue;
    const desc = (cells[dscCol] || '').toLowerCase();
    const cat  = (cells[cCol]   || '').toLowerCase();
    const sub  = (cells[sCol]   || '').toLowerCase();
    const item = (cells[itmCol] || '').toLowerCase();
    const isGrocery = cat.includes('grocer') || sub.includes('grocer')
      || groceryKW.some(k => desc.includes(k) || item.includes(k));
    if (isGrocery) { spent += -amt; count++; }
  }
  return { spent: +spent.toFixed(2), month, count, source: 'transactions.csv' };
}

// ── deals lookup ─────────────────────────────────────────────────────

function dealsLookup(report) {
  const map = new Map();   // item name → 'rock-bottom' | 'eligible' | 'wait' | 'no-data'
  if (!report) return map;
  for (const c of report.items || []) map.set(c.name, c.status);
  return map;
}

// ── diet enforcement ─────────────────────────────────────────────────

function buildMemberConstraints(members) {
  // Translate prose dietary into hard exclusions.
  const out = {};
  for (const m of members) {
    const diet = (m.dietary || '').toLowerCase();
    const excl = [];
    if (diet.includes('no carb')) excl.push('carbs');
    if (diet.includes('no seafood')) excl.push('seafood');
    if (diet.includes('no meat') || diet.includes("doesn't like meat") || diet.includes('does not like meat')) excl.push('meat');
    if (diet.includes('vego') || diet.includes('vegetarian')) excl.push('meat', 'seafood');
    out[m.name] = { type: m.type, dietary_text: m.dietary || '', excludes: excl };
  }
  return out;
}

function dinnerSuitableFor(dinner, member, memberConstraints) {
  const c = memberConstraints[member];
  if (!c) return { suitable: true, needs_mod: false };
  const mods = dinner.modifications || {};
  if (mods[member]) return { suitable: true, needs_mod: true, mod: mods[member] };
  // No mod listed — does the base dish work?
  const meat = ['beef', 'pork', 'lamb', 'chicken', 'mixed'].includes(dinner.main_protein);
  const seafood = dinner.main_protein === 'fish';
  if (c.excludes.includes('seafood') && seafood) return { suitable: false, reason: 'seafood' };
  if (c.excludes.includes('meat') && meat) return { suitable: false, reason: 'meat' };
  // no-carbs handled by per-portion modification, not exclusion — Tendai still
  // eats with the family.
  return { suitable: true, needs_mod: false };
}

// ── selection logic ──────────────────────────────────────────────────

const PROTEIN_CYCLE_PREFERENCE = ['chicken', 'beef', 'pork', 'lamb', 'egg', 'legume', 'fish', 'cheese'];

function scoreDinner(dinner, ctx) {
  let score = 100;
  // Penalise repeating proteins in the rolling window
  const recent = ctx.recentProteins.slice(-3);
  if (recent.filter(p => p === dinner.main_protein).length >= 2) score -= 40;
  if (recent[recent.length - 1] === dinner.main_protein) score -= 30;
  // Reward dishes whose ingredients are in pantry OR at rock-bottom right now
  let onSale = 0, inPantry = 0, total = 0;
  for (const ing of dinner.ingredients || []) {
    total++;
    if (ing.where_to_get === 'pantry' && ctx.pantrySet.has((ing.name || '').toLowerCase().split(' ')[0])) inPantry++;
    if (ing.watchlist_match) {
      const status = ctx.deals.get(ing.watchlist_match);
      if (status === 'rock-bottom') onSale += 2;
      else if (status === 'eligible') onSale += 1;
    }
  }
  score += onSale * 5 + inPantry * 3;
  // Cost relative to per-day allowance
  if (dinner.est_cost_aud > ctx.dailyAllowance) {
    score -= (dinner.est_cost_aud - ctx.dailyAllowance) * 4;
  } else {
    score += (ctx.dailyAllowance - dinner.est_cost_aud) * 2;
  }
  // Reward dishes with explicit modifications for every constrained member
  // (means they're family-tested)
  if (dinner.modifications) {
    for (const m of Object.keys(ctx.memberConstraints)) {
      if (ctx.memberConstraints[m].excludes.length > 0 && dinner.modifications[m]) score += 8;
    }
  }
  // Reward broccoli for Josh
  if (dinner.veg_focus === 'broccoli') score += 4;
  return score;
}

function pickNext(bank, ctx) {
  // Filter dinners that have valid Lee modification (Lee is the most-constrained)
  // OR are inherently no-meat/no-seafood.
  const candidates = bank.dinners.filter(d => {
    for (const m of Object.keys(ctx.memberConstraints)) {
      const s = dinnerSuitableFor(d, m, ctx.memberConstraints);
      if (!s.suitable) return false;
    }
    return !ctx.usedThisWeek.has(d.name);
  });
  if (candidates.length === 0) {
    // Allow repeats if we run out of unique dinners
    const all = bank.dinners.filter(d => {
      for (const m of Object.keys(ctx.memberConstraints)) {
        const s = dinnerSuitableFor(d, m, ctx.memberConstraints);
        if (!s.suitable) return false;
      }
      return true;
    });
    return all.sort((a, b) => scoreDinner(b, ctx) - scoreDinner(a, ctx))[0];
  }
  return candidates.sort((a, b) => scoreDinner(b, ctx) - scoreDinner(a, ctx))[0];
}

// ── main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argVal(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }
const dryRun = args.includes('--dry-run');
const days   = parseInt(argVal('--days') || '7', 10);
const fromArg = argVal('--from');

async function main() {
  const family = readJson(FAMILY, {});
  const bank   = readJson(BANK,   { dinners: [] });
  const deals  = readJson(DEALS,  null);

  if (!bank.dinners?.length) { console.error('No dinners in dinner-bank.json'); process.exit(1); }

  const today = ymd(new Date());
  const fromDate = fromArg || today;
  const memberConstraints = buildMemberConstraints(family.members || []);
  const pantrySet = new Set((family.pantry || []).map(p => (typeof p === 'string' ? p : p.name || '').toLowerCase().split(' ')[0]));
  const dealsMap = dealsLookup(deals);
  const budget = family.budget?.monthly_target_aud || 800;

  const spendInfo = thisMonthGrocerySpend();
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const dayOfMonth = new Date().getDate();
  const daysLeftThisMonth = Math.max(1, daysInMonth - dayOfMonth + 1);
  const remaining = Math.max(0, budget - spendInfo.spent);
  const dailyAllowance = remaining / daysLeftThisMonth;

  console.log(`  ── BUDGET CONTEXT (internal) ──`);
  console.log(`  Month-to-date grocery spend: $${spendInfo.spent}  (${spendInfo.count} transactions, source: ${spendInfo.source})`);
  console.log(`  Monthly target:              $${budget}`);
  console.log(`  Remaining this month:        $${remaining.toFixed(2)}`);
  console.log(`  Days left in month:          ${daysLeftThisMonth}`);
  console.log(`  Implied daily allowance:     $${dailyAllowance.toFixed(2)}/day`);

  // Honesty check — surface the structural budget gap
  if (budget < 1100) {
    console.log(`\n  ⚠️  HEADS UP: $${budget}/mo for a household of 6 (4 kids) is below the AIFS 2024 modest estimate (~$1,200/mo).`);
    console.log(`     Dinners below will favour cheap proteins (mince, sausage, legume) and reuse-friendly bulk dishes.`);
    console.log(`     Treat-night dishes (lamb chops, $20+ items) are still in the bank but rotated sparingly.`);
  }
  console.log('');

  // Build the plan
  const recentProteins = [];
  const usedThisWeek = new Set();
  const plan = { generated_at: new Date().toISOString(), from: fromDate, days, dinners: [], totals: { est_cost: 0 } };

  for (const date of dateRange(fromDate, days)) {
    // Skip dates already planned in family.json
    const alreadyPlanned = family.meals?.[date];
    if (alreadyPlanned) {
      plan.dinners.push({ date, status: 'already-planned', existing: alreadyPlanned });
      console.log(`  ${date}  [already planned: ${typeof alreadyPlanned === 'string' ? alreadyPlanned : 'see family.json'}]`);
      continue;
    }
    const ctx = { recentProteins, usedThisWeek, pantrySet, deals: dealsMap, memberConstraints, dailyAllowance };
    const pick = pickNext(bank, ctx);
    if (!pick) {
      plan.dinners.push({ date, status: 'no-pick' });
      console.log(`  ${date}  ?  no suitable dinner`);
      continue;
    }
    usedThisWeek.add(pick.name);
    recentProteins.push(pick.main_protein);
    plan.totals.est_cost += pick.est_cost_aud || 0;

    const overBudget = (pick.est_cost_aud || 0) > dailyAllowance;
    const ingredientsNeeded = (pick.ingredients || []).filter(i => i.where_to_get !== 'pantry');

    plan.dinners.push({
      date,
      status: 'planned',
      name: pick.name,
      protein: pick.main_protein,
      veg_focus: pick.veg_focus,
      est_cost_aud: pick.est_cost_aud,
      over_daily_allowance: overBudget,
      prep_minutes: pick.prep_minutes,
      leftovers_pack: pick.leftovers_pack,
      diet_tags: pick.diet_tags,
      modifications: pick.modifications || {},
      ingredients_needed: ingredientsNeeded,
    });

    const tag = overBudget ? '⚠' : ' ';
    console.log(`  ${date}  ${tag} ${pick.name.padEnd(50)} $${(pick.est_cost_aud || 0).toString().padStart(4)}  (${pick.main_protein}/${pick.veg_focus})`);
    if (Object.keys(pick.modifications || {}).length) {
      for (const [m, mod] of Object.entries(pick.modifications)) {
        console.log(`              ↳ ${m}: ${mod}`);
      }
    }
  }

  plan.totals.est_cost = +plan.totals.est_cost.toFixed(2);
  plan.budget_context = {
    monthly_target: budget,
    month_to_date_spent: spendInfo.spent,
    remaining_this_month: +remaining.toFixed(2),
    days_left_this_month: daysLeftThisMonth,
    daily_allowance: +dailyAllowance.toFixed(2),
    plan_implied_per_day: +(plan.totals.est_cost / days).toFixed(2),
  };

  console.log(`\n  ── PLAN TOTALS ──`);
  console.log(`  Estimated cost of ${days}-day dinner plan: $${plan.totals.est_cost}`);
  console.log(`  Implied per-day:                          $${plan.budget_context.plan_implied_per_day}`);
  console.log(`  Daily allowance (budget/remaining):       $${plan.budget_context.daily_allowance}`);
  if (plan.totals.est_cost > remaining) {
    console.log(`\n  ⚠️  Plan exceeds remaining monthly budget by $${(plan.totals.est_cost - remaining).toFixed(2)}.`);
    console.log(`     Either drop a treat-night dish, or accept the overshoot (groceries arn't only dinner).`);
  }
  console.log('');

  if (dryRun) { console.log('  (dry run — not writing plan file)'); return; }

  mkdirSync(dirname(PLAN_OUT), { recursive: true });
  writeFileSync(PLAN_OUT, JSON.stringify(plan, null, 2), { mode: 0o600 });
  console.log(`  Plan written to ${PLAN_OUT}`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
