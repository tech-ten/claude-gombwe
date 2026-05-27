#!/bin/bash
# Batch 3 — Melbourne SMBs identified via job-signal cohort.
# Same shape as batches 1 and 2: each lead carries one specific observable
# finding about their OWN business surface (NOT the job ad — the job ad is
# private signal of workflow pain, never referenced in the email).
#
# Rank-ordered. Comment out lower-priority lines to send a subset.
#
# See aws/prospects/melbourne-batch-3-jobsignal.md for sourcing + filter
# rationale, plus the 3 firms researched and dropped (Trivantage, Prebuilt,
# Pierce Building Services).

REGION=ap-southeast-2
TABLE=agentsform-leads

put() {
  local name="$1" email="$2" source="$3" message="$4"
  local id=$(uuidgen | tr 'A-Z' 'a-z')
  local ts=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
  aws dynamodb put-item --region $REGION --table-name $TABLE \
    --item "{
      \"lead_id\":  {\"S\": \"$id\"},
      \"ts\":       {\"S\": \"$ts\"},
      \"name\":     {\"S\": \"$name\"},
      \"email\":    {\"S\": \"$email\"},
      \"source\":   {\"S\": \"$source\"},
      \"message\":  {\"S\": \"$message\"},
      \"processed\":{\"BOOL\": false}
    }" >/dev/null && echo "  queued: $name  <$email>"
}

echo "Queueing 3 Melbourne SMBs (job-signal cohort) into $TABLE (rank-ordered)..."

# ── RANK 1: Loan Market Yarraville — broker, verified direct email ─────
put "Robert Taylor (Loan Market Yarraville)" \
    "r.taylor@loanmarket.com.au" \
    "outbound-broker" \
    "I had a look at your Yarraville site this week. The phone-number CTA in your desktop header is coded as a relative link (the href is the bare number, no tel: scheme) so on a desktop browser the most prominent contact element in your masthead silently does nothing when clicked. The footer and mobile-nav variants of the same number are correctly coded, so it is a stale template defect that has never been corrected, not a design choice. For a broker whose intake competes minute-by-minute with the next Google result, the highest-intent click on the page failing on desktop is real leakage. A 10-minute template patch fixes it. Separately, what we do for brokers at Yarraville's scale is automate the document collection, missing-doc chase and client follow-up that eats every Tuesday afternoon. Worth 20 minutes to walk through what that looks like at a one-broker shop."

# ── RANK 2: Menzies Facility Services — facilities/cleaning, CEO ──────
put "Greg Springall (Menzies Group)" \
    "gregspringall@menziesgroup.com.au" \
    "outbound-fm" \
    "I had a look at menziesgroup.com.au this week. Your own CEO bio page at menziesgroup.com.au/1540-2/ still shows the Avada/ThemeFusion template defaults in the sidebar — literally info@your-domain.com and a link to theme-fusion.com — and the URL slug is the auto-generated 1540-2 rather than greg-springall. The corporate team page lists 11 named executives but only your bio has a click-through and the click-through is broken. For a national operator pitching tenders in the schools, commercial and government space, that is the page a prospective client lands on when they Google your name from a bid pack. We do the kind of work that fixes those CMS hygiene gaps permanently across the leadership directory, plus the bid-coordination workflow plumbing that scales when tender volume grows faster than headcount. Worth 20 minutes to walk through."

# ── RANK 3: Ethos Building & Restoration — insurance builder, founder ──
put "Aaron Hair (Ethos Building & Restoration)" \
    "aaron.hair@ethosbuilding.com.au" \
    "outbound-insurance-builder" \
    "I had a look at ethosbuilding.com.au this week. For an insurance builder whose 24/7 emergency line is the first thing a loss adjuster or homeowner reaches for, your site has no online claim intake and no insurer or adjuster portal — the only digital pathway is a generic 4-field contact form funnelling everything into one enquiries@ inbox. Every new job, emergency make-safe through to large-loss, has to be re-keyed into your job management from a phone call or an email. For a 30-person operation running across VIC and the new QLD office, that intake gap forces manual triage and shows up as SLA risk on the insurer KPIs that drive panel retention. The lift we offer is structured intake plus an insurer-facing status portal that plugs into your existing job management. Worth 20 minutes to walk through what it looks like at Ethos's shape."

echo
echo "Done. Within ~60s the SDR will queue them with the 2-7min jittered delay."
echo "(Sends gated to Mon-Fri 9-17 Melbourne by the daemon — fine if you ran this in business hours.)"
echo "Watch:"
echo "  tail -f ~/.claude-gombwe/logs/daemon-*.log | grep '\\[sdr\\]'"
