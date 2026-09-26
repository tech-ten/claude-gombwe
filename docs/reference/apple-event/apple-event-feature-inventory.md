# September 9, 2026 event: AI feature inventory and Gombwe feasibility

Prepared September 11, 2026. Primary extraction source: [user-supplied transcript](Apple_Event_September_9th_2026.md). Timestamps below refer to that transcript. These are transcript claims, not independent measurements. Scope revised to the AI experiences only: new announcements, reiterated capabilities, and later releases. Hardware specifications, accessories, commercial offers, and unrelated OS features are excluded; inclusion does not mean available today. Similarity to Gombwe or AgentsForm is not evidence of copying.

> Scope update: this remains an extraction reference. The [complete matrix](apple-event-complete-matrix.md) and [build-scope CSV](gombwe-build-scope.csv) now control implementation. Health, clinical accuracy, hardware and impractical device-specific work are GAP_ONLY: record them, do not build or research alternatives. Earlier feasibility suggestions below are not assignments.

> Current-release constraint: keep the existing Claude Max-backed runtime. Paid inference APIs, provider independence and local LLM deployment are deferred. The complete matrix/CSV supersede earlier alternative-provider suggestions.

## Assessment

The defensible product is a personal assistant whose interface runs on existing supported phones and whose computation runs on the user's chosen host or model service. Buying a GPU or new AI computer is not a prerequisite. Existing compute or metered cloud access may be sufficient; dedicated local compute can still be useful for offline operation, latency, sustained utilization and keeping inference away from third parties. Many demonstrated AI outcomes fit this architecture. Universal hardware support, unrestricted access to other apps, equivalent offline performance, sensor capabilities, and Apple's hardware-backed privacy guarantees do not.

Apple itself describes a device/cloud hybrid at 04:22–05:48. Gombwe's distinction should be user-selected compute, models, data location, and portable workflows—not claiming to have invented remote inference. Self-hosting controls custody; it does not automatically make software secure. External inference sends the selected context to that provider. Encryption of transport does not hide inference inputs from the inference operator.

Classes: **S** = software outcome suitable for Gombwe; **P** = partial or conditional on public platform/provider APIs; **H** = the original AI mechanism depends on hardware/OS access that is not universally reproducible; **V** = validation/partnership required, beyond ordinary assistant implementation. S is feasibility, not a claim of existing implementation. Combined classes distinguish the outcome from the original mechanism. IDs are the implementation traceability contract. Gaps in numbering intentionally preserve IDs from the initial broader extraction; excluded IDs are not implementation requirements.

## Assistant and productivity

| ID | Time | Transcript feature | Class | Gombwe equivalent or limit |
|---|---|---|---|---|
| A01 | 04:22–08:51 | On-device foundation models plus stronger Private Cloud Compute models; personal context and ecosystem integration | S/P | Phone, owned host, or selected cloud routing. No claim of reproducing PCC security. |
| A02 | 09:24 | Retrieve and reconcile personal context across Mail and Messages, including relationships and earlier conversations | P | Authorized provider connectors and explicit imports; ordinary iOS apps cannot assume access to the Messages database or Mail's private store. |
| A03 | 09:44 | See what the user sees and combine visual context with current world knowledge | P | In-app camera, shared screenshot/document, search connector with citations. No silent global screen access. |
| A04 | 09:53 | Derive missing recipe ingredients and add them to a grocery list; Stuff integration | S/P | Source-grounded recipe/list comparison and supported list adapters; do not assume Stuff API access. |
| A05 | 10:02 | Actions across claimed 300,000 apps; WhatsApp messages and Audible playback | P | Publish an actually tested connector catalog. Deep links/composers/API actions where supported; no universal app-control promise. |
| A06 | 10:17 | Draft Outlook email; find Notability homework; save restaurant to Tripsy; developer adoption | P | Email API draft, authorized document search, travel list/API adapter; integration per service. |
| A07 | 10:17–10:40 | Voice and typed conversation, dedicated Siri app, history, new conversations, private cross-device sync | S | Native chat, voice, encrypted synchronized history with explicit key and server-access model. |
| A08 | 10:50 | Camera assistant extracts multiple events and adds them to calendar together | S/P | Photograph/import schedule → event preview → authorized batch writes with deduplication. |
| A09 | 11:03 | Writing and editing virtually anywhere, including drafting a soccer-coach email | P | In-app composer, share/action extensions, supported keyboard text operations. Not universal OS text replacement. |
| A10 | 11:12 | Expressive voices, multiple choices, customizable speaking pace and expressivity | S/P | Pluggable TTS; capability-gated controls and fallback voices. |
| A11 | 11:38 | More accurate system-wide dictation, punctuation, spelling and capitalization | P | In-app transcription/editing. System-wide dictation parity unavailable to ordinary iOS extensions. |
| A12 | 11:48 | Safari Notify Me: monitor a webpage and notify on changes | S | Host scheduler, meaningful-change diff, source snapshot, push notification. Authenticated sites require authorized sessions. |
| A13 | 11:48 | Describe a Shortcuts automation, including school email → calendar and reminders | S/P | Natural-language workflow → validated trigger/action specification, preview, enable/pause, host execution. |
| A14 | 11:48 | Business-call context, such as surfacing a flight confirmation code | P | User-invoked pre-call context card and supported dialer integrations. No promised injection into stock Phone UI. |
| A15 | 12:17 | Reimagined Image Playground: high-quality generation in almost any style | S | Capability-specific image providers; asynchronous jobs. Quality varies by selected model. |
| A16 | 12:29 | Improved Clean Up with complex-scene infill | S | Masked object removal/inpainting, original preserved. |
| A17 | 12:29 | Extend images beyond original bounds | S | Outpainting with explicit generated-region provenance. |
| A18 | 12:29 | Spatial Reframing changes apparent camera perspective after capture | P | Experimental generative viewpoint editing; cannot recover unseen ground truth or promise geometrical fidelity. |
| A19 | 12:29–13:24 | Intelligence in 16 languages; Siri English beta, five additional named languages in October; server usage limits and increased iCloud+ access | S/P | Language/capability matrix, per-provider usage/budget UI. These Apple rollout dates/entitlements are not Gombwe features. |

