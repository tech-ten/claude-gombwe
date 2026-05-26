#!/bin/bash
# Batch 2 — Melbourne law firms. Same shape as batch 1: each lead carries a
# specific observable finding in the message field, so the AI SDR's first
# email leads with the finding (consultative tone) rather than a generic
# IT-services pitch.
#
# Rank-ordered. Comment out lower-priority lines to send a subset.
#
# Two researched firms (CKL Lawyers, Kelly & Chapman) are NOT queued here
# because they don't publish a direct email — see batch-2-legal.md for
# their phone numbers if you want to chase by call.

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

echo "Queueing 8 Melbourne law firms into $TABLE (rank-ordered)..."

# ── RANK 1-3: already-buyer signals + clear automation gap ─────────────
put "Stephen Prior (Prior Law)" \
    "info@priorlaw.com.au" \
    "outbound-legal" \
    "I had a look at Prior Law this week. You run five offices and around 18 lawyers across McKinnon, East Bentleigh and Gippsland, and the lawconnect.com listing shows you are on LEAP and LawConnect already (so the SaaS layer is in). What I noticed is that every enquiry still funnels through one info@ inbox with no published direct partner emails and no after-hours intake path. That is the triage bottleneck I would automate on top of your existing stack. Worth 20 minutes to walk through how. Separately, we are piloting an AI-intern workstream for SMB law firms (case review briefs, chronology builder, deadline extraction, first-cut file notes), with a free 30-day pilot for the first three Melbourne firms. Details at agentsform.ai/lawfirm-intern.html. Worth flagging if of interest."

put "KPA Lawyers" \
    "mail@kpalaw.com.au" \
    "outbound-legal" \
    "I had a look at kpalaw.com.au today. You have already adopted Justly as a client portal (top of the homepage), so the client-facing piece is in. What I noticed is that the contact surface still only publishes two department inboxes (mail@ and property@) with no named lawyers or direct emails. The SaaS layer is in, the routing layer is not. Worth 20 minutes to walk through the gap between the portal and the inbox. Separately, we are piloting an AI-intern workstream for SMB law firms (case review briefs, chronology builder, deadline extraction, first-cut file notes), with a free 30-day pilot for the first three Melbourne firms. Details at agentsform.ai/lawfirm-intern.html. Worth flagging if of interest."

put "Tony Kakkos (MST Lawyers Firm Manager)" \
    "tony.kakkos@mst.com.au" \
    "outbound-legal" \
    "I had a look at mst.com.au this week. Your Family Law and Wills pre-meeting questionnaires are HTML web forms with no visible automation tying the responses back to matter creation. With 22 lawyers and 10 Principals, the obvious cost is each lawyer retyping client data the form already collected. A clean integration into your matter management would save admin minutes per file. Worth 20 minutes to look at where the questionnaire data goes today and where it could go. Separately, we are piloting an AI-intern workstream for SMB law firms (case review briefs, chronology builder, deadline extraction, first-cut file notes), with a free 30-day pilot for the first three Melbourne firms. Details at agentsform.ai/lawfirm-intern.html. Worth flagging if of interest."

# ── RANK 4-6: solid finding, less proven buyer signal ──────────────────
put "Steve O'Dor (O'Dor Lawyers)" \
    "steve@odorlawyers.com.au" \
    "outbound-legal" \
    "I had a look at odorlawyers.com.au this week. You publish your direct email and run commercial, property, migration, IP and franchising out of one Ashburton office, and you are already PEXA-active for settlements. What I noticed is no online intake form, no client portal, and no after-hours path. A doing-well boutique without the ops layer that the practice has clearly outgrown. Worth 20 minutes to scope what the next layer looks like. Separately, we are piloting an AI-intern workstream for SMB law firms (case review briefs, chronology builder, deadline extraction, first-cut file notes), with a free 30-day pilot for the first three Melbourne firms. Details at agentsform.ai/lawfirm-intern.html. Worth flagging if of interest."

put "Malcolm Morris (Rotman & Morris)" \
    "malcolm@rotmanmorris.com.au" \
    "outbound-legal" \
    "I had a look at rotmanmorris.com.au today. You have three offices (Bentleigh, Caulfield North, Dromana) and nine fee-earners across them, and the only intake channel is a single 6-option Online Enquiry dropdown form. No client portal, no after-hours path, no matter-type routing. Every enquiry lands in shared inboxes. For a practice across three locations that is a real cost. Worth 20 minutes to look at routing and intake automation. Separately, we are piloting an AI-intern workstream for SMB law firms (case review briefs, chronology builder, deadline extraction, first-cut file notes), with a free 30-day pilot for the first three Melbourne firms. Details at agentsform.ai/lawfirm-intern.html. Worth flagging if of interest."

put "Peter Nevile (Nevile & Co.)" \
    "nevileco@nevile.com.au" \
    "outbound-legal" \
    "I had a look at nevile.com.au this week. Your Legal Health Check funnel is a smart lead-gen move, but every response from it drops into the same nevileco@ inbox with no direct partner emails published anywhere on the site. The front door scales, the intake plumbing behind it does not. For a 100 Collins St practice that is throwing away a lead-gen investment at the moment it converts. Worth 20 minutes to look at routing and triage. Separately, we are piloting an AI-intern workstream for SMB law firms (case review briefs, chronology builder, deadline extraction, first-cut file notes), with a free 30-day pilot for the first three Melbourne firms. Details at agentsform.ai/lawfirm-intern.html. Worth flagging if of interest."

# ── RANK 7-8: smaller firms, simpler findings ──────────────────────────
put "Andrew Lord (Lord Commercial Lawyers)" \
    "info@lordlaw.com.au" \
    "outbound-legal" \
    "I had a look at lordlaw.com.au today. Six-person commercial practice at 167 Queen St with zero direct lawyer emails published, every new-business enquiry hitting one shared info@ inbox. No booking layer, no client portal. For a commercial firm where the first hour of an enquiry is often the most billable, the lack of routing is costing you time. Worth 20 minutes to scope what intake automation would look like. Separately, we are piloting an AI-intern workstream for SMB law firms (case review briefs, chronology builder, deadline extraction, first-cut file notes), with a free 30-day pilot for the first three Melbourne firms. Details at agentsform.ai/lawfirm-intern.html. Worth flagging if of interest."

put "Keith R Cameron (Keith R Cameron Solicitors)" \
    "office@kcsolicitors.com.au" \
    "outbound-legal" \
    "I had a look at kcsolicitors.com.au this week. You are one of the few Hampton firms explicitly inviting after-hours appointments on the contact page, but the only mechanism is a contact form into one office@ inbox. Willingness to serve outside business hours without the tooling to actually do it. A simple after-hours intake flow (auto-acknowledge, route by matter type, prep the file before Monday morning) would close that gap. Worth 20 minutes to walk through. Separately, we are piloting an AI-intern workstream for SMB law firms (case review briefs, chronology builder, deadline extraction, first-cut file notes), with a free 30-day pilot for the first three Melbourne firms. Details at agentsform.ai/lawfirm-intern.html. Worth flagging if of interest."

echo
echo "Done. Within ~60s the SDR will queue them with the 2-7min jittered delay."
echo "Watch:"
echo "  tail -f ~/.claude-gombwe/logs/daemon-*.log | grep '\[sdr\]'"
