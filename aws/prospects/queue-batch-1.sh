#!/bin/bash
# Drop the batch-1 prospects into agentsform-leads, each with a SPECIFIC
# observable finding in the "message" field. The AI SDR poller picks each
# up within ~60s and composes a personalised first email that LEADS WITH
# the finding, not a generic pitch.
#
# Each "message" is phrased so the AI's first email will sound like:
#   "I had a look at <business> — I noticed <finding>. <Why it matters>.
#    Worth 20 min to walk through how we'd fix it? Reply here or call."
#
# RANK-ORDERED. The bash array is in send-priority order so if you only
# want to fire the top N, comment out the rest.
#
# Usage:
#   chmod +x aws/prospects/queue-batch-1.sh
#   ./aws/prospects/queue-batch-1.sh
#
# To pace the send (recommended): comment out lower-priority entries,
# run the script, wait 24h, uncomment the next batch and run again.

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

echo "Queueing 12 prospects into $TABLE (rank-ordered, strongest opener first)..."

# ── RANK 1-4: strongest openers, send these first ──────────────────────
put "Dr Peter Fraser (Teeth, Mouth, Smile)" \
    "hello@teethmouthsmile.com.au" \
    "outbound-dental" \
    "I had a look at Teeth Mouth Smile this week. Your HealthEngine BOOK NOW link at healthengine.com.au/book/55910 renders as a loading placeholder that does not progress to a bookable interface, and the footer still reads copyright 2020 with the most recent blog from June 2023. Every patient clicking BOOK NOW expecting to pick a time is bouncing without booking. That is single most expensive UX failure on the site for a practice that does 20 years of Invisalign and on-site implant surgery."

put "Vlad M (Oz Lend)" \
    "vladm@ozlend.com.au" \
    "outbound-broker" \
    "I had a look at ozlend.com.au today. Your contact-page footer still carries the WordPress theme placeholder address (121 King St, Dameitta, Egypt) with a +25 phone number, alongside your real Bentleigh East details. Modern AI search assistants (ChatGPT, Perplexity, Google AI Overviews) increasingly cite footer addresses as the canonical business location. A placeholder there actively poisons your local SEO and credibility with anyone using those tools to find a Melbourne broker."

put "Providence Healthcare" \
    "ndisawareness@providencehealth.com.au" \
    "outbound-ndis" \
    "I had a look at providencehealth.com.au/referrals today. The page asks support coordinators to please fill the Referral form below, but the form itself does not render on the page. Coordinators land on a dead page and fall back to phone or email. For a 100-staff NDIS provider whose growth depends on coordinator referrals, a broken referral form on the exact page coordinators are sent to is an active leak."

put "Dr Joe Zhou (McKinnon Dental Care)" \
    "info@mckinnondental.com.au" \
    "outbound-dental" \
    "I had a look at mckinnondental.com.au this week. Your Make a Booking button takes new patients to a Centaur Portal sign-in screen that requires creating an account with a mobile number and password before they can see a single available time. Modern dental flows (HotDoc, Cliniko, Dentally) show available times first and ask for details last. Gating availability behind account creation is a measurable drop-off point for new patients comparing 3-4 practices."

# ── RANK 5-8: solid second-batch sends ─────────────────────────────────
put "Hide and Speech" \
    "hello@hideandspeech.com.au" \
    "outbound-ndis" \
    "I had a look at hideandspeech.com.au/contact today. Your form captures preferred days, time bands and clinic location (Caulfield or Surrey Hills), and then the same page tells the parent that all speech pathology and occupational therapy appointments must be made by contacting our clinic. The structured intake data you collect cannot then be used to schedule. Every enquiry still needs a phone-tag round trip with reception before a clinician's diary opens."