The named upcoming Siri languages are French, Japanese, Korean, Portuguese, and Spanish. The transcript does not enumerate all 16 Intelligence languages; do not invent that list.

## AI photography, video and media

| ID | Time | Transcript feature | Class | Gombwe equivalent or limit |
|---|---|---|---|---|
| C02 | 22:14 | Apply cinematic effects after ordinary video capture, including 60fps/half-speed effect | P | Segmentation/depth-based editing; quality and frame-rate limited by source and compute. |
| C04 | 22:14 | Audio Mix improves voices and adds music support | S/P | Denoising, source separation and remixing on selected host; capability/quality checks. |
| C06 | 23:26 | AI focus tracking maintains subjects through depth changes and exit/reentry | P | In-app detection/tracking plus supported focus APIs, measured on each device tier. |
| C07 | 23:26 | Reversible photographic styles, texture, grain, skin texture, combined color/texture adjustments | S | Non-destructive edit graph and reusable presets. |
| C08 | 23:26 | AI image-identification standard transcribed as “scenes ID” | P | Verify the intended standard before selecting implementation; keep this transcription uncertainty visible. |

## Headset AI experiences

| ID | Time | Transcript feature | Class | Gombwe equivalent or limit |
|---|---|---|---|---|
| E03 | 32:41 | Hands-free personal-context query, restaurant recall and walking directions | S/P | Foreground/authorized voice session with ordinary headset and mapping handoff; no guaranteed arbitrary wake word in background. |
| E04 | 33:04 | Live Translation, reiterated from previous fall | S/P | Streaming recognition → translation → speech/captions using phone/headset. Latency/network/language limits disclosed. |

## Health insights and audio intelligence

| ID | Time | Transcript feature | Class | Gombwe equivalent or limit |
|---|---|---|---|---|
| W02 | 39:26 | High-frequency heart-rate views/complications; HRV in overnight and new daytime Vitals view | S/P | Permissioned health dashboard showing provenance, missing data and timestamps. |
| W03 | 40:00 | Readiness from activity/vitals/sleep; four readiness states; morning and daytime updates; Watch/Fitness display | V/P | Explainable wellness trend experiment; no invented clinical equivalence or unvalidated score presented as fact. |
| W04 | 40:44 | Redesigned Health, Insights summaries, deeper readiness/fitness/heart views, dynamically personalized guidance | S/V | Source-grounded metric summaries; health recommendations need reviewed evidence and intended-use limits. |
| W05 | 41:26 | Health Age combining wearable metrics and blood biomarkers, habit contributions/improvement guidance | V | Separate research/validation project; do not ask an LLM to invent biological-age calculations. |
| W06 | 41:26–42:06 | Longevity tab across sleep/movement/heart etc., category shading and clinical-reference classifications | V/P | Explain metrics using versioned validated references and units; no fabricated clinical cutoffs. |
| W07 | 42:06 | Manual labs, medical-record sync, US Quest >50-biomarker panel for $119, lab/wearable combined analysis, expert videos | P/V | Import/OCR with confirmation and authorized records connectors. Ordering and licensed clinical videos require agreements. |
| W08 | 42:39–43:21 | Camera/Watch movement and mobility tests, injury-progress tracking; demonstrated VO2-max step test, trainer demo, beat, form cues, results/retesting | P/V | Pose-guided exercise prototype; VO2 estimation, recovery guidance and medical claims need validation. Camera alone is not equivalent measurement. |
| W09 | 43:21 | New Health app later this year, US English first | P | Rollout context; not already-shipped parity. |
| W10 | 44:32 | Sound recognition for sirens, alarms, doorbells, crying; Watch alerts without phone | P/H | Sound classifier during explicit listening session; independent wrist operation needs supported wearable implementation and battery tests. |
| W11 | 44:56–45:19 | Live Rewind: last 15s → transcript via crown double-press, Q&A and save to Siri app | P/H | Opt-in volatile audio buffer and explicit capture UI. Cannot promise Apple's secure buffer, crown binding or always-on availability. |
| W12 | 45:19–45:56 | Siri Recap ambient conversation notes: title, summary, key points; on/off, always/scheduled/work/not-night modes, Control Center | P | Explicit recording/listening sessions and approved background execution; user-visible state, scheduling constraints and deletion controls. |
| W13 | 45:56 | No stored audio recordings, inaccessible raw processing audio, no speaker attribution; end-to-end encrypted transcript/recap iCloud sync | P/H | Volatile buffer/no disk recording can be designed; ordinary process memory and remote ASR are not hardware-inaccessible. Define key access honestly. No diarization by default. |
| W14 | 46:41 | Siri modular face, Smart Stack top widget, past chats, invoke Siri, recaps, Shazam song recognition | P | Gombwe widgets/complications and licensed recognition integration; no replacement of Apple's face or assistant. |
| W15 | 46:41 | Rewind/Recap require Siri AI; beta later this year, English first | P | Dependency/release context, not universal availability. |

