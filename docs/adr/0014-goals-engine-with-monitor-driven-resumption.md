# 14. Goals run as tasks and resume when a monitor fires

## Status

Accepted, 2026-09-27.

## Context

Both announcements promise an agent that keeps working after the app is closed, and resumes when something in the world changes. Gombwe today runs one-shot tasks and cron jobs. A request that spans several actions or several days has nowhere to live, and a task interrupted by a restart is marked failed with no follow-up.

The hard part is not planning. It is waiting. Most multi-step household work stalls on something outside the house: an email reply, a price drop, a date arriving. Holding a model session open while waiting burns the subscription and dies on restart.

## Decision

A goal is a stored record with a title, an outcome, a status and a numbered plan. Claude produces the plan through a tool call, and the engine runs the next runnable step as an ordinary task with the goal and the memory context attached. A step that must wait attaches a monitor and the goal goes to `waiting`, holding no session. When the monitor fires the goal wakes and the next step runs. Steps needing approval block on the approval flow. On start, active goals re-queue their running step and waiting goals re-arm their monitors, which fixes today's silent failure. Each step completion posts one line to the originating channel. A goal is capped at 20 steps and 5 replans, then it asks the owner.

## Consequences

Long-running work survives restarts and costs nothing while waiting. Progress is legible as a plan with receipts. The engine is now the most stateful part of gombwe, and it depends on monitors being reliable.

## Alternatives considered

A prompt-only loop told to keep going. Rejected; it forgets, loops and cannot wait. Cron polling per goal. Rejected; monitors already do change detection properly. An external workflow engine. Rejected as too large a dependency.
