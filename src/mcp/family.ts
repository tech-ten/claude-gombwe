#!/usr/bin/env node
/**
 * MCP Server: Family Management
 *
 * Exposes tools for managing the family meal plan, grocery list, and pantry.
 * Claude calls these tools naturally when users talk about food, meals, or shopping.
 *
 * Transport: stdio (Claude CLI spawns this as a child process)
 * Data:      reads/writes ~/.claude-gombwe/data/family.json
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Config ──────────────────────────────────────────────────
const DATA_DIR = process.env.GOMBWE_DATA_DIR || join(homedir(), '.claude-gombwe', 'data');
const FAMILY_FILE = join(DATA_DIR, 'family.json');
const RECIPES_FILE = join(DATA_DIR, 'recipes.json');
const GATEWAY_PORT = process.env.GOMBWE_PORT || '18790';

// ── Data helpers ────────────────────────────────────────────
function loadFamily(): any {
  try { return JSON.parse(readFileSync(FAMILY_FILE, 'utf-8')); }
  catch { return { meals: {}, groceryList: [], nonFoodList: [], pantry: [], events: [], members: [], actions: [] }; }
}

function saveFamily(data: any): void {
  writeFileSync(FAMILY_FILE, JSON.stringify(data, null, 2));
}

function loadRecipes(): Record<string, any> {
  try { return JSON.parse(readFileSync(RECIPES_FILE, 'utf-8')); }
  catch { return {}; }
}

function logAction(data: any, actor: string, action: string, detail: string): void {
  if (!data.actions) data.actions = [];
  data.actions.unshift({ time: new Date().toISOString(), actor, action, detail });
  if (data.actions.length > 100) data.actions.length = 100;
}

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function resolveDay(input: string): string | null {
  const now = new Date();
  const lower = input.toLowerCase().replace(/[^a-z0-9-]/g, '');

  if (['today', 'tdy', 'tonite', 'tonight'].includes(lower)) {
    return localDateStr(now);
  }
  if (['tomorrow', 'tmrw', 'tmr', 'tomoz', 'tomo'].includes(lower)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return localDateStr(d);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;

  const fullNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const aliases: [number, string[]][] = [
    [0, ['sun', 'sunday', 'su']],
    [1, ['mon', 'monday', 'mo']],
    [2, ['tue', 'tuesday', 'tu', 'tues']],
    [3, ['wed', 'wednesday', 'we', 'weds']],
    [4, ['thu', 'thursday', 'th', 'thur', 'thurs']],
    [5, ['fri', 'friday', 'fr']],
    [6, ['sat', 'saturday', 'sa']],
  ];

  // Exact match
  for (const [num, names] of aliases) {
    if (names.includes(lower)) return dayOffset(now, num);
  }
  // Prefix match
  for (let i = 0; i < fullNames.length; i++) {
    if (lower.length >= 2 && fullNames[i].startsWith(lower)) return dayOffset(now, i);
  }
  // Fuzzy match (Levenshtein)
  let bestMatch = -1, bestDist = Infinity;
  for (let i = 0; i < fullNames.length; i++) {
    const d = levenshtein(lower, fullNames[i]);
    if (d < bestDist) { bestDist = d; bestMatch = i; }
  }
  if (bestDist <= (lower.length >= 7 ? 3 : 2)) return dayOffset(now, bestMatch);

  return null;
}

function dayOffset(now: Date, target: number): string {
  let diff = target - now.getDay();
  if (diff < 0) diff += 7;
  const d = new Date(now);
  d.setDate(d.getDate() + diff);
  return localDateStr(d);
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function isNonFood(name: string): boolean {
  const keywords = [
    'toilet paper', 'paper towel', 'tissues', 'napkins',
    'shampoo', 'conditioner', 'body wash', 'soap', 'hand wash',
    'toothpaste', 'toothbrush', 'mouthwash', 'floss', 'dental',
    'deodorant', 'razor', 'shaving', 'hair remover', 'wax strip',
    'sunscreen', 'moisturiser', 'moisturizer', 'lotion',
    'detergent', 'laundry', 'fabric softener', 'bleach',
    'dishwash', 'dish soap', 'sponge', 'scrub', 'cleaning', 'cleaner',
    'disinfectant', 'wipes', 'spray', 'air freshener',
    'bin bags', 'garbage bags', 'trash bags', 'cling wrap', 'foil', 'baking paper',
    'batteries', 'light bulb', 'candle',
    'nappy', 'nappies', 'diaper', 'diapers', 'baby wipes',
    'pad', 'pads', 'tampon', 'tampons', 'sanitary',
    'pet food', 'cat litter', 'dog food',
    'ziplock', 'sandwich bags', 'glad wrap',
    'insect', 'bug spray', 'fly spray', 'mosquito',
    'bandaid', 'band-aid', 'plaster', 'first aid',
    'cotton', 'cotton ball', 'cotton bud', 'q-tip',
  ];
  const lower = name.toLowerCase();
  return keywords.some(kw => lower.includes(kw) || kw.includes(lower));
}

function dayLabel(dateStr: string): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(dateStr + 'T00:00:00').getDay()];
}

// ── Extract ingredients via gateway API ─────────────────────
async function extractIngredients(meal: string, pantry: string[], existing: string[]): Promise<string[]> {
  try {
    console.error(`[mcp-family] extractIngredients: requesting for "${meal}" from http://127.0.0.1:${GATEWAY_PORT}/api/family/ingredients`);
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/family/ingredients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meal, pantry, existing }),
    });
    const data = await res.json();
    console.error(`[mcp-family] extractIngredients: got ${(data.ingredients || []).length} ingredients (source: ${data.source || 'unknown'})`);
    return data.ingredients || [];
  } catch (err: any) {
    console.error(`[mcp-family] extractIngredients FAILED: ${err.message}`);
    return [];
  }
}

// ── MCP Server ──────────────────────────────────────────────
const server = new McpServer({
  name: 'gombwe-family',
  version: '1.0.0',
});

// ── Tool: add_meal ──────────────────────────────────────────
server.tool(
  'add_meal',
  'Add a meal to the family weekly plan. Automatically extracts ingredients and adds them to the shopping list.',
  {
    day: z.string().describe('Day of the week (e.g. "saturday", "wed", "tomorrow") or YYYY-MM-DD'),
    slot: z.enum(['breakfast', 'lunch', 'dinner']).describe('Meal slot'),
    meal: z.string().describe('Name of the meal (e.g. "Butter chicken", "Fish and chips")'),
  },
  async ({ day, slot, meal }) => {
    const dk = resolveDay(day);
    if (!dk) {
      return { content: [{ type: 'text' as const, text: `Could not resolve "${day}" to a date. Try: today, tomorrow, mon, tue, wed, thu, fri, sat, sun.` }] };
    }

    const family = loadFamily();
    if (!family.meals) family.meals = {};
    if (!family.meals[dk]) family.meals[dk] = {};
    family.meals[dk][slot] = meal;
    logAction(family, 'user', 'meal added', `${slot} on ${dk}: ${meal}`);
    saveFamily(family);

    // Extract and add ingredients
    const pantry = (family.pantry || []).map((p: any) => typeof p === 'string' ? p : p.name);
    const existing = (family.groceryList || []).map((i: any) => i.name);
    let ingredients: string[] = [];
    let extractError = '';
    try {
      ingredients = await extractIngredients(meal, pantry, existing);
    } catch (err: any) {
      extractError = err.message;
      console.error(`[mcp-family] add_meal ingredient extraction failed for "${meal}": ${err.message}`);
    }

    if (ingredients.length > 0) {
      const updated = loadFamily();
      if (!updated.groceryList) updated.groceryList = [];
      const added: string[] = [];
      for (const name of ingredients) {
        if (!updated.groceryList.some((i: any) => i.name.toLowerCase() === name.toLowerCase())) {
          updated.groceryList.push({ name, checked: false, source: 'auto', meals: [meal.toLowerCase()] });
          added.push(name);
        }
      }
      if (added.length > 0) {
        logAction(updated, 'gombwe', 'ingredients added', `${added.length} items for ${meal}`);
        saveFamily(updated);
      }
      return { content: [{ type: 'text' as const, text: `Added ${slot} on ${dayLabel(dk)} ${dk}: ${meal}\nShopping list: +${added.join(', ')}` }] };
    }

    const warn = extractError
      ? `\n⚠ Ingredient extraction failed: ${extractError}`
      : (ingredients.length === 0 ? '\nNo new ingredients to add (already on list or in pantry).' : '');
    return { content: [{ type: 'text' as const, text: `Added ${slot} on ${dayLabel(dk)} ${dk}: ${meal}${warn}` }] };
  }
);

// ── Tool: remove_meal ───────────────────────────────────────
server.tool(
  'remove_meal',
  'Remove a meal from the weekly plan.',
  {
    day: z.string().describe('Day of the week or YYYY-MM-DD'),
    slot: z.enum(['breakfast', 'lunch', 'dinner']).describe('Meal slot to remove'),
  },
  async ({ day, slot }) => {
    const dk = resolveDay(day);
    if (!dk) return { content: [{ type: 'text' as const, text: `Could not resolve "${day}" to a date.` }] };

    const family = loadFamily();
    if (family.meals?.[dk]?.[slot]) {
      const removed = family.meals[dk][slot];
      delete family.meals[dk][slot];
      if (Object.keys(family.meals[dk]).length === 0) delete family.meals[dk];
      logAction(family, 'user', 'meal removed', `${slot} on ${dk}: ${removed}`);
      saveFamily(family);
      return { content: [{ type: 'text' as const, text: `Removed ${slot} on ${dayLabel(dk)}: ${removed}` }] };
    }
    return { content: [{ type: 'text' as const, text: `No ${slot} found on ${dk}.` }] };
  }
);

// ── Tool: view_meals ────────────────────────────────────────
server.tool(
  'view_meals',
  'View the current weekly meal plan.',
  {},
  async () => {
    const family = loadFamily();
    const meals = family.meals || {};
    const entries = Object.entries(meals).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No meals planned yet.' }] };
    }

    const lines = entries.map(([date, slots]: [string, any]) => {
      const day = dayLabel(date);
      const mealList = Object.entries(slots).map(([s, n]) => `${s}: ${n}`).join(', ');
      return `${day} ${date} — ${mealList}`;
    });
    return { content: [{ type: 'text' as const, text: `**Weekly Meals**\n${lines.join('\n')}` }] };
  }
);

// ── Tool: add_to_list ───────────────────────────────────────
server.tool(
  'add_to_list',
  'Add items to the shopping list. Automatically sorts food vs non-food (household) items.',
  {
    items: z.string().describe('Comma-separated list of items to add (e.g. "milk, eggs, toilet paper")'),
  },
  async ({ items }) => {
    const family = loadFamily();
    if (!family.groceryList) family.groceryList = [];
    if (!family.nonFoodList) family.nonFoodList = [];

    const names = items.split(',').map(s => s.trim()).filter(Boolean);
    const added: string[] = [];
    for (const name of names) {
      const lower = name.toLowerCase();
      const exists = [...family.groceryList, ...family.nonFoodList].some((i: any) => {
        const n = i.name.toLowerCase();
        return n === lower || n.includes(lower) || lower.includes(n);
      });
      if (exists) continue;
      if (isNonFood(lower)) {
        family.nonFoodList.push({ name, checked: false });
      } else {
        family.groceryList.push({ name, checked: false });
      }
      added.push(name);
    }

    if (added.length > 0) {
      logAction(family, 'user', 'added to list', added.join(', '));
      saveFamily(family);
      return { content: [{ type: 'text' as const, text: `Added to list: ${added.join(', ')}` }] };
    }
    return { content: [{ type: 'text' as const, text: 'Those items are already on the list.' }] };
  }
);

// ── Tool: view_list ─────────────────────────────────────────
server.tool(
  'view_list',
  'View the current shopping list and household items.',
  {},
  async () => {
    const family = loadFamily();
    const groceries = (family.groceryList || []).filter((i: any) => !i.checked);
    const nonFood = (family.nonFoodList || []).filter((i: any) => !i.checked);
    const pantry = (family.pantry || []).map((i: any) => typeof i === 'string' ? i : i.name);

    let out = '';
    if (groceries.length) out += `**Shopping List** (${groceries.length})\n${groceries.map((i: any) => `- ${i.name}`).join('\n')}\n`;
    if (nonFood.length) out += `\n**Household**\n${nonFood.map((i: any) => `- ${i.name}`).join('\n')}\n`;
    if (pantry.length) out += `\n**In Stock**\n${pantry.join(', ')}`;
    if (!out) out = 'Shopping list is empty.';

    return { content: [{ type: 'text' as const, text: out }] };
  }
);

// ── Tool: remove_from_list ──────────────────────────────────
server.tool(
  'remove_from_list',
  'Remove items from the shopping list.',
  {
    items: z.string().describe('Comma-separated list of items to remove'),
  },
  async ({ items }) => {
    const family = loadFamily();
    const names = items.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const removed: string[] = [];

    for (const list of ['groceryList', 'nonFoodList'] as const) {
      if (!family[list]) continue;
      const before = family[list].length;
      family[list] = family[list].filter((i: any) => {
        const match = names.some(n => i.name.toLowerCase().includes(n) || n.includes(i.name.toLowerCase()));
        if (match) removed.push(i.name);
        return !match;
      });
    }

    if (removed.length > 0) {
      logAction(family, 'user', 'removed from list', removed.join(', '));
      saveFamily(family);
      return { content: [{ type: 'text' as const, text: `Removed: ${removed.join(', ')}` }] };
    }
    return { content: [{ type: 'text' as const, text: 'None of those items were found on the list.' }] };
  }
);

// ── Tool: set_family ────────────────────────────────────────
server.tool(
  'set_family',
  'Add or update a family member. Used for scaling recipe quantities and dietary requirements.',
  {
    name: z.string().describe('Name of the family member (e.g. "Tendai", "Mia")'),
    type: z.enum(['adult', 'child']).describe('Whether this person is an adult or child'),
    dietary: z.string().optional().describe('Dietary notes (e.g. "vegetarian", "no dairy", "allergic to nuts")'),
  },
  async ({ name, type, dietary }) => {
    const family = loadFamily();
    if (!family.members) family.members = [];

    const existing = family.members.findIndex((m: any) => m.name.toLowerCase() === name.toLowerCase());
    const member: any = { name, type };
    if (dietary) member.dietary = dietary;

    if (existing >= 0) {
      family.members[existing] = member;
      logAction(family, 'user', 'member updated', `${name} (${type}${dietary ? ', ' + dietary : ''})`);
    } else {
      family.members.push(member);
      logAction(family, 'user', 'member added', `${name} (${type}${dietary ? ', ' + dietary : ''})`);
    }

    saveFamily(family);
    const total = family.members.length;
    return { content: [{ type: 'text' as const, text: `${existing >= 0 ? 'Updated' : 'Added'} ${name} (${type}${dietary ? ', ' + dietary : ''}). Family size: ${total}.` }] };
  }
);

// ── Tool: view_family ───────────────────────────────────────
server.tool(
  'view_family',
  'View all family members, their types, and dietary requirements.',
  {},
  async () => {
    const family = loadFamily();
    const members = family.members || [];
    if (members.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No family members configured yet. Use set_family to add members.' }] };
    }

    const adults = members.filter((m: any) => m.type === 'adult');
    const children = members.filter((m: any) => m.type === 'child');
    const lines = members.map((m: any) =>
      `- ${m.name} (${m.type})${m.dietary ? ' — ' + m.dietary : ''}`
    );
    return { content: [{ type: 'text' as const, text: `**Family** (${members.length}: ${adults.length} adults, ${children.length} children)\n${lines.join('\n')}` }] };
  }
);

// ── Tool: remove_family_member ──────────────────────────────
server.tool(
  'remove_family_member',
  'Remove a family member.',
  {
    name: z.string().describe('Name of the family member to remove'),
  },
  async ({ name }) => {
    const family = loadFamily();
    if (!family.members) family.members = [];

    const idx = family.members.findIndex((m: any) => m.name.toLowerCase() === name.toLowerCase());
    if (idx < 0) {
      return { content: [{ type: 'text' as const, text: `No family member named "${name}" found.` }] };
    }

    const removed = family.members.splice(idx, 1)[0];
    logAction(family, 'user', 'member removed', removed.name);
    saveFamily(family);
    return { content: [{ type: 'text' as const, text: `Removed ${removed.name}. Family size: ${family.members.length}.` }] };
  }
);

// ════════════════════════════════════════════════════════════
// Grocery intelligence — surfaces data produced by the daily
// price watcher + meal planner + watchlist editor. Read-mostly.
// ════════════════════════════════════════════════════════════

const DEALS_FILE      = join(DATA_DIR, 'grocery-deals-latest.json');
const MEAL_PLAN_FILE  = join(DATA_DIR, 'meal-plan-latest.json');
const WATCHLIST_FILE  = join(DATA_DIR, 'grocery-watchlist.json');

function loadJsonOr<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T; }
  catch { return fallback; }
}

// ── Tool: get_grocery_deals ────────────────────────────────
server.tool(
  'get_grocery_deals',
  'Get the latest grocery price-watcher snapshot — which items are at rock-bottom right now across Woolworths and Coles, plus the cart plan and whether free-delivery threshold is met. Reads ~/.claude-gombwe/data/grocery-deals-latest.json (written by the daily 06:00 cron).',
  {
    limit: z.number().int().min(1).max(50).default(20).optional().describe('How many rock-bottom items to list (default 20)'),
  },
  async ({ limit }) => {
    const cap = limit ?? 20;
    const report: any = loadJsonOr(DEALS_FILE, null);
    if (!report) {
      return { content: [{ type: 'text' as const, text: 'No grocery deals snapshot yet. Run `node scripts/grocery-watch.mjs` (or wait for the 06:00 cron).' }] };
    }
    const lines: string[] = [];
    lines.push(`Snapshot from ${report.generated_at || '?'}`);
    lines.push(`Rock-bottom: ${report.rock_bottom?.length || 0}  Eligible: ${report.eligible?.length || 0}  Waiting: ${report.waiting?.length || 0}  No data: ${report.no_data?.length || 0}`);
    const w = report.carts?.woolworths;
    const c = report.carts?.coles;
    if (w) lines.push(`Woolworths cart: ${w.items.length} items, $${w.total} ${w.free_delivery ? '✓ free delivery' : `(need $${(75 - w.total).toFixed(2)} more)`}`);
    if (c) lines.push(`Coles cart:      ${c.items.length} items, $${c.total} ${c.free_delivery ? '✓ free delivery' : `(need $${(50 - c.total).toFixed(2)} more)`}`);
    if (report.rock_bottom?.length) {
      lines.push('');
      lines.push('Rock-bottom right now:');
      for (const r of (report.rock_bottom as any[]).slice(0, cap)) {
        lines.push(`  • ${r.name} @ $${r.best?.price?.toFixed?.(2) ?? r.best?.price} (${r.best?.store}, ceiling $${r.max_price})`);
      }
      if (report.rock_bottom.length > cap) lines.push(`  … +${report.rock_bottom.length - cap} more`);
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }
);

// ── Tool: get_meal_plan ────────────────────────────────────
server.tool(
  'get_meal_plan',
  'Get the current 7-day dinner plan with per-person modifications, ingredients-to-buy, budget context. Reads ~/.claude-gombwe/data/meal-plan-latest.json. Generated weekly by the Sunday 17:00 cron; regenerate via `node scripts/meal-plan.mjs` if stale.',
  {},
  async () => {
    const plan: any = loadJsonOr(MEAL_PLAN_FILE, null);
    if (!plan) {
      return { content: [{ type: 'text' as const, text: 'No meal plan generated yet. Run `node scripts/meal-plan.mjs` (or wait for Sunday 17:00 cron).' }] };
    }
    const bc = plan.budget_context || {};
    const lines: string[] = [];
    lines.push(`${plan.days || 7}-day dinner plan from ${plan.from}  (generated ${plan.generated_at})`);
    lines.push(`Budget: $${bc.month_to_date_spent ?? '?'} spent / $${bc.monthly_target ?? '?'} target · daily allowance $${bc.daily_allowance ?? '?'} · plan implies $${bc.plan_implied_per_day ?? '?'}/day`);
    lines.push('');
    for (const d of (plan.dinners || [])) {
      if (d.status !== 'planned') {
        lines.push(`${d.date}: ${d.status === 'already-planned' ? 'already planned' : 'no pick'}`);
        continue;
      }
      const flag = d.over_daily_allowance ? ' ⚠over-budget' : '';
      lines.push(`${d.date}: ${d.name} — $${d.est_cost_aud}${flag} (${d.protein}/${d.veg_focus})`);
      for (const [m, mod] of Object.entries(d.modifications || {})) {
        lines.push(`  • ${m}: ${mod}`);
      }
      if (d.ingredients_needed?.length) {
        const need = (d.ingredients_needed as any[]).slice(0, 6).map(i => i.name).join(', ');
        lines.push(`  buy: ${need}${d.ingredients_needed.length > 6 ? ', …' : ''}`);
      }
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }
);

// ── Tool: get_watchlist ────────────────────────────────────
server.tool(
  'get_watchlist',
  'Show the grocery watchlist — the items the daily price-watcher polls across Woolworths and Coles. Each has a max_price ceiling, expected promo, and stockpile targets. Reads ~/.claude-gombwe/data/grocery-watchlist.json.',
  {
    category: z.string().optional().describe('Optional category filter (laundry, cleaning, personal-care, pantry, dairy-protein, frozen, bread, fruit-veg, kids-lunchbox, snacks, beverages)'),
  },
  async ({ category }) => {
    const wl: any = loadJsonOr(WATCHLIST_FILE, { items: [] });
    const items: any[] = wl.items || [];
    const filtered = category ? items.filter(i => i.category === category) : items;
    if (filtered.length === 0) {
      return { content: [{ type: 'text' as const, text: category ? `No items in category "${category}".` : 'Watchlist is empty.' }] };
    }
    const byCategory: Record<string, any[]> = {};
    for (const i of filtered) {
      (byCategory[i.category || 'other'] ??= []).push(i);
    }
    const lines: string[] = [`Watchlist: ${filtered.length} items${category ? ` in "${category}"` : ' across ' + Object.keys(byCategory).length + ' categories'}\n`];
    for (const cat of Object.keys(byCategory).sort()) {
      lines.push(`[${cat}]`);
      for (const item of byCategory[cat]) {
        lines.push(`  • ${item.name}  max $${item.max_price}  (promo ~$${item.expected_promo ?? '?'}, rrp $${item.expected_rrp ?? '?'})`);
      }
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }
);

// ── Tool: add_watchlist_item ───────────────────────────────
server.tool(
  'add_watchlist_item',
  'Add a new item to the grocery watchlist (so the price-watcher starts tracking it daily). Writes to ~/.claude-gombwe/data/grocery-watchlist.json.',
  {
    name:            z.string().describe('Display name (e.g. "Cold Power 4L"). Include size in the name.'),
    max_price:       z.number().describe('Your ceiling — the daily alert flags items at or below this.'),
    category:        z.string().describe('Category bucket: laundry, cleaning, personal-care, pantry, dairy-protein, frozen, bread, fruit-veg, kids-lunchbox, snacks, beverages, other'),
    search_terms:    z.array(z.string()).optional().describe('Search strings tried in order (default: just the name). Use multiple for cross-brand matching.'),
    expected_promo:  z.number().optional().describe('Typical half-price/promo (for context only).'),
    expected_rrp:    z.number().optional().describe('Typical RRP (for context only).'),
    target_stockpile:z.number().int().optional().describe('When buying on promo, top up to this many. Default 1.'),
    notes:           z.string().optional().describe('Free-form notes (e.g. "never substitute", "kids favourite").'),
  },
  async ({ name, max_price, category, search_terms, expected_promo, expected_rrp, target_stockpile, notes }) => {
    const wl: any = loadJsonOr(WATCHLIST_FILE, { items: [] });
    if (!wl.items) wl.items = [];
    // Overwrite if same name already exists
    const idx = wl.items.findIndex((i: any) => i.name.toLowerCase() === name.toLowerCase());
    const entry: any = {
      name, max_price, category,
      search_terms: search_terms?.length ? search_terms : [name.toLowerCase()],
      expected_promo: expected_promo ?? null,
      expected_rrp:   expected_rrp   ?? null,
      min_stockpile:  idx >= 0 ? (wl.items[idx].min_stockpile ?? 0) : 0,
      target_stockpile: target_stockpile ?? 1,
      ...(notes ? { notes } : {}),
    };
    if (idx >= 0) wl.items[idx] = entry; else wl.items.push(entry);
    writeFileSync(WATCHLIST_FILE, JSON.stringify(wl, null, 2));
    const family = loadFamily();
    logAction(family, 'user', idx >= 0 ? 'watchlist updated' : 'watchlist added', `${name} (max $${max_price})`);
    saveFamily(family);
    return { content: [{ type: 'text' as const, text: `${idx >= 0 ? 'Updated' : 'Added'} watchlist item: ${name} — max $${max_price} (${category}). Tomorrow's 06:00 cron will start polling it.` }] };
  }
);

// ── Tool: remove_watchlist_item ────────────────────────────
server.tool(
  'remove_watchlist_item',
  'Remove an item from the grocery watchlist by name. Case-insensitive substring match.',
  {
    name: z.string().describe('Name (or partial name) of the item to remove'),
  },
  async ({ name }) => {
    const wl: any = loadJsonOr(WATCHLIST_FILE, { items: [] });
    if (!wl.items) wl.items = [];
    const q = name.toLowerCase();
    const matches = (wl.items as any[]).filter(i => i.name.toLowerCase().includes(q));
    if (matches.length === 0) {
      return { content: [{ type: 'text' as const, text: `No watchlist item matched "${name}".` }] };
    }
    if (matches.length > 1) {
      const list = matches.map(m => `  • ${m.name}`).join('\n');
      return { content: [{ type: 'text' as const, text: `Multiple matches for "${name}". Be more specific:\n${list}` }] };
    }
    const removed = matches[0];
    wl.items = (wl.items as any[]).filter(i => i !== removed);
    writeFileSync(WATCHLIST_FILE, JSON.stringify(wl, null, 2));
    const family = loadFamily();
    logAction(family, 'user', 'watchlist removed', removed.name);
    saveFamily(family);
    return { content: [{ type: 'text' as const, text: `Removed: ${removed.name}` }] };
  }
);

// ── Start server ────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
