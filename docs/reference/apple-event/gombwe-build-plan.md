# Gombwe personal assistant build plan

## Product

Gombwe is the user's persistent personal assistant, hosted first on an existing Mac mini. Gombwe owns conversations, personal context, memory, skills, tools, schedules, workflows, permissions and action history. Phones are replaceable access points and sources of ordinary camera, microphone, screen and file input. Apple and Android hardware remain optional clients.

The current inference engine is the existing Claude Code runtime authenticated through the user's Claude Max subscription. This is intentional. Do not build model independence, alternative providers, local LLM hosting, paid inference APIs or paid media services in this release. Those are future work only after the existing assistant is polished and the owner explicitly reopens it.

The product claim is modest and testable: useful AI outcomes should not require buying a new AI phone, GPU or dedicated computer. A Mac mini may orchestrate work and call Claude; a phone may provide input; the result returns to the user. This does not claim that Claude Max inference is local, free, unlimited or private from Anthropic.

AgentsForm remains a separate agent-facing website and protocol project. Do not merge its identity or claims with Gombwe.

## Scope authority

Read these files before changing code:

1. [Complete Apple event matrix](apple-event-complete-matrix.md) — the 89-entry comparison of the event, including physical and platform limitations.
2. [Build scope CSV](gombwe-build-scope.csv) — the binding implementation decision for every matrix entry.
3. [Current capability audit](gombwe-current-capability-audit.md) — what repository source contains, what skills describe, and what was not verified.
4. [Apple AI inventory](apple-event-feature-inventory.md) — detailed AI feature references.
5. [Event transcript](Apple_Event_September_9th_2026.md) — primary extraction material.

Only rows marked `BUILD` or `BUILD_PARTIAL` are current implementation work. `DEFERRED_COST_CAPABILITY` means leave it for later because the present Claude Max setup does not establish a practical no-new-cost path. `GAP_ONLY` means record the difference and do not research, prototype or workaround it. `CONTEXT` means announcement, pricing or rollout information only. The CSV currently contains 20 build rows, 7 deferred rows, 53 gap rows and 9 context rows.

Do not treat a gap as a defect to solve. In particular, do not pursue clinical health accuracy, Health Age, readiness or longevity models, lab partnerships, absent sensors, new watch hardware, optical camera controls, secure sensor attestation, proprietary OS behavior, FaceTime replacement, modem/battery/display replication, or elaborate paired-device substitutes. Existing phones may provide straightforward camera, microphone or file input where that supports a build row.

## Current foundation and boundaries

Reuse the existing TypeScript gateway, CLI, web, Discord and Telegram channels, persistent sessions, task completion loop, cron scheduler, triggers, workflows, skill loader, family MCP tools, school/meal calendar skills, grocery and network tools, and Mac launch services. Preserve unrelated working changes.

The audit found these foundations are not proof of a finished product. The gateway needs a mobile security boundary; school-calendar behavior needs deterministic fixture tests; URL monitoring needs persisted snapshots; native mobile and practical voice layers need implementation. Fix only layers required by current scope. Do not replace the Claude runtime.

## Build sequence

1. **Mac mini and mobile boundary.** Use isolated development data and port. Add authenticated pairing, revocation, scoped mobile capabilities, reconnect/cancellation, notifications and host diagnostics. Do not expose unrestricted task or shell endpoints to phones. Build native iOS/Android clients when toolchains are available, beginning with text chat, status, history, source links, file/share input and pairing.

2. **Claude Max reliability.** Preserve subscription authentication and session continuity. Improve cancellation, reconnect, usage-limit handling, bounded retries, objective action receipts and failure reporting. Never add paid API fallback or silently reroute inference. Keep personal state, preferences, source-linked context, workflows, permissions, artifacts, export and deletion separate from transient Claude session state.

3. **School email to family calendar.** Convert the existing skill into a deterministic, fixture-tested pipeline. Handle sender detection, future parent actions, attachments, portal stubs, source references, deduplication, changed dates, cancellation, alarm rules and bounded calendar writes. Use synthetic mail/calendar fixtures first; no real personal writes in tests.

4. **Automations and web monitoring.** Compile natural-language requests into validated trigger/filter/source/action/destination/timezone/schedule/retry/approval definitions. Provide dry-run, pause, history and idempotent receipts. Replace prompt-only webpage monitoring with persisted snapshots, meaningful diffs and deduplicated notifications. Handle failures, redirects, login expiry, rate limits and hostile page content.

5. **Personal context and supported actions.** Add authorized mail, calendar, files and household sources with citations. Support recipes-to-lists, drafts, reminders, calendar proposals, supported deep links and existing family tools. Do not promise private Messages access, universal app control, system-wide dictation, stock Phone overlays or arbitrary keyboard automation.

6. **Practical voice and recap.** Use only speech and translation facilities already available through Claude Max or ordinary device/OS utilities. Support explicit user-started sessions, cancellation, transcripts, subtitles, text translation and transcript recap. Do not add paid speech/translation/media services or substantial new models. Unsupported capabilities remain documented gaps.

7. **Store preparation.** Prepare reproducible native builds, privacy disclosures, permission explanations, deletion/export behavior, reviewer instructions, demo mode and a safe reachable host. Recheck current store rules before submission. Do not submit, publish, purchase services or make external commitments without explicit owner authorization.

## Workers, testers and checkers

The lead owns contracts, scope CSV, build-state, integration and final evidence. Host/security owns pairing and containment. iOS and Android workers own their clients. Workflow owns school/calendar and web monitoring. Voice worker handles only current no-new-cost capabilities. QA/release owns fixtures, device tests, accessibility and store artifacts. Compatibility maintains the matrix and records gaps; it does not start health or hardware work.

Each worker claims paths before editing, makes small changes, runs focused tests and updates `docs/mobile/build-state.md`. If delegation is unavailable, proceed sequentially and record that fact. Never fabricate agents, tests, devices, credentials or integrations.

Acceptance requires an existing iPhone and ordinary Android client paired to the same Mac mini; the school workflow producing reviewed sandbox writes and receipts; honest recovery from Claude limits, login expiry, restart, offline phone, denied permission and dropped connections; restart-safe web monitoring; phone replacement preserving state; malicious-content containment; source citations; export/deletion/revocation; and measured voice limitations. Unsupported modalities must remain unavailable rather than simulated.

Report task success, action success, unwanted writes, latency, reliability, setup time and Claude usage. Do not claim superiority from model capability alone; demonstrate the same sourced task on existing hardware and report results.

At every resumption read `docs/mobile/build-state.md`, inspect the worktree and continue the next incomplete `BUILD`/`BUILD_PARTIAL` row. Do not reopen deferred or gap rows. Product completion requires practical build rows and release evidence; it does not require physical Apple parity or clinical validation.
