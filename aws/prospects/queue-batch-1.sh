#!/bin/bash
# Drop the batch-1 prospects into agentsform-leads. The AI SDR poller (running
# on the Mac mini) will pick each one up within ~60s and send a personalised
# first email after the 2-7min jittered delay.
#
# Each lead carries a short "message" field that gives the AI specific context
# to engage with on first contact — exactly like what a prospect would say if
# they'd filled the form themselves.
#
# Usage:
#   chmod +x aws/prospects/queue-batch-1.sh
#   ./aws/prospects/queue-batch-1.sh
#
# To pause sending: stop the gombwe daemon, or pre-emptively set ai_status
# to "human-handled" on each row.
#
# To send a SUBSET only, comment out the lines you don't want yet.

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

echo "Queueing 12 prospects into $TABLE..."

# Dental
put "Dr Vicky Spanidis"          "reception@ormonddentalcare.com.au"  "outbound-dental"  "QIP-accredited 25+yr practice in Ormond; HICAPS on-the-spot claiming"
put "Dr Joe Zhou"                "info@mckinnondental.com.au"          "outbound-dental"  "Owner-operator (founder of McKinnon Dental Care); digital X-rays, OPG, intraoral scanners; ex-Knoxfield Dental"
put "Dr Ornella Mourant"         "reception@brightondentist.net"       "outbound-dental"  "Principal at 3-dentist Brighton practice (Mourant/Richter/Rerksirathai); recently relocated to Suite 11, 3 Male St"
put "Dr Peter Fraser"            "hello@teethmouthsmile.com.au"        "outbound-dental"  "20-year Invisalign provider in Brighton; computer-guided implant surgery on site"
put "Dr Bashar Basmaji"          "hamptondentalsurgery6@gmail.com"     "outbound-dental"  "Hampton Dental Surgery owner-operator 25+ years at 6 Small St; sleep dentistry programme"

# Mortgage brokers
put "Gavin Ma"                   "info@gavinmaandco.com.au"            "outbound-broker"  "Owner of Gavin Ma & Co Bentleigh; hybrid mortgage-broking + accounting/SMSF practice"
put "Vlad M (Oz Lend)"           "vladm@ozlend.com.au"                 "outbound-broker"  "20 years brokering at Oz Lend Bentleigh East; 30+ lenders on panel; complex-credit and self-employed specialty"
put "Sandeep Mutti"              "sandy@eastendfinance.com.au"         "outbound-broker"  "Sole broker at East End Finance Glen Iris; 60 lenders on panel; independently owned"
put "Tim Gaspar"                 "info@hatchfs.com"                    "outbound-broker"  "Managing Director Hatch Financial Services Malvern East; 4-person team; medical/dental/legal client specialty"

# NDIS / paediatric allied health
put "Bright Start Kids Hub"      "info@brightstartkidshub.com.au"      "outbound-ndis"    "17-practitioner multidisciplinary paediatric clinic in Bentleigh East; 10 speech paths, 2 OTs, psychologist, music therapist"
put "Hide and Speech"            "hello@hideandspeech.com.au"          "outbound-ndis"    "Two-clinic paediatric allied health practice (Surrey Hills + Caulfield South); neuroaffirming-care speech path / OT / psychology"
put "Providence Healthcare"      "ndisawareness@providencehealth.com.au" "outbound-ndis"  "NDIS shopfront on Nepean Hwy Mentone; 24/7 complex support, support coordination, psychosocial recovery coaching"

echo
echo "Done. Within ~60s the SDR will start queueing them with the 2-7min jittered delay."
echo "Tail the daemon log to watch:"
echo "  tail -f ~/.claude-gombwe/logs/daemon-*.log | grep '\[sdr\]'"
