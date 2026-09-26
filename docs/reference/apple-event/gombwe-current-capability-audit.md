# Gombwe current capability audit

Prepared 11 September 2026 from repository source. This is a static inspection, not a claim of production reliability or a live test of the owner's Mac mini. No secrets, personal runtime data, live connectors, shopping carts, mailboxes, calendars, router controls or running services were accessed. No source was executed and no automated tests were run. References to Apple IDs use [the feature inventory](apple-event-feature-inventory.md); they denote comparable outcomes, not verified Apple implementation details.

**Gombwe already has the foundation of a persistent personal agent, but it does not yet deliver the promised model independence or mobile AI suite.** The strongest reusable parts are the host runtime, conversations, scheduling, workflow execution, family tools, and detailed Mac Mail/Calendar skills. Calling those skills tested product features would overstate the evidence.

> Scope correction: Claude coupling is intentional for the current Claude Max-backed release, not a defect to fix now. Multi-provider/local-model/paid-API work is deferred. The binding current assignments are in the scope CSV and implementation prompt; historical expansion suggestions below are not current work.

## Evidence levels

- **Code present:** an implementation exists and was inspected; behavior remains unverified in this audit.
- **Skill present:** instructions for an agent to execute, sometimes including shell/AppleScript examples. This is reusable workflow knowledge, not a separately tested connector.
- **Documented only:** a README/example claim depends on configuration or external integrations not established here.
- **Missing:** no relevant implementation found in the inspected main source/UI/skills tree; not a claim about uninspected personal scripts or other repositories.
- **Tested in audit:** none. A completion-loop verification prompt is not a deterministic test suite.

## Existing capabilities and Apple outcome overlap

Paths are relative to this document. Line pointers refer to the inspected working tree and may move with edits.

