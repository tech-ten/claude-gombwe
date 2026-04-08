---
name: meals
description: View weekly meal plan, grocery list, pantry, and recipes
version: 1.0.0
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
    description: Show all saved recipes
    command: "node ../../scripts/meals-view.mjs recipes"
---

# Meals

Show the family meal plan, grocery list, pantry status, and recipes.

When the user types `/meals` with no arguments, use **view-all** to show the full overview.

If they ask about a specific area:
- "what's for dinner" / "this week" → **view-week**
- "grocery list" / "what do we need" → **view-grocery**
- "pantry" / "what do we have" → **view-pantry**
- "recipes" / "what can we cook" → **view-recipes**

Present the output as-is — it's already formatted. No need to rewrite or summarise.
