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

function resolveDay(input: string): string | null {
  const now = new Date();
  const lower = input.toLowerCase().replace(/[^a-z0-9-]/g, '');

  if (['today', 'tdy', 'tonite', 'tonight'].includes(lower)) {
    return now.toISOString().slice(0, 10);
  }
  if (['tomorrow', 'tmrw', 'tmr', 'tomoz', 'tomo'].includes(lower)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
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
  return d.toISOString().slice(0, 10);
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
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/family/ingredients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meal, pantry, existing }),
    });
    const data = await res.json();
    return data.ingredients || [];
  } catch {
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
    const ingredients = await extractIngredients(meal, pantry, existing);

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

    return { content: [{ type: 'text' as const, text: `Added ${slot} on ${dayLabel(dk)} ${dk}: ${meal}` }] };
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

// ── Start server ────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
