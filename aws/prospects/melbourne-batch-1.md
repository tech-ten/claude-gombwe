# Melbourne SMB prospect list — batch 1 (2026-05-26, deep-research v2)

12 verified prospects across Melbourne SE, with ONE specific observable finding per business for the AI SDR to lead with. Every finding sourced from the business's own public site or a service they themselves point patients to.

Rank-ordered by opener-strength (top of list = strongest, most-likely-to-land cold email).

## Send priority

| Rank | Business | Finding (becomes opener) | Why it matters | Source |
|---|---|---|---|---|
| 1 | **Teeth, Mouth, Smile** (Dr Peter Fraser) — Brighton | Your HealthEngine booking link at healthengine.com.au/book/55910 renders as a loading placeholder that doesn't progress to a bookable interface, and your footer copyright is stuck at 2020 with the last blog post in June 2023. | Every patient who clicks BOOK NOW expecting to pick a time is bouncing without booking — single most expensive UX failure on the site. | healthengine.com.au/book/55910 ; teethmouthsmile.com.au |
| 2 | **Oz Lend** (Vlad M) — Bentleigh East | Your contact-page footer carries the WordPress theme placeholder address "121 King St, Dameitta, Egypt" with a "+25-506-345-72" phone alongside your real Bentleigh East details. | LLM search assistants (ChatGPT, Perplexity, Google AI Overviews) increasingly cite footer addresses as canonical business location — a placeholder there actively poisons local SEO and credibility. | ozlend.com.au/contact-us |
| 3 | **Providence Healthcare** — Mentone | Your Referrals page tells coordinators to "please fill the Referral form below" but the form itself doesn't render — referrers have to fall back to phone or email. | For a 100-staff NDIS provider whose growth depends on coordinator referrals, a broken form on the exact page coordinators are sent to is an active leak. | providencehealth.com.au/referrals |
| 4 | **McKinnon Dental Care** (Dr Joe Zhou) — McKinnon | Your "Make a Booking" button takes new patients to a Centaur Portal sign-in screen that requires creating an account with a mobile number and password before they can see a single available time. | A new-patient booking flow that gates appointment visibility behind account creation is a measurable drop-off point — most modern dental flows show availability first, take details last. | centaurportal.com/d4w/org-2992 |
| 5 | **Hide and Speech** — Caulfield South | Your contact form captures preferred days, time bands, and clinic location, then the page tells the parent "all speech pathology and occupational therapy appointments must be made by contacting our clinic" — so the structured intake data you collected can't actually be used to schedule. | You're doing the work of structured intake but throwing the data away — every enquiry still requires a phone-tag round trip with reception. | hideandspeech.com.au/contact |
| 6 | **Hampton Dental Surgery** (Drs Basmaji & Rosengarten) — Hampton | Your "Book an Appointment" page is actually just a 180-character message form, and your published contact email is hamptondentalsurgery6@gmail.com rather than a domain address. | Both signal that bookings flow into a personal Gmail inbox someone has to triage manually — no shared visibility, no audit trail, no auto-acknowledgement when reception is at lunch. | hamptondentalsurgery.com.au/book-an-appointment |
| 7 | **East End Finance** (Sandeep Mutti) — Glen Iris | You're a sole-broker operation handling 60 lenders, with no calendar booking on the site — every initial enquiry comes through the "I Want To Refinance / Purchase" popups with no published response-time commitment. | Refinancers comparison-shop two or three brokers in parallel; whoever replies first wins, and a solo broker without an auto-ack loses the race the moment they're on another call. | eastendfinance.com.au |
| 8 | **Gavin Ma & Co** (Gavin Ma) — Bentleigh | Your site offers both mortgage broking and accounting/SMSF services from one "Enquire Now" form with no routing — borrower asking about a $700k loan and an SMB asking about their SMSF land in the same info@ inbox. | The first 30 seconds of a mortgage enquiry need to go to a broker, not an accountant — a single shared inbox means hot mortgage leads queue behind BAS questions. | gavinmaandco.com.au/contact-us |
| 9 | **Bright Start Kids Hub** — Bentleigh East | Your 17-person multidisciplinary clinic runs every new-family enquiry through a single five-field contact form with no waitlist signup, no service-area triage, and no NDIS-plan-status question on intake. | When 14 clinicians share one intake funnel with no triage fields, every new referral becomes a manual reception job — capturing NDIS plan status and preferred discipline at form time would cut admin minutes per referral by half. | brightstartkidshub.com.au/contact |
| 10 | **Brighton Dentist** (Dr Ornella Mourant) — Brighton | Your homepage still carries the July 2024 "We have relocated!" banner from the move to Suite 11, 3 Male St — nearly two years on, and the About page doesn't mention the previous Carpenter Street address. | Patients who knew the Carpenter Street practice and Google the old address can't verify you're the same business — they assume Brighton Dentist closed and book elsewhere. | brightondentist.net ; brightondentist.net/about-us |
| 11 | **Ormond Dental Care** (Dr Vicky Spanidis) — Ormond | Your Contact Us page has a generic name/email/phone/message form but no online booking — every appointment funnels through (03) 9578 1046 between 9-5, with no after-hours auto-response on the form. | Patients searching for a dentist at 8pm convert to a competitor with HealthEngine or Centaur before Ormond opens at 9am the next morning. | ormonddentalcare.com.au/contact-us |
| 12 | **DentalCare Carnegie** *(substitute for Hatch FS)* | Your published contact email is dentalcarecarnegie@gmail.com rather than a domain address, and bookings go through a basic Squarespace contact form with no calendar visibility. | A Gmail-as-business-email signals manual triage to patients comparing practices — and modern dental booking expectations (HotDoc, Dentally, Praktika) make a contact-form-only flow feel dated. | dentalcarecarnegie.com.au |

## Disqualified

- **Hatch Financial Services** — merging into FMD Financial; the Hatch brand is being retired and Tim Gaspar has moved to Head of Lending at FMD. Source: hatchfs.com/announcement. Replaced with DentalCare Carnegie.

## Compliance posture

- Every email above was published by the business themselves on their own website (verified at time of compilation).
- None of the source pages carry a "no unsolicited emails" / "no marketing" disclaimer.
- Each finding came from public sources only — business's own site or a service they themselves link to.
- Suggested pacing: top 4 (ranks 1-4) tomorrow → wait 24 hours and check replies → next 4 the day after → remaining 4 day three. Avoids burst-send pattern from a young domain.

## Reading the AI's opener style

The AI SDR's system prompt will turn each "finding" into something like:

> Hi <Name>,
>
> I had a look at <business>. <Finding, paraphrased professionally>.
>
> If you'd like, I can do a free 20-minute walkthrough of how we'd fix it — and what else is sitting around in your stack that's eating staff time.
>
> Reply here or call 0401 156 266.
>
> Ellison

Tone is consultative-not-salesy because the opener is a real observation, not a pitch.
