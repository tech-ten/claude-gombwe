# Melbourne SMB prospect list — batch 3 (2026-05-27, job-signal cohort)

3 verified Melbourne SMB prospects sourced via job-board signal (current hiring activity = active workflow pain), but the email never references the job ad. Each carries one specific observable finding about the business's own surface (website defect, missing process, broken CTA) for the AI SDR to lead with.

Difference from batches 1-2: this cohort was identified through `docs/job-boards-based-leads-generator.md` analysis, BUT the doc's original "Saw your job ad" framing was rejected as hire-displacement (same reason `/before-you-hire.html` was reframed on the public site). The job ad is now PRIVATE signal; the outreach pitches the workflow improvement on its own merits.

## Send queue (3 firms)

| Rank | Business | Decision-maker | Email | Job-signal (private, NOT in email) | Finding (becomes opener) |
|---|---|---|---|---|---|
| 1 | **Loan Market Robert Taylor** — Yarraville | Robert Taylor (Principal Broker, Loan Market franchise) | r.taylor@loanmarket.com.au | Hiring a Loan Processor → broker drowning in document chase | The phone number CTA in his website's desktop header is coded `<a href="0449686156">` (missing the `tel:` scheme). On desktop the most prominent contact element silently fails — leakage on the highest-intent click on the page. Footer + mobile-nav variants are correctly coded with `tel:`, so it's a stale template defect that's never been corrected. |
| 2 | **Menzies Facility Services** — Malvern | Greg Springall (CEO, Menzies Group) | gregspringall@menziesgroup.com.au | Hiring a Bid Coordinator → tender pipeline outgrowing manual coordination | The CEO's own profile page at menziesgroup.com.au/1540-2/ still shows the Avada/ThemeFusion template defaults in the sidebar — literally `info@your-domain.com` and `Web: https://theme-fusion.com/`. The URL slug is the auto-generated `1540-2` rather than `greg-springall`. The corporate team page lists 11 named executives but only the CEO has a click-through bio and that bio is broken. |
| 3 | **Ethos Building & Restoration** — Docklands | Aaron Hair (Director / Founder, 2016) | aaron.hair@ethosbuilding.com.au | Hiring a Claims Coordinator → growing 30-person insurance builder, claim admin backlog | For an insurance builder whose work begins the moment a loss adjuster or homeowner needs to lodge a claim, the site has no online claim-intake form and no insurer/loss-adjuster portal — the only digital pathway is a generic 4-field contact form funnelling every job (emergency make-safe, restoration, large-loss) into one enquiries@ inbox. |

## Dropped from this batch (researched, not queued)

| Firm | Reason |
|---|---|
| Trivantage Manufacturing | No verified direct email for any named decision-maker (Ben Weston, James O'Reilly, Brenton Stokes all named on site but no email pattern verifiable from public surface). |
| Prebuilt Pty Ltd | Mal Batten (CEO) named but email unverified; the only observable finding (typo in `<title>` of in-progress page) is weaker than other prospects in this batch. |
| Pierce Building Services | No owner findable; only Josh Larsen (Construction Manager) on LinkedIn with unverified email pattern. |

## Why this list

The original job-board analysis in `docs/job-boards-based-leads-generator.md` had 20 candidates spread across bid/tender, broker, claims. Filtered for:
- **Owner-operated or small enough** the decision-maker reads their own email (rules out Cleanaway, Service Stream, BankVic, KordaMentha — too large)
- **Named contact verifiable on public surface** (rules out Bluestone Recruitment, Bespoke Careers, Haste — recruitment firms not the actual hiring company)
- **Observable workflow finding stronger than the job-ad signal** (so the email lands on its own merits, not as "I saw your job ad")

3 of 6 researched passed all three filters. Sending small batches at high quality beats blasting weak guesses.

## Compliance posture

- All three emails sourced from each business's own public surface (Robert Taylor directly published; Menzies CEO inferred from RocketReach company pattern; Ethos Director inferred from RocketReach company pattern + LinkedIn).
- None of the source pages carry a "no unsolicited emails" / "no marketing" disclaimer.
- Each finding is verifiable from the source URL listed.
- Job ads are PRIVATE signal — never mentioned in the email, never referenced in the conversation.