## Additional AI demonstrations

| ID | Time | Transcript feature | Class | Gombwe equivalent or limit |
|---|---|---|---|---|
| D10 | 01:04:21 | Detail content creation with on-device models via “core AI” | P | Selected host/model can process content; the transcript does not specify enough of Detail's workflow to claim exact parity. Verify SDK names before use. |
| D17 | 01:11:40 | Center Stage selfie experience | P | Optional in-app auto-framing using supported capture inputs. Sensor orientation and under-display hardware are excluded. |
| D21 | 01:13:29 | Smart Take tracks scene and automatically shoots when group is ready; full-body/wide-angle self portraits | P | Foreground pose/face-readiness capture with user-armed session; local lightweight detection preferred over remote shutter timing. |

## Existing Gombwe evidence and boundaries

Inspected `README.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `src/agent.ts`, and `skills/school-calendar-sync/SKILL.md`. These show a TypeScript gateway, CLI-backed agent runtime, sessions, schedules, triggers, workflows, and a concrete school-mail/calendar skill. The skill describes Mac-host Mail/Calendar access, actionable future events, family records, portal-stub reminders, deduplication and correction. This is useful implementation material, not evidence that Apple accessed it. It was already locally modified when inspected; preserve the user's changes.

The source runtime invokes Claude CLI with permission-skipping options. Do not expose that execution path directly to arbitrary mobile requests. A constrained mobile tool executor and model-provider abstraction are prerequisites. README/API descriptions are not proof that every integration works; test actual connectors.

## Platform evidence checked September 11, 2026

- [Apple's Duo announcement](https://www.apple.com/newsroom/2026/09/apple-unveils-iphone-duo/) corroborates the product context; the supplied transcript remains the extraction source for the inventory.
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/): public APIs, suitable background execution, and explicit disclosure/permission when personal data goes to third-party AI affect distribution. Recheck applicable rules at release.
- [Apple platform security](https://help.apple.com/pdf/security/en_US/apple-platform-security-guide.pdf): third-party access uses exposed services and system-provided background APIs; being installed does not grant access to every app's data.
- [EventKit access](https://developer.apple.com/documentation/eventkit/accessing-the-event-store): calendar/reminder access is permission-scoped; distinguish write-only flows from read/update flows.
- [Keyboard open access](https://developer.apple.com/documentation/uikit/configuring-open-access-for-a-custom-keyboard): keyboard extensions do not have microphone/speaker access. [Keyboard guide](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/CustomKeyboard.html) also describes secure-field restrictions.
- [Android background work](https://developer.android.com/develop/background-work): choose platform-approved background APIs; use the host for durable automation rather than relying on a perpetually alive phone process.
- [Google Play AccessibilityService policy](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en): do not build general autonomous cross-app agent control on AccessibilityService; the policy expressly restricts autonomous initiation/planning/execution.
- [Health Connect architecture](https://developer.android.com/health-and-fitness/health-connect/architecture) and [reading health data](https://developer.android.com/health-and-fitness/health-connect/read-data): health access, history and background reading have specific permissions. Permission does not validate medical interpretations.

This inventory is paired with the implementation-team prompt (retired 2026-09-27; superseded by docs/superpowers/specs/2026-09-27-muse-parity-design.md).
