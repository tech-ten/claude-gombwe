---
name: meals
description: View weekly meal plan, grocery list, pantry, recipes, the 7-day dinner plan, and today's grocery deals
version: 1.1.0
user-invocable: true
direct: true
tools:
  - name: view-all
    type: shell
    description: Show this week's meals, grocery list, and pantry
    command: "node ../../scripts/meals-view.mjs all"
  - name: view-week
    type: shell
    description: Show this week's meal plan only
    command: "node ../../scripts/meals-view.mjs week"
  - name: view-grocery
    type: shell
    description: Show the current grocery list
    command: "node ../../scripts/meals-view.mjs grocery"
  - name: view-pantry
    type: shell
    description: Show pantry / in-stock items
    command: "node ../../scripts/meals-view.mjs pantry"
  - name: view-recipes
    type: shell
    description: Show all saved recipes (from the unified recipes.json — breakfast + lunch + dinner with metadata)
    command: "node ../../scripts/meals-view.mjs recipes"
  - name: view-plan
    type: shell
    description: Show the current 7-day dinner plan, honouring dietary constraints + budget. Auto-regenerates if the plan is older than 3 days.
    command: "node ../../scripts/meals-view.mjs plan"
  - name: view-deals
    type: shell
    description: Show today's grocery deals snapshot — rock-bottom items, free-delivery cart status across Woolworths + Coles.
    command: "node ../../scripts/meals-view.mjs deals"
  - name: regenerate-plan
    type: shell
    description: Force-regenerate the 7-day dinner plan from current pantry + deals + budget. Use when the user changed prefs or wants a fresh plan.
    command: "node ../../scripts/meal-plan.mjs"
---

# Meals

Show the family meal plan, grocery list, pantry status, recipes, the 7-day
dinner plan, and today's grocery deals.

When the user types `/meals` with no arguments, use **view-all** to show the
full week/grocery/pantry overview.

For specific asks:
- "what's for dinner" / "this week" → **view-week**
- "what do we need" / "grocery list" → **view-grocery**
- "pantry" / "what do we have" → **view-pantry**
- "what can we cook" / "recipes" → **view-recipes** (now includes per-kid
  modifications, cost estimates, diet tags from the merged dinner-bank)
- "next week's meals" / "dinner plan" / "meal plan" → **view-plan**
- "what's on sale" / "deals" / "any specials" → **view-deals**
- "remake the plan" / "fresh meal plan" → **regenerate-plan**

Present the output as-is — it's already formatted. No need to rewrite or
summarise.
