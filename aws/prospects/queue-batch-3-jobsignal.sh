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
    "outbound-jobsignal-broker" \
    "Service: Broker File Readiness pack. Workflow pain: brokers at Robert's scale hit the document-chase ceiling. Tuesday afternoons disappear into payslip collection, bank-statement summarisation, missing-doc chasing, lender-checklist prep. We deliver the prep layer so the licensed broker reviews a clean pack and lodges. Not credit advice, never client-facing without sign-off. Touch-2 should lead with the file-readiness pain and offer a small redacted-file pilot. Pricing is a scoping-call topic, do NOT include any dollar amounts in the email. Secondary observable (broken desktop header phone CTA, missing tel: scheme) is fine as a short PS only."

# ── RANK 2: Menzies Facility Services — facilities/cleaning, CEO ──────
put "Greg Springall (Menzies Group)" \
    "gregspringall@menziesgroup.com.au" \
    "outbound-jobsignal-fm" \
    "Service: Tender Response Acceleration sprint. Workflow pain: bid coordination buckles when internal inputs from Ops, HSEQ, Finance and Commercial arrive late, tenders go incomplete or slip past deadline. We deliver compliance matrix, response skeleton, missing-info register, clarification questions, draft response sections and a submission checklist within a tight turnaround. Menzies's team owns pricing, legal sign-off and commercial claims. Touch-2 should lead with the bid coordination pain and offer a sprint on one live RFT. Do NOT include any dollar amounts in the email. Secondary observable (CEO bio page still shows Avada template defaults, theme-fusion.com link, info@your-domain.com placeholder) is fine as a short PS only."

# ── RANK 3: Ethos Building & Restoration — insurance builder, founder ──
put "Aaron Hair (Ethos Building & Restoration)" \
    "aaron.hair@ethosbuilding.com.au" \
    "outbound-jobsignal-insurance-builder" \
    "Service: Claims Coordination pack. Workflow pain: insurance restoration creates messy operational data (photos, notes, scope updates, trade availability, insurer queries, customer updates) that coordinators turn into status updates by hand. We deliver claim summary, timeline, missing-info list, trade work-order draft, insurer update draft, customer update draft, next-action tracker. Not coverage, not liability, not scope decisions. Touch-2 should lead with the claim admin compression and offer either a single-claim pilot or a backlog sprint. Do NOT include any dollar amounts in the email. Secondary observable (no online claim intake, no insurer-facing portal, everything funnels into one enquiries@ inbox) is fine as a short PS only."

echo
echo "Done. Within ~60s the SDR will queue them with the 2-7min jittered delay."
echo "(Sends gated to Mon-Fri 9-17 Melbourne by the daemon — fine if you ran this in business hours.)"
echo "Watch:"
echo "  tail -f ~/.claude-gombwe/logs/daemon-*.log | grep '\\[sdr\\]'"