| Capability | Evidence/status | Apple overlap | Reuse and remaining work |
|---|---|---|---|
| Persistent host assistant; task queue, concurrent work, retry, continuation and model verification | Code present: [agent.ts](../../../src/agent.ts), lines 100–198 | A01, A05–A07, A13 | Reuse task/event concepts. Verification currently asks the model; add objective receipt-based action verification, durable jobs and constrained execution. |
| Typed web, Discord and Telegram conversation | Code present: [web.ts](../../../src/channels/web.ts), lines 8–36; [discord.ts](../../../src/channels/discord.ts), lines 14–46; [telegram.ts](../../../src/channels/telegram.ts), lines 27–84 | A07 | Existing remote interfaces, not native App Store apps. Add native pairing, push, media upload and mobile permissions. |
| Conversation history, separate sessions, continuation of Claude conversations | Code present: [session.ts](../../../src/session.ts), lines 17–84 | A02, A07 | Local JSON/JSONL history and Claude session IDs. Not a provider-neutral personal knowledge graph or encrypted cross-device replication system. |
| Cron jobs with timezone and enable/disable | Code present: [scheduler.ts](../../../src/scheduler.ts), lines 21–114 | A12, A13 | Reuse schedule model; exercise restart, overlap, timezone/DST, missed runs and action idempotency in tests. |
| Poll, file, URL, schedule and webhook trigger engine | Code present: [triggers.ts](../../../src/triggers.ts), lines 132–294 | A12, A13 | Polls and URL-change checks are model prompts. URL checking at 232–247 supplies no persisted baseline snapshot in that function; it is not yet a reliable content-diff monitor. |
| Multi-step conditional workflows, prior-output passing, notifications | Code present: [workflows.ts](../../../src/workflows.ts), lines 102–152 | A05, A13 | Reuse orchestration shape. Conditions and steps are text/model driven; add schemas, policy checks, retries, failure propagation and persisted step receipts. |
| Skill discovery, prompt inclusion, optional shell/HTTP tools | Code present: [skills.ts](../../../src/skills.ts), lines 16–97 and 104–130 | A05, A13 | Useful capability catalog seed. Shell tools inherit the process environment; replace unrestricted remote execution with scoped tool contracts. |
| School email → family events and Apple Family Calendar | Skill present: [school-calendar-sync](../../../skills/school-calendar-sync/SKILL.md), lines 18–28, 51–76, 78–160, 164 onward | A08, A13 | Concrete Mac Mail/AppleScript workflow, actionable deadlines, portal stubs/supersession, source subject and alarms. Existing know-how is valuable; build deterministic extraction schema, connector, deduplication and correction tests with synthetic mail fixtures. No live success verified. |
| Meal plan → shared Apple Calendar | Skill present: [meal-calendar-sync](../../../skills/meal-calendar-sync/SKILL.md), lines 10–38 | A13 | Retains Apple hardware/Calendar as a client of Gombwe. Preserve the explicit no-alarm behavior and add integration receipts. |
| Meal planning and missing-ingredient grocery-list insertion | Code present: [family MCP](../../../src/mcp/family.ts), lines 170–224; [gateway](../../../src/gateway.ts), line 2307 onward | A04 | Existing tools compare against pantry/current list and report extraction errors. Add uploaded-recipe/image source grounding and consistent quantities, units and transaction handling. |
| Shopping and household lists, pantry, recipes | Code present: [family MCP](../../../src/mcp/family.ts), lines 228–443 | A04, A05 | Reuse structured domain tools and data model; avoid treating local whole-file JSON writes as production multiuser storage. |
| Grocery deals/watchlist | Code present: [family MCP](../../../src/mcp/family.ts), lines 454–610; [grocery-watch.mjs](../../../scripts/grocery-watch.mjs) | A12 plus additional capability | Host-side shopping assistance exists; store-specific permissions, data freshness and execution require separate tests. |
| Grocery cart and checkout automation | Code present: [grocery-buy.mjs](../../../scripts/grocery-buy.mjs), lines 66, 345, 564, 676, 848 onward | A05 plus additional capability | Browser/store-specific adapter, not universal app control. Preserve explicit transaction authorization and use non-purchasing fixtures for initial tests. |
| Email triage and draft replies | Skill present: [email-digest](../../../skills/email-digest/SKILL.md), lines 10–24 | A02, A06, A09 | Provider access is external/configuration dependent. A prompt to read email does not establish a working connector. |
| Morning briefing and meeting preparation | Skill present: [morning-briefing](../../../skills/morning-briefing/SKILL.md), lines 10–30; [meeting-prep](../../../skills/meeting-prep/SKILL.md) | A02, A14 | Reuse intended output; add authoritative provenance, missing-data behavior and authenticated connectors. |
| Web monitoring and content ideas | Skill present: [web-monitor](../../../skills/web-monitor/SKILL.md), [content-ideas](../../../skills/content-ideas/SKILL.md) | A12 | Pair with deterministic fetch/snapshot/diff implementation rather than assuming natural-language monitoring proves changes. |
| External Gmail/Calendar/GitHub/Slack/search/memory integration | Documented only in [README](../../../README.md), Connecting Services section | A02, A05, A06 | README describes Claude MCP setup and capabilities. Availability/authentication are not verified; no blanket claim of built-in operational integrations. |

## Model-choice and privacy gaps

