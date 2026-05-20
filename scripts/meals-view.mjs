#!/usr/bin/env node
/**
 * meals-view.mjs — Reads family.json + recipes.json and outputs a formatted
 * weekly meal plan with grocery list, pantry status, and recipe details.
 *
 * Usage:
 *   node scripts/meals-view.mjs              # full view (week + grocery + pantry)
 *   node scripts/meals-view.mjs week         # week plan only
 *   node scripts/meals-view.mjs grocery      # grocery list only
 *   node scripts/meals-view.mjs pantry       # pantry only
 *   node scripts/meals-view.mjs recipe       # all recipes
 *   node scripts/meals-view.mjs recipe "chicken stir fry"  # specific recipe
 *   node scripts/meals-view.mjs plan         # current 7-day dinner plan (auto-regen if stale)
 *   node scripts/meals-view.mjs deals        # current rock-bottom grocery deals
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(homedir(), '.claude-gombwe', 'data');

function load(file, fallback) {
  try { return JSON.parse(readFileSync(join(DATA_DIR, file), 'utf-8')); }
  catch { return fallback; }
}

const family = load('family.json', { meals: {}, groceryList: [], nonFoodList: [], pantry: [], events: [] });
const recipes = load('recipes.json', {});

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const SLOTS = ['breakfast', 'lunch', 'dinner'];
const SLOT_LABELS = { breakfast: 'B', lunch: 'L', dinner: 'D' };

function getWeekDates(offset = 0) {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - start.getDay() + 1 + offset * 7);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function mealStatus(name) {
  if (!name) return '';
  const lower = name.toLowerCase();
  const pantryNames = (family.pantry || []).map(i => i.toLowerCase());
  const onList = (family.groceryList || []).some(i =>
    (i.meals || []).some(m => m === lower) ||
    i.name.toLowerCase().includes(lower) || lower.includes(i.name.toLowerCase())
  );
  const inPantry = pantryNames.some(p => p.includes(lower) || lower.includes(p));
  if (inPantry) return ' (stocked)';
  if (onList) return ' (on list)';
  return ' (!)';
}

// ── Week view ──
function renderWeek() {
  const days = getWeekDates();
  const today = dateKey(new Date());
  const s = days[0], e = days[6];
  const lines = [`**This Week** — ${s.getDate()} ${MONTHS[s.getMonth()]} to ${e.getDate()} ${MONTHS[e.getMonth()]} ${e.getFullYear()}\n`];

  for (let i = 0; i < 7; i++) {
    const d = days[i];
    const dk = dateKey(d);
    const isToday = dk === today;
    const meals = family.meals?.[dk] || {};
    const dayEvents = (family.events || []).filter(ev => ev.date === dk);

    const marker = isToday ? ' (today)' : '';
    lines.push(`**${DAY_NAMES[i]} ${d.getDate()}**${marker}`);

    let hasMeal = false;
    for (const slot of SLOTS) {
      if (meals[slot]) {
        const status = mealStatus(meals[slot]);
        lines.push(`  ${SLOT_LABELS[slot]}: ${meals[slot]}${status}`);
        hasMeal = true;
      }
    }
    if (!hasMeal) lines.push('  — no meals planned');

    for (const ev of dayEvents) {
      const prefix = ev.type === 'school' ? 'School' : 'Event';
      lines.push(`  ${prefix}: ${ev.title}${ev.child ? ` (${ev.child})` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ── Grocery list ──
function renderGrocery() {
  const items = family.groceryList || [];
  const nonFood = family.nonFoodList || [];
  if (items.length === 0 && nonFood.length === 0) return '**Grocery List**\nEmpty — no items to buy.\n';

  const lines = ['**Grocery List**\n'];

  if (items.length > 0) {
    const unchecked = items.filter(i => !i.checked);
    const checked = items.filter(i => i.checked);
    for (const item of unchecked) {
      const meals = (item.meals || []).join(', ');
      const source = item.source === 'human' ? ' [preference]' : item.source === 'auto' ? ' [auto]' : '';
      lines.push(`- [ ] ${item.name}${meals ? ` (${meals})` : ''}${source}`);
    }
    for (const item of checked) {
      lines.push(`- [x] ~~${item.name}~~`);
    }
  }

  if (nonFood.length > 0) {
    lines.push('\n**Household / Non-Food**\n');
    for (const item of nonFood) {
      const mark = item.checked ? '[x]' : '[ ]';
      lines.push(`- ${mark} ${item.name}`);
    }
  }

  if (family.lastOrdered) {
    const d = new Date(family.lastOrdered);
    lines.push(`\nLast ordered: ${DAY_NAMES[(d.getDay()+6)%7]} ${d.getDate()} ${MONTHS[d.getMonth()]}`);
  }

  return lines.join('\n') + '\n';
}

// ── Pantry ──
function renderPantry() {
  const items = family.pantry || [];
  if (items.length === 0) return '**Pantry / In Stock**\nEmpty.\n';

  const lines = [`**Pantry / In Stock** (${items.length} items)\n`];
  for (const name of items) {
    lines.push(`- ${name}`);
  }
  return lines.join('\n') + '\n';
}

// ── Recipes ──
function renderRecipes(filter) {
  // Filter out the merged-file metadata key
  const names = Object.keys(recipes).filter(n => !n.startsWith('_')).sort();
  if (names.length === 0) return '**Recipes**\nNo recipes saved yet.\n';

  if (filter) {
    const lower = filter.toLowerCase();
    // Case-insensitive match: exact (lc==lc) → substring → fall through
    const match = names.find(n => n.toLowerCase() === lower)
               || names.find(n => n.toLowerCase().includes(lower));
    if (!match) return `No recipe found for "${filter}".\nAvailable: ${names.join(', ')}\n`;

    const r = recipes[match];
    const prefs = r.preferences || {};
    const lines = [`**${match}**`];
    if (r.category)      lines.push(`_${r.category}${r.main_protein ? ' · ' + r.main_protein : ''}${r.est_cost_aud ? ' · ~$' + r.est_cost_aud + ' for 6' : ''}${r.prep_minutes ? ' · ' + r.prep_minutes + ' min' : ''}_`);
    lines.push('\nIngredients:');
    for (const ing of (r.ingredients || [])) {
      const text = typeof ing === 'string' ? ing : `${ing.name || '?'}${ing.qty ? ' — ' + ing.qty : ''}`;
      const tag = prefs[ing] === 'human' ? ' [preference]' : '';
      lines.push(`- ${text}${tag}`);
    }
    if (r.recipe) lines.push(`\nMethod:\n${r.recipe}`);
    if (r.modifications && Object.keys(r.modifications).length) {
      lines.push('\nPer-person modifications:');
      for (const [m, mod] of Object.entries(r.modifications)) lines.push(`  • ${m}: ${mod}`);
    }
    if (r.diet_tags?.length) lines.push(`\nTags: ${r.diet_tags.join(', ')}`);
    return lines.join('\n') + '\n';
  }

  const lines = [`**Recipes** (${names.length})\n`];
  for (const name of names) {
    const r = recipes[name];
    const count = r.ingredients?.length || 0;
    const humanCount = Object.values(r.preferences || {}).filter(v => v === 'human').length;
    const prefNote = humanCount > 0 ? `, ${humanCount} preferences` : '';
    lines.push(`- **${name}** — ${count} ingredients${prefNote}`);
  }
  return lines.join('\n') + '\n';
}

// ── Plan view (reads meal-plan-latest.json; regenerates if stale > 3 days) ─

function renderPlan() {
  const planPath = join(DATA_DIR, 'meal-plan-latest.json');
  let plan = load('meal-plan-latest.json', null);
  const isStale = !plan || !existsSync(planPath)
    || (Date.now() - statSync(planPath).mtimeMs > 3 * 86_400_000);

  if (isStale) {
    // Re-run meal-plan.mjs to refresh. Same script the cron uses.
    const here = dirname(fileURLToPath(import.meta.url));
    const result = spawnSync('node', [join(here, 'meal-plan.mjs')], { stdio: 'inherit' });
    if (result.status !== 0) return '_Meal planner failed — check console output above._\n';
    plan = load('meal-plan-latest.json', null);
    if (!plan) return '_No meal plan available._\n';
  }

  const lines = [`**${plan.days}-Day Dinner Plan** — from ${plan.from}\n`];
  const bc = plan.budget_context || {};
  lines.push(`Budget: $${bc.month_to_date_spent ?? '?'} spent / $${bc.monthly_target ?? '?'} target · $${bc.daily_allowance ?? '?'} / day allowance · plan implies $${bc.plan_implied_per_day ?? '?'} / day\n`);
  for (const d of plan.dinners || []) {
    if (d.status === 'already-planned') {
      lines.push(`**${d.date}** ${typeof d.existing === 'string' ? d.existing : '_already planned_'}`);
      continue;
    }
    if (d.status !== 'planned') {
      lines.push(`**${d.date}** _no pick_`);
      continue;
    }
    const flag = d.over_daily_allowance ? ' ⚠' : '';
    lines.push(`**${d.date}**${flag} ${d.name}  · $${d.est_cost_aud}  (${d.protein}/${d.veg_focus})`);
    for (const [m, mod] of Object.entries(d.modifications || {})) {
      lines.push(`  • ${m}: ${mod}`);
    }
    if (d.ingredients_needed?.length) {
      const buy = d.ingredients_needed.map(i => i.name).slice(0, 5).join(', ');
      lines.push(`  _Need: ${buy}${d.ingredients_needed.length > 5 ? ', …' : ''}_`);
    }
  }
  return lines.join('\n') + '\n';
}

// ── Deals view (reads grocery-deals-latest.json) ─────────────────────

function renderDeals() {
  const deals = load('grocery-deals-latest.json', null);
  if (!deals) return '_No deals snapshot yet — run `node scripts/grocery-watch.mjs` first._\n';
  const lines = [`**Today's Grocery Deals**\n`];
  lines.push(`Rock-bottom: ${deals.rock_bottom?.length || 0}  ·  Eligible: ${deals.eligible?.length || 0}  ·  Waiting: ${deals.waiting?.length || 0}\n`);
  const w = deals.carts?.woolworths;
  const c = deals.carts?.coles;
  if (w) lines.push(`Woolworths cart: ${w.items.length} items · $${w.total} ${w.free_delivery ? '✓ free delivery' : `(need $${(75 - w.total).toFixed(2)} more)`}`);
  if (c) lines.push(`Coles cart:      ${c.items.length} items · $${c.total} ${c.free_delivery ? '✓ free delivery' : `(need $${(50 - c.total).toFixed(2)} more)`}`);
  lines.push('');
  if (deals.rock_bottom?.length) {
    lines.push('**Rock-bottom right now:**');
    for (const r of deals.rock_bottom.slice(0, 15)) {
      lines.push(`  • ${r.name} @ $${r.best.price?.toFixed(2)} (${r.best.store}, ceiling $${r.max_price})`);
    }
    if (deals.rock_bottom.length > 15) lines.push(`  … +${deals.rock_bottom.length - 15} more`);
  }
  return lines.join('\n') + '\n';
}

// ── Main ──
const mode = process.argv[2] || 'all';
const arg = process.argv[3] || '';

switch (mode) {
  case 'week':
    console.log(renderWeek());
    break;
  case 'grocery':
    console.log(renderGrocery());
    break;
  case 'pantry':
    console.log(renderPantry());
    break;
  case 'recipe':
  case 'recipes':
    console.log(renderRecipes(arg));
    break;
  case 'plan':
    console.log(renderPlan());
    break;
  case 'deals':
    console.log(renderDeals());
    break;
  case 'all':
  default:
    console.log(renderWeek());
    console.log('---\n');
    console.log(renderGrocery());
    console.log('---\n');
    console.log(renderPantry());
    break;
}
