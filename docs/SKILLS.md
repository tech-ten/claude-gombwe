# Skills

Skills are modular capabilities that extend what gombwe can do. Each skill is a directory containing a `SKILL.md` file.

## Format

```yaml
---
name: skill-name          # Lowercase, URL-safe. Used as the slash command.
description: What it does  # Shown in skill lists and autocomplete.
version: 1.0.0
user-invocable: true       # If true, users can type /skill-name to run it.
disable-model-invocation: false  # If true, exclude from model's prompt context.
tools:                     # Optional: native tools the skill can execute.
  - name: tool-name
    type: shell            # shell | http | script
    command: "df -h"       # For shell type
  - name: another-tool
    type: http
    url: "https://api.example.com/health"
    method: GET
  - name: script-tool
    type: script
    script: "check.sh"     # Relative to skill directory
---

# Markdown instructions

These instructions are passed to Claude when the skill is invoked.
Claude reads these to understand what to do and how to format the output.

If the skill has native tools, the tool outputs are executed by gombwe
first and the results are included in the prompt to Claude.
```

## How skills are loaded

Skills are loaded from these directories (later overrides earlier):

1. `~/.claude-gombwe/skills/` — user-installed skills
2. `./skills/` — project bundled skills (relative to working directory)

Skills are loaded on startup and can be reloaded via:
- REST API: `POST /api/skills/reload`
- Dashboard: Skills tab → Reload button

## How skills are invoked

When a user types `/email-digest` (from any channel):

1. Gateway's `handleCommand()` checks if "email-digest" is a known skill
2. If found, loads the skill's instructions
3. If the skill has native tools, executes them directly (shell commands, HTTP requests)
4. Passes instructions + tool results to `agent.runTask()`
5. Claude reads the instructions and produces the output
6. Result is sent back to the channel

## Native tools

Skills can define tools that execute directly without Claude:

### Shell tools
```yaml
tools:
  - name: disk-usage
    type: shell
    command: "df -h / | tail -1"
```
Runs the command via `child_process.execSync`. Output is captured as a string. 30-second timeout.

### HTTP tools
```yaml
tools:
  - name: check-api
    type: http
    url: "https://api.example.com/health"
    method: GET
    headers:
      Authorization: "Bearer xxx"
```
Makes an HTTP request via `fetch`. Response status + body captured. 

### Script tools
```yaml
tools:
  - name: run-check
    type: script
    script: "check.sh"
```
Runs a script file relative to the skill directory via `bash`. 60-second timeout.

### Why native tools?

Without native tools, checking disk usage would go through Claude:
```
Claude calls bash tool → runs df → thinks → responds
```
That's one full Claude invocation just to run `df -h`.

With native tools, gombwe runs `df -h` directly (instant, free), then only calls Claude once to analyze the results. Faster and saves subscription usage for the thinking part.

## Bundled skills

| Skill | Has native tools? | Needs MCP? |
|-------|-------------------|------------|
| email-digest | No | Gmail MCP |
| github-review | No | GitHub MCP |
| morning-briefing | No | Multiple |
| code-review | No | No |
| deploy-check | No | No |
| security-audit | No | No |
| system-health | Yes (4 tools) | No |
| git-digest | Yes (3 tools) | No |
| api-health | Yes (3 tools) | No |
| web-monitor | No | Fetch MCP |
| content-ideas | No | Brave Search MCP |
| meeting-prep | No | Calendar MCP |
| cleanup | No | No |

## Creating your own skill

1. Create a directory: `mkdir ~/.claude-gombwe/skills/my-skill`
2. Create `SKILL.md` with YAML frontmatter + instructions
3. Reload: `POST /api/skills/reload` or restart gombwe
4. Use: type `/my-skill` in any channel