1. **The central runtime is Claude CLI coupled.** [agent.ts](../../../src/agent.ts), lines 239–260 and 358–383, launches `claude`, resumes Claude sessions, selects the configured Claude model and passes `--dangerously-skip-permissions`. [config.ts](../../../src/config.ts), lines 9–28, defaults to Claude Sonnet. An arbitrary model string does not provide a provider implementation.
2. **The OpenAI-compatible proxy does not call OpenAI or local models.** [proxy.ts](../../../src/proxy.ts), lines 7–16, 48–63 and 81–99, maps client model names—including GPT names—to Claude. Replace silent aliases with actual backend identities and tested adapters; do not market this proxy as existing frontier-provider choice.
3. **Coupling exists beyond the main runtime.** [policy-scanner.ts](../../../src/policy-scanner.ts), lines 144–152, launches a fixed Claude Haiku model; [agentsform-sdr.ts](../../../src/agentsform-sdr.ts), lines 282–289, launches Claude independently. Provider migration must find and cover every inference caller, while preserving AgentsForm as a separate product/workflow.
4. **The current gateway is a trusted-host control plane.** [gateway.ts](../../../src/gateway.ts), lines 102–108, creates HTTP/WS servers without authentication middleware there; line 216 accepts WS connections, line 2078 accepts task submissions, and lines 1248–1528 include mutating router controls. No request authentication/authorization guard was found in the inspected gateway. Default binding is loopback at [config.ts](../../../src/config.ts):11; this is not a safe public/mobile gateway merely by changing the bind address.
5. **Chat transport identity is not owner authorization.** Discord's message handler at [discord.ts](../../../src/channels/discord.ts):25 excludes bots but does not check an owner allowlist; Telegram's text handler at [telegram.ts](../../../src/channels/telegram.ts):30 likewise shows no owner allowlist. Add principal binding and capability grants before treating every received message as an authorized personal-agent request.
6. **Persistence is not encrypted by this implementation.** [session.ts](../../../src/session.ts), lines 29–35 and 68–75, writes ordinary JSON/JSONL. OS disk encryption may protect disks, but this code does not establish application encryption, key recovery or end-to-end sync. Self-hosted orchestration can still send inference inputs to Claude. Local inference requires an actual local backend and tests proving no network egress in local-only mode.

## Deployment evidence

[macOS LaunchAgent template](../../../deploy/launchd/com.gombwe.daemon.plist) specifies `start --headless`, KeepAlive and start at user login. Its comments explain reliance on the login session/keychain for Claude CLI subscription authentication. Those comments are deployment assumptions, not independently verified subscription entitlements or a claim that inference is free. [Linux systemd template](../../../deploy/systemd/gombwe.service) provides user-service startup and restart instructions. Neither template is proof of a cloud multi-tenant deployment, secure remote pairing, a mobile distribution pipeline or an installed local model server.

The Mac mini can remain the durable host and use existing Apple Mail/Calendar automation where granted. A separate phone/watch supplies microphone, camera, motion and health inputs. Hosting Gombwe on the mini does not make absent sensors appear, and remote inference does not reproduce privileged OS integration.

> Latest scope: the table below records missing capabilities for comparison. Only BUILD/BUILD_PARTIAL in [the scope CSV](gombwe-build-scope.csv) are assignments. Health, clinical accuracy, specialist wearable/camera work and impractical platform substitutes must not be pursued.

## Missing Apple-related product layers

| Needed layer | Apple IDs | Current evidence and next implementation boundary |
|---|---|---|
| Actual model providers, capability negotiation, local/remote routing, budgets | A01, A19 | Missing general provider abstraction, local inference backend and capability truthfulness. Build text/tools first, then vision/audio/image providers; forbid undisclosed fallback across privacy boundaries. |
| Native iOS/Android apps, secure host pairing, notifications and sync | A07 and every mobile experience | No Swift/Kotlin/native app project found in inspected main tree. Web/Discord/Telegram exist. Build supported OS/device matrix; do not promise literally every handset. |
| Vision input, image/screen/document context and personal retrieval | A02, A03, A08 | No unified media ingestion, OCR, image understanding or retrieval/index pipeline found. Skills provide some mail-context knowledge. |
| Voice/ASR/TTS, expressive controls, dictation, translation | A07, A10, A11, E03, E04 | No dedicated voice stack found. Remote/provider inference feasible; timing, offline support, microphone/background permissions require device tests. |
| Writing extensions and app actions | A05, A06, A09, A14 | Claude tool use and a few host integrations exist; native share/action extensions and per-app public API capability adapters are missing. |
| Image generation, inpainting, outpainting, viewpoint edits | A15–A18 | No dedicated image job/provider implementation found. Build asynchronous media jobs, original preservation and provenance. |
| Cinematic video, audio mix, focus tracking, styles, content credentials | C02, C04, C06–C08 | Missing dedicated media pipeline. Capture/lens controls need a phone/camera; postprocessing can run on selected compute. |
| Health data, readiness, lab import, longevity, movement assessment | W02–W09 | No HealthKit/Health Connect/clinical model integration found. Data ingestion is an engineering task; validity of scoring/medical interpretation is a separate evidence requirement. |
| Sound recognition, buffered rewind, recaps and encrypted transcript sync | W10–W13, W15 | No audio buffer, recording lifecycle, recap pipeline or cryptographic sync found. Explicit phone/watch capture plus Mac inference is a viable architecture, subject to OS execution limits. |
| Watch widgets/complications, history, song recognition | W14 | No watch app or recognition adapter found. Build permitted platform surfaces, not replacement of proprietary system faces/assistant controls. |
| Demonstrated content creation, auto-framing and Smart Take | D10, D17, D21 | No dedicated implementations found. Specify actual source workflow before claiming parity; use a sensor-equipped client for capture. |