put "Dr Bashar Basmaji (Hampton Dental Surgery)" \
    "hamptondentalsurgery6@gmail.com" \
    "outbound-dental" \
    "I had a look at hamptondentalsurgery.com.au this week. Your Book an Appointment page is a 180-character message form, and the published contact email is a gmail.com address rather than a domain inbox. Both signal that bookings flow into a personal Gmail someone has to triage manually. No shared visibility, no audit trail, no auto-acknowledgement when reception is at lunch or on leave. For a 25+ year owner-operated practice that does sleep dentistry, that is below the operational bar of the patients you are targeting."

put "Sandeep Mutti (East End Finance)" \
    "sandy@eastendfinance.com.au" \
    "outbound-broker" \
    "I had a look at eastendfinance.com.au today. You are a sole broker handling a 60-lender panel, and every initial enquiry comes through the I Want To Refinance or I Want To Purchase popup with no calendar booking and no published response-time commitment. Refinancers comparison-shop two or three brokers in parallel; whoever replies first wins. A solo broker without an auto-acknowledgement loses the race the moment they are on another call."

put "Gavin Ma (Gavin Ma & Co)" \
    "info@gavinmaandco.com.au" \
    "outbound-broker" \
    "I had a look at gavinmaandco.com.au today. You offer both mortgage broking and accounting/SMSF services through one Enquire Now form with no routing. A borrower asking about a 700k loan and an SMB asking about their SMSF both land in info@. The first 30 seconds of a mortgage enquiry need to go to a broker, not an accountant. A single shared inbox means hot mortgage leads queue behind BAS questions."

# ── RANK 9-12: still legitimate, lower-priority ────────────────────────
put "Bright Start Kids Hub" \
    "info@brightstartkidshub.com.au" \
    "outbound-ndis" \
    "I had a look at brightstartkidshub.com.au today. Your 17-practitioner multidisciplinary clinic (10 speech paths, 2 OTs, psychologist, music therapist) runs every new-family enquiry through a single five-field contact form into info@. No waitlist signup, no service-area triage, no NDIS-plan-status question at intake. With 14 clinicians sharing one intake funnel, every new referral becomes a manual reception triage job. Capturing NDIS plan status and preferred discipline at form time would cut admin minutes per referral by half."

put "Dr Ornella Mourant (Brighton Dentist)" \
    "reception@brightondentist.net" \
    "outbound-dental" \
    "I had a look at brightondentist.net this week. The homepage still carries the July 2024 We have relocated! banner from the move to Suite 11, 3 Male St — nearly two years on. The About page does not mention the previous Carpenter Street address either. Patients who knew the Carpenter Street practice and Google the old address cannot verify you are the same business and assume Brighton Dentist has closed."

put "Dr Vicky Spanidis (Ormond Dental Care)" \
    "reception@ormonddentalcare.com.au" \
    "outbound-dental" \
    "I had a look at ormonddentalcare.com.au this week. The Contact Us page has a name/email/phone/message form but no online booking, so every appointment funnels through (03) 9578 1046 between 9 and 5. There is no after-hours auto-response on the form either. Patients searching for a dentist at 8pm convert to a competitor with HealthEngine or Centaur before Ormond opens at 9am the next morning."

put "DentalCare Carnegie" \
    "dentalcarecarnegie@gmail.com" \
    "outbound-dental" \
    "I had a look at dentalcarecarnegie.com.au this week. Your published contact email is a gmail.com address rather than a domain inbox, and bookings flow through a basic Squarespace contact form with no calendar visibility. Modern dental booking expectations from HotDoc, Dentally and Praktika make a contact-form-only flow feel dated to patients comparing your practice against neighbouring suburbs that show a live calendar."

echo
echo "Done. Within ~60s the SDR will start queueing them with the 2-7min jittered delay."
echo "Tail the daemon log to watch:"
echo "  tail -f ~/.claude-gombwe/logs/daemon-*.log | grep '\[sdr\]'"
echo
echo "Reminder: each prospect will get a personalised first email that LEADS with"
echo "the specific finding in their message field. Tone is consultative, not pitchy."