## Additional Gombwe capabilities worth retaining

- Home network management: [network-service.ts](../../../src/network-service.ts), [mikrotik-client.ts](../../../src/mikrotik-client.ts), [eero.ts](../../../src/eero.ts), [nextdns.ts](../../../src/nextdns.ts), router schedules and device/profile pause controls. These depend on compatible authorized networking hardware/services, not a new AI phone.
- Local network observability: [dns-log-receiver.ts](../../../src/dns-log-receiver.ts), [netflow-collector.ts](../../../src/netflow-collector.ts), [mdns-listener.ts](../../../src/mdns-listener.ts), [snapshot-collector.ts](../../../src/snapshot-collector.ts), [history-rollup.ts](../../../src/history-rollup.ts), category enforcement and policy scanning. Code exists; sensor/feed availability and classification accuracy were not tested.
- Android/Google TV host control through ADB: [tv.mjs](../../../scripts/tv.mjs), lines 63–125 onward, plus [TV skill](../../../skills/tv/SKILL.md). This is a configured device adapter, not universal mobile app automation.
- Developer/operator skills: [code-review](../../../skills/code-review/SKILL.md), [github-review](../../../skills/github-review/SKILL.md), [git-digest](../../../skills/git-digest/SKILL.md), [security-audit](../../../skills/security-audit/SKILL.md), [system-health](../../../skills/system-health/SKILL.md), [api-health](../../../skills/api-health/SKILL.md), [deploy-check](../../../skills/deploy-check/SKILL.md), [cleanup](../../../skills/cleanup/SKILL.md). These are agent instructions, not tested independent services.
- AgentsForm lead polling, composing and email infrastructure exist in [agentsform-poller.ts](../../../src/agentsform-poller.ts), [agentsform-sdr.ts](../../../src/agentsform-sdr.ts) and [AWS components](../../../aws/). Preserve product separation; do not include external message sending in tests or implicitly activate those workflows for a personal-assistant build.

## Verification level and first build assignments

[package.json](../../../package.json) has build/dev commands but no test script. The discovered [test-woolworths.mjs](../../../scripts/test-woolworths.mjs) explicitly adds/removes live cart items (lines 102 onward and 433 onward); it was not run. No native project or dedicated offline automated test suite was found by the targeted file scan. This is an evidence gap, not proof that the owner's workflows have never worked.

Assign the first implementation team these bounded tasks before media breadth:

1. Preserve the existing Claude Max-backed CLI and session behavior. Improve reliability, cancellation, usage-limit handling and objective verification. No provider abstraction, alternative inference APIs or local LLM deployment.
2. Add a separate authenticated mobile API with device pairing, revocation and narrow family/calendar tools. Keep raw shell, router administration and unrestricted legacy task execution outside ordinary mobile capabilities. Add synthetic cross-user/unauthorized-action tests.
3. Convert school-calendar-sync knowledge into a structured pipeline using synthetic emails, event proposals, source IDs, timezone handling, deterministic deduplication, correction/supersession and connector receipts. Retain the Mac Mail/Calendar adapter as one option. Verify without touching the owner's real calendar first.
4. Ship one end-to-end native-client slice: submit a synthetic school email or shared schedule → selected Mac-host model → inspect event proposal → authorized sandbox calendar write → receipt and history. Pair an existing supported iPhone and Android device against the same host.
5. Replace prompt-only URL-change detection with persisted snapshots and deterministic change detection. Test restart behavior, noise suppression and notification deduplication.
6. Benchmark sourced tasks through the existing Claude runtime across devices and host conditions. Record success, unwanted writes, p50/p95 latency, inference cost and context egress. Future model choice is deferred; current usefulness must be demonstrated with results.

## Complete repository skill catalog

These 19 checked-in skill definitions are reusable agent instructions, not 19 verified standalone product integrations. Names and descriptions below come from their frontmatter; descriptions state intent, not audited success. Personal/home-directory skills and other repositories were not inspected.

| Skill | Declared purpose |
|---|---|
| [api-health](../../../skills/api-health/SKILL.md) | Check if your APIs and websites are up and responding |
| [cleanup](../../../skills/cleanup/SKILL.md) | Clean up and organize files, repos, or project structure |
| [code-review](../../../skills/code-review/SKILL.md) | Review code changes for bugs, security issues, and improvements |
| [content-ideas](../../../skills/content-ideas/SKILL.md) | Generate content ideas from trending topics in your niche |
| [deploy-check](../../../skills/deploy-check/SKILL.md) | Pre-deployment checklist — verify everything is ready to ship |
| [eero](../../../skills/eero/SKILL.md) | Manage the home eero network — pause/unpause kid profiles, view devices, check data usage |
| [email-digest](../../../skills/email-digest/SKILL.md) | Summarize unread emails grouped by priority, flag urgent ones |
| [git-digest](../../../skills/git-digest/SKILL.md) | Summarize recent git activity across your projects |
| [github-review](../../../skills/github-review/SKILL.md) | Review GitHub repos for issues, PRs, and action items that need attention |
| [grocery-order](../../../skills/grocery-order/SKILL.md) | Order groceries from Woolworths or Coles — search, compare, cart, pay, deliver |
| [meal-calendar-sync](../../../skills/meal-calendar-sync/SKILL.md) | Push the gombwe 7-day dinner plan into Apple Calendar Family so the household sees what's for dinner — no alarms, calendar visibility only |
| [meals](../../../skills/meals/SKILL.md) | View weekly meal plan, grocery list, pantry, recipes, the 7-day dinner plan, and today's grocery deals |
| [meeting-prep](../../../skills/meeting-prep/SKILL.md) | Prepare briefing notes and talking points for upcoming meetings |
| [morning-briefing](../../../skills/morning-briefing/SKILL.md) | Daily morning briefing combining calendar, email, tasks, and news |
| [school-calendar-sync](../../../skills/school-calendar-sync/SKILL.md) | Read iCloud Mail for ALL future school events, write actionable items to gombwe family.json AND Apple Calendar Family — alarms only for events within 14 days. Portal-stub notifications (Compass/Sentral "view news item" emails with no dates in the body) get added as same-day "check portal" prompts instead of being skipped. |
| [security-audit](../../../skills/security-audit/SKILL.md) | Scan code and dependencies for security vulnerabilities |
| [system-health](../../../skills/system-health/SKILL.md) | Check system health — disk, memory, CPU, running processes |
| [tv](../../../skills/tv/SKILL.md) | Control an Android / Google TV (e.g. TCL) over the network — set Private DNS to block YouTube and other apps, send keys, launch apps, reboot |
| [web-monitor](../../../skills/web-monitor/SKILL.md) | Monitor URLs for changes, price drops, or new content |
