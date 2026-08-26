# Nukkad

**The shop knows what you need before you do.**

Razorpay AI Buildathon 2026. Submission deadline **5 September 2026**.
Working days from 26 August: **ten**, not fourteen. Plan accordingly.

---

## 1. One paragraph

Household staple consumption is the most predictable demand curve in Indian
retail. Atta, chawal, dal, tel, cheeni, chai. Burn rate is close to a linear
function of household size and it barely moves month to month. Nobody models
it. Nukkad runs on a kirana's own WhatsApp number, predicts when each of its
regular households is about to run out, sends them the basket they usually
take, and takes the order back by voice or text in the language they already
use. The order is resolved against **that shop's catalogue** using the
**household's own reorder history**, stock is checked and substitutions
settled **before** the confirm card goes out, and the household taps once.
The same prediction engine, summed across two hundred households, tells the
shop what to stock a week early and pre-fills its own order to its
distributor, which is where a Razorpay collection link is genuinely wanted.

---

## 2. How we got here, honestly

This is the third framing. The first two were killed by our own research and
the reasons are worth recording, because a judge will probe them.

### Round 1, killed

Every idea reduced to "constrain the model so it stops hallucinating". That
is 2020 chatbot thinking wearing 2026 vocabulary.

### Round 2, killed: merchant payment non-events

The pitch: detect failed payments, expired links and halted subscriptions,
then nudge over WhatsApp. It died on three independent grounds.

**The judges already shipped it.** Razorpay Failed Payment Recovery has sent
WhatsApp, SMS and email retry links since **January 2023**. Payment Links
ship up to **three automated reminders**. Subscriptions auto-retry before
halting. And **Intelligent Revenue-Protect** launched at **FTX'26** with a
WhatsApp-led retention engine covering registration recovery, retry
management and churn prevention. That is the pitch, in the pitch's channel,
built by the judging panel. Demoing a company's own product back to them is
the worst possible room to be in.

**The AI was bolted on, and the ablation proved it.** Strip the LLM and what
remains is: webhook → Postgres → four SQL queries → a ~200-row error-code
lookup → rupee sums → a z-score per (bank × method × step). A merchant could
not tell the difference in the output. Worse, **Meta requires a pre-approved
template with fixed body text and numbered variable slots for every
business-initiated WhatsApp message**, so the model was mechanically barred
from writing the copy that was its entire stated job.

**Parts of the factual base were contaminated.** Payment links default to six
months, not 24 hours. Shopify does surface decline reasons under Payment
events. The 30% / 20% / 18% figures all trace back to the Razorpay blog post
announcing the product that fixes them.

One genuinely novel angle survived and is recorded in §4: pre-failure
interception inside the RBI 24-hour pre-debit window.

### Round 3, killed as scoped: Instagram seller chat-to-order

Willingness to pay has been measured and it failed. Dukaan: roughly 2,000 to
2,500 paying merchants against a base in the millions, two 30% layoffs, pivot
upmarket. Bikayi: 2.8M merchants cut. Khatabook MyStore and OkCredit OkShop
both shut. The claimed wedge, "we bypass the WhatsApp Business API gate", is
**factually false** because Meta's Limited Access tier onboards without
Business Verification and Coexistence preserves the number and chat history.
And at boutique order sizes a payment link makes the merchant **poorer**, see
§4.3.

### What survived

The mechanism, pointed at the one segment where the AI is load-bearing, the
data is predictable, and the Razorpay leg is wanted rather than tolerated.

---

## 3. The approach change

**Stop transcribing. Start ranking.**

Every serious attempt at conversation-to-order treats it as a speech problem:
hear the words correctly, then extract entities. That framing has a ceiling
nobody has beaten.

| system | result |
|---|---|
| Wendy's FreshAI | ~86% on a clean 40-item **English** menu |
| ConverseNow | 15–25% human handoff |
| Presto | ~70% human intervention, ended in an SEC enforcement action |
| McDonald's + IBM | switched off across 100+ stores |
| Slang.ai | best-reviewed in category, **refuses to take orders at all** |

Hinglish is strictly worse. Code-switching adds a 30–50% relative WER
penalty, and the best Indic models sit at 11–14% WER on noisy code-mixed
telephony. At those rates SKU, quantity and variant cannot all be right at
once. Everyone responds by making the model better, which is a difference of
degree.

**The change in kind:** constrain the decode to a closed, known catalogue and
condition it on the buyer's own reorder history. You never need to hear
"Aashirvaad Atta 5kg" correctly. You need it to **rank above 399
alternatives** given a fuzzy acoustic match plus a strong prior that this
household bought it in eleven of the last twelve cycles. Transcription errors
that are fatal to *extraction* are recoverable by *retrieval*, because the
answer is guaranteed to be in a small known set.

This is why open-menu drive-thru is unsolved and household rashan reorder is
solvable in ten days.

**Verified 26 August.** Real extraction call, `openai/gpt-oss-120b`:

```
IN : bhaiya do kilo aashirvaad atta, ek litre fortune tel aur paanch kilo cheeni bhej dena
OUT: 2 kilo  <- 'aashirvaad atta'
     1 litre <- 'fortune tel'
     5 kilo  <- 'cheeni'

IN : adha kilo haldi aur dedh kilo chawal, aur wo peela wala tel bhi
OUT: 0.5 kilo <- 'haldi'
     1.5 kilo <- 'chawal'
     1        <- 'peela wala tel'      <-- the whole thesis in one line
```

`peela wala tel` is a purely descriptive reference. No transcriber resolves
it. Only a catalogue ranker with a household prior can.

Two corollaries come free, and both are differences in kind rather than
degree:

1. **Confirmation goes to the BUYER, not the seller.** Every incumbent puts
   the review step on the shop owner, which destroys the labour saving,
   because reviewing a machine-drafted order against a voice note takes about
   as long as listening to the voice note.
2. **Stock check and substitution run BEFORE the confirm card.** Confirm
   first and you have to go back twice, and a demo that asks twice looks
   broken.

---

## 4. What we discovered about Razorpay

This section is the research record. Everything here was checked against
primary sources or tested live against the API.

### 4.1 What Razorpay already ships, so we do not rebuild it

| product | since | what it does |
|---|---|---|
| Failed Payment Recovery | Jan 2023 | WhatsApp / SMS / email retry links after a failure |
| Payment Links reminders | — | up to **three** automated reminders per link |
| Subscriptions auto-retry | — | retries before halting a subscription |
| Intelligent Revenue-Protect | FTX'26 | WhatsApp-led retention: registration recovery, retry management, churn prevention |

**Saying this out loud on stage is worth more than a feature.** "You already
do failed-payment recovery, link reminders and subscription retries, so I did
not build those." It signals we read the docs, not the marketing.

### 4.2 Why we use Payment Links and not Subscriptions

Not because Subscriptions is beta-locked, though it is. Because a variable
rashan basket **is not a subscription**.

1. **The amount changes every cycle.** Quantities move, prices move, and our
   own stock-out logic swaps brands. An RBI variable-amount e-mandate needs a
   max-amount cap **plus a 24-hour pre-debit notification** anyway, so you
   build a notify-and-confirm loop regardless.
2. **The buyer confirms the basket first**, and that confirmation *is* the
   accuracy mechanism. Once a human must confirm, there is nothing fixed left
   to auto-debit.
3. **Auto-debit inherits India's worst failure mode.** NPCI, August 2025:
   roughly **74% average business-decline on AutoPay across the top 50
   banks**, overwhelmingly insufficient balance, with **over 20 million
   mandates revoked monthly** on low balance. A link sent to someone who just
   tapped confirm has none of that.

**The line for judges:** a wholesale basket with stock-outs and udhaar is not
a subscription, it is a recurring conversation that produces a variable
invoice.

Activation facts confirmed from the docs: payment methods for Subscriptions
(cards, UPI, eMandate) **must be enabled by Razorpay support and cannot be
turned on from the dashboard**, and Subscriptions requires an upfront **₹5
token authorisation** which is auto-refunded.

### 4.3 The 0% MDR problem, and why the money sits one layer up

**Direct UPI has been 0% MDR by government mandate since January 2020.**
Routing a household's ₹800 rashan order through a ~2% gateway link makes the
merchant *poorer*. A payment link at household order sizes is a tax.

At **wholesale** order sizes with udhaar, invoice-linked collection is the
reason distributors keep khata books at all. So:

```
household -> kirana     FREE. generates the demand signal. cash or direct UPI.
kirana -> distributor   PAID. Razorpay link, real invoice, real udhaar.
```

The signal flows up, the money flows down, and one prediction engine runs
both. **This is the single most important structural decision in the
project**, and it is the answer to the killer question in §9.

### 4.4 Partial payment IS udhaar, and it needs no beta access

Confirmed against `POST /v1/payment_links`:

| parameter | what it does |
|---|---|
| `accept_partial` | boolean, lets the customer pay part of the link |
| `first_min_partial_amount` | minimum first instalment, in paise |
| `reference_id` | our invoice id, **must be unique per link** |
| `notes` | up to 15 key-value pairs, 256 chars each |
| `expire_by` | unix timestamp |
| `customer.contact` | buyer phone |
| `notify.sms` / `notify.email` | exist; **`notify.whatsapp` is not documented** |

We set `notify` to false on both and deliver the link **inside the WhatsApp
thread the buyer is already in**, which converts better than a cold SMS.

The `payment_link.paid` webhook carries **`amount_paid`, `amount_due` and
`partial_payment`**, so the ledger settles itself. A kirana pays ₹15,000
against a ₹34,000 invoice and the rest stays outstanding. **That is khata,
natively, in the standard API.**

### 4.5 Integration facts that cost time if you learn them late

- **Webhooks are signed with HMAC-SHA256 over the RAW body.** If Fastify
  parses and re-serialises the JSON, key order can shift and the signature
  fails for no visible reason. `apps/api/src/routes/razorpay.ts` registers a
  raw-body content type parser for exactly this.
- **Razorpay retries webhooks.** Every handler must be safe to run twice.
  The `WebhookEvent` table has a unique index on `(source, externalId)` and
  duplicate events short-circuit.
- **Test mode caps Payment Links at 30 per business.** Plenty for a demo,
  contact support if you need more.
- **Test keys need no KYC.** Live keys do.
- **Money is paise everywhere.** Razorpay's API is paise, so we store paise
  as integers and nothing converts at any boundary. There is no float money
  anywhere in this codebase.
- **`fee` includes GST** in settlement responses; tax is nested inside fee,
  not additive to it. Relevant if the distributor-side recon is ever built.
- Razorpay publishes **12 official MCP read tools**, useful for an agentic
  read layer, not needed for this build.

### 4.6 The one genuinely novel payments angle we are NOT building

For the record, because it is a good idea and a judge may ask what else we
considered.

Given ~74% of AutoPay declines are insufficient balance, **retrying an empty
account is arithmetically incapable of recovering that money**. Every
incumbent's lever is *when to retry*, which has zero addressable surface
against India's dominant failure class. Balance can only be influenced
**before** the debit, inside the mandatory **RBI 24-hour pre-debit
notification window**, plus mandate-date placement against the payer's salary
cycle at registration time.

That is a real difference in kind. It is also squarely inside Razorpay's
perimeter, and they can bundle it free. Roadmap slide, not a build.

---

## 5. WhatsApp and Meta constraints that shape the architecture

These are not deployment details. They dictate the design.

**The 24-hour session window is an architectural constraint.** A message sent
outside it is *business-initiated* and Meta requires a **pre-approved template
with fixed body text and numbered variable slots**. The model is mechanically
barred from writing it.

Therefore: **the knock is a dumb template, and all intelligence lives inside
the session** once the household replies. Everything in
`services/conversation/messages.ts` and `workers/nudge-scheduler.ts` is built
around this. Getting it wrong is a channel-access issue, not a style issue.

**The cap arithmetic works in our favour.** An unverified WhatsApp Business
Account sends **250 business-initiated conversations per rolling 24 hours**.
Verification unlocks 1,000 → 10,000 → 100,000 → unlimited. Crucially,
**replies inside the 24-hour window do not count toward that cap**.

So the knock costs one. The menu, the voice note, the stock check, the
confirm card and the payment link are all **free against the cap**. A shop
with 220 households never hits the ceiling on an unverified number.

**Other facts:**
- Twilio Sandbox needs **no Meta approval at all**. Live in minutes.
- Template approval is **usually under an hour**, sometimes a business day.
  It is a different, far lighter gate than Business Verification.
- **Sandbox sessions expire three days after joining, silently.** Both demo
  phones must re-send `join hung-cent` on the morning of the 5th.
- Sandbox has no interactive list picker, so the menu is **numbered text**.
  More robust on a low-end phone anyway.
- Meta restricts **general-purpose AI assistants** on WhatsApp (15 Jan 2026).
  Ours is a business-specific ordering assistant for one shop, which is fine.
  **Never describe it as "an AI assistant on WhatsApp" in submission copy.**
- Coexistence (May 2025) keeps the shop's number, app and chat history.

---

## 6. Infrastructure findings

### Groq

One key does ASR, chat and vision, because Groq speaks the OpenAI wire
protocol. Live model list pulled from the account on 26 August: **14 models**.

| use | model | note |
|---|---|---|
| ASR | `whisper-large-v3` | eval set |
| ASR fast | `whisper-large-v3-turbo` | live demo latency, ~$0.04/hr audio |
| LLM | `openai/gpt-oss-120b` | order segmentation |
| LLM fast | `openai/gpt-oss-20b` | alias suggestion |
| Vision | `qwen/qwen3.6-27b` | bills. faithful names, 5 images/req |
| Vision fast | `qwen/qwen3.8-27b` | ~25% faster, 3 images/req |

- **`llama-3.3-70b-versatile` is not on this account.** Do not code against it.
- **Llama 4 Maverick was deprecated 20 Feb 2026** in favour of `gpt-oss-120b`.
  Groq's vision models are the Qwen 3.x 27B pair, not Llama 4.
- Vision limits: **20MB per image, 2048 tokens per image, 131K context.**
- **Groq sits behind Cloudflare**, which rejects some default HTTP client
  fingerprints with `error code: 1010`. The OpenAI SDK sets a normal
  User-Agent so the app is fine; any raw fetch must set one.
- Whisper needs an **explicit language code**. Auto-detect flip-flops between
  `hi` and `en` mid-utterance on Hinglish and returns mush.

**Verified 26 August:** `qwen/qwen3.6-27b` parsed a 7-line wholesale supplier
bill with **100% accuracy** on every item, quantity, rate and total, in about
two seconds, returning integer paise directly.

### Whisper is worse on Hinglish, and that helps us

Whisper is measurably worse than Sarvam's codemix mode on code-mixed
Hindi-English. That is real. It also makes the ablation **stronger**.

The thesis is that transcription errors are recoverable by retrieval. A
noisier transcript pushes the `raw` row *down* while the
`plus-catalogue` row stays *up*. **The delta is the product.**

The line for judges: *"I used the weaker ASR on purpose. If this needed good
transcription it wouldn't be a system, it'd be a wrapper around Sarvam."*

Sarvam remains wired as an **optional** second engine, purely to add a row
saying ranking rescues both.

### Supabase

- The direct host `db.<ref>.supabase.co` is **IPv6-only**. It works on a Jio
  line at home and **dies on IPv4-only venue wifi**, ngrok hosts, Vercel and
  CI.
- Runtime therefore uses the **session pooler**, which answers on IPv4.
  Prisma migrations use `DIRECT_URL`.
- The project sits in **ap-northeast-2 (Seoul)**. Measured query RTT from
  India is **~296ms**. Eight serial queries is 2.4 seconds of pure database
  latency per message.
- Mitigations, in order: cache the catalogue in memory at boot; batch reads;
  recreate the project in **ap-south-1 (Mumbai)** for ~30ms. **The last one
  is nearly free while the schema is empty and gets more expensive daily.**

---

## 7. Architecture

```
packages/shared    channel contract, domain types, money (paise), HCES seeds
packages/db        prisma schema + client
apps/api           fastify. adapters, services, routes, workers
apps/web           next 16. landing, shop dashboard, judge simulator
apps/eval          the ablation harness. THE deliverable.
```

### The channel boundary

Every transport is an **adapter** over one contract. The conversation core
imports no transport SDK.

```
POST /wa/twilio  -> TwilioAdapter  --\
POST /wa/sim     -> SimAdapter     ---> InboundMessage -> core.handle() -> OutboundMessage[]
(later /wa/cloud -> CloudAdapter)  --/
```

This is why the judge-facing web simulator runs the **identical** pipeline as
a real phone. On stage: *"same webhook, same ranker, same ledger, only the
transport differs."* It also means the demo survives dead venue wifi, and a
judge who does not want to text a US sandbox number can still drive it.

It buys an expansion slide for free: SMS, Telegram and IVR become adapters,
not rewrites. Relevant, because plenty of kirana customers are on feature
phones.

### The message loop

```
template knock (business-initiated, dumb, template-only)
  -> household replies, 24h session OPENS
  -> numbered menu
  -> input: text | voice   (photo: see module 1)
  -> Whisper transcription
  -> LLM SEGMENTS, does not pick products
  -> catalogue-constrained ranking + household reorder prior
  -> stock check + substitution ranking      <- BEFORE the card
  -> ONE confirm/edit card to the BUYER
  -> on confirm: order + invoice
  -> [kirana->distributor leg] Razorpay link with accept_partial
  -> payment_link.paid webhook -> ledger settles, outstanding updates
```

### The prediction engine

Per `(household, SKU)`:

```
burn_rate     = quantity / days between purchases
depletion_day = last_purchase + (quantity / burn_rate)
confidence     widens when observations are few
```

**Cold start is solved with public data.** A new household of four gets
seeded burn rates from **MoSPI's Household Consumption Expenditure Survey**,
which publishes per-capita monthly quantities of cereals, pulses and edible
oil by state and by rural/urban. The agent is therefore useful on **order
number one**, not order number four. Cold start is what sinks every reorder
product, and "a public government survey" is a far better answer to a judge
than "we guessed".

`packages/shared/src/constants/hces.ts` currently holds **placeholders**.
Replace with the real HCES 2023-24 table on day 2 and cite it.

Aggregating upward: `kirana_demand(week) = Σ households depleting in window`.
Bottom-up demand sensing across a 220-household catchment. Nobody does this
at kirana scale in India.

### The autonomy ladder

The honest answer to "without human effort".

| tier | behaviour | who |
|---|---|---|
| 0 MANUAL | household messages when it wants | day one |
| 1 SUGGESTED | agent proposes, buyer taps once | **default** |
| 2 STANDING | *"order 6 ghante mein ja raha hai, rokne ke liye STOP"*. Silence sends it. | **earned** |
| 3 SILENT | locked staples basket under a rupee cap | locked SKUs only |

**Tier 2 is real autonomy** and it is legal. It is the RBI pre-debit
notification pattern applied to **orders** instead of debits.

The mechanic that lands with judges: **a household is only offered Tier 2
after the agent has predicted its basket correctly N times in a row.**
Autonomy is *earned by measured accuracy*, per household, and the number can
be shown climbing on stage.

Note the effort actually removed is **remembering and composing**, not
confirming. The remaining tap is what makes it accurate. Sell the tap.

---

## 8. Modules

### Module 1: shop onboarding and catalogue

**The bill is the catalogue.** This is the hero, not one option among four.

Typing 400 SKUs with name, subnames, price and stock at ~20 seconds each is
**over two hours** of a shop owner's evening. That wall kills every catalogue
product in this segment. Uploading six supplier bills is **five minutes**.

A bill also carries more than a product list:

```
name  -> the SKU
qty   -> stock received
rate  -> COST price, so margin is computable
date  -> restock cadence, per SKU
```

Three months of bills gives a catalogue **already ranked by volume**, a cost
basis, and the shop's own reorder rhythm with its distributor, which feeds
the kirana→distributor layer for free.

**The catch the alias layer exists to solve:** a bill carries the *trade's*
name, `AASHIRVAAD ATTA 5KG`. A customer says `atta bhejo`. That word is never
on the bill. Aliases are the bridge between trade language and household
language and are **the highest-leverage data in the system**.

Aliases are never typed from scratch:

1. **Suggested at import.** LLM proposes candidates, owner taps to keep or
   kill. `Aashirvaad Atta 5kg` → `atta, aata, gehu ka atta, chakki atta`.
2. **Learned from failure.** When the resolver is unsure and the buyer taps a
   disambiguation option, that is a **labelled example**. `peela wala tel` →
   Fortune Sunflower Oil, auto-added as an alias. The catalogue gets smarter
   every time it gets something wrong, and the before/after alias table after
   30 orders is a genuinely good thing to show.

**Prices:** the bill has *cost*, not *selling* price. Ask once for a default
markup percent, apply everywhere, edit exceptions inline. Prefer printed MRP
where present.

**Images:** deprioritised. The WhatsApp confirm card is text, so images add
media cost and latency and only help visual scanning of the dashboard. Wire
Open Food Facts as best-effort (open-licensed, though **Indian brand coverage
is patchy**), allow manual upload, spend zero demo time on it.

**Cut from module 1: voice catalogue entry.** Voice already exists on
WhatsApp for ordering. A second voice path on the surface that matters least
is duplicated work, and a shop owner setting up a catalogue is at a screen
where typing a correction is faster than speaking one. Roadmap slide.

Screens: landing, login, catalogue list with inline edit, **bill upload →
parse → review → commit**, alias review, stock adjust.

### Module 2: the household loop
### Module 3: the kirana forecast and distributor leg

Specified in §7. Built in that order.

---

## 9. Judges

### What they will genuinely respect

1. **A measured accuracy ablation on real merchant audio.** Four rows: raw
   ASR then extract, plus catalogue constraint, plus reorder prior, plus
   buyer confirmation. Almost no hackathon project has a measured number at
   all. This one directly answers the objection everyone in the room already
   has.
2. **That we did not rebuild what Razorpay ships.** Say it explicitly.
3. **Real voice notes from real households, named**, with the shop owner's
   own words about what they do with an order today.
4. **Showing a failure case on purpose.** Play the voice note it got wrong,
   show the top-k disambiguation tap, quantify the residual. Every
   voice-ordering company in history overstated this and one got an SEC
   action for it. Volunteering the error rate reads as engineering maturity.

### The killer question, memorise the answer

> *"The household pays cash or direct UPI at 0% MDR. Why does your payment
> link exist?"*

**Answer:** it doesn't, at that layer. The household layer is free and its
job is to generate the demand signal. The Razorpay link lives on the
kirana→distributor leg, where invoices are ₹8,000 to ₹50,000, terms are
udhaar, and `accept_partial` is exactly the khata mechanic. At household
order sizes a link is a tax and we say so.

### Second question to expect

> *"Why not Razorpay Subscriptions?"*

See §4.2. The answer is better than "I lacked access".

### What we own as weaknesses, unprompted

- Whisper is worse than Sarvam on Hinglish. Deliberate, see §6.
- The alias bridge is hand-seeded at first and only becomes self-improving
  after real traffic.
- Household-side willingness to pay is unproven and we are not charging there.
- Quick commerce removes the need to plan in metros. Our segment is the
  kirana's existing delivery relationship, not a new one.

---

## 10. Ten-day plan

**Day 1 — evidence only.** Ring ten kiranas and wholesalers. One question:
what did you do with your last twenty orders? Get the SKU list **with stock
levels**, and permission for 30+ real order voice notes.

**Day 2 — GO/NO-GO GATE, non-negotiable.** One real catalogue of 200 to 800
SKUs and 30+ real order inputs in hand, or the project changes. **Faking
these inputs is the precise mechanism that killed the last project.** Also:
replace the HCES placeholders with the real table.

**Days 2–4 — the ranking core and the eval harness, together.** The harness
is as much the deliverable as the model.

**Days 4–5 — Twilio ingestion and the buyer confirm card.** Recorded files
and the simulator. Do **not** put Meta onboarding on the critical path.

**Day 5 — depletion model with HCES seeding.**

**Day 6 — kirana weekly forecast view.**

**Day 7 — Razorpay layer.** Collection link per invoice, `accept_partial`,
webhook to ledger, part-payment recon. One day, done properly.

**Days 8–10 — ablation table, the deliberate failure case, rehearsal.**

Cut for now: Tier 3 silent mode, the full distributor side, auto image fetch,
voice catalogue entry, any dashboard chrome.

---

## 11. Setup state, 26 August

| item | state |
|---|---|
| Twilio account, sandbox | done. join code `join hung-cent` |
| Twilio inbound webhook | **still points at Twilio's demo echo bot** |
| Sandbox participants | household joined; **kirana phone must still join** |
| ngrok | **not set up.** `PUBLIC_BASE_URL` empty |
| Groq | done, verified, 14 models |
| Razorpay test keys | done |
| Razorpay webhook | secret generated; **not yet registered in dashboard** |
| Supabase | live, Postgres 17.6, pooler verified |
| Sarvam | optional, not configured |

**Rotate the Twilio auth token and Razorpay test secret after 5 September.**
They were pasted into a chat log.

---

## 12. Sources

Razorpay: [Subscriptions FAQ](https://razorpay.com/docs/payments/subscriptions/faqs/) ·
[Create a Standard Payment Link](https://razorpay.com/docs/api/payments/payment-links/create-standard/) ·
[Payment Links webhooks](https://razorpay.com/docs/webhooks/payment-links/)

Twilio / Meta: [WhatsApp Sandbox](https://www.twilio.com/docs/whatsapp/sandbox) ·
[Media Basic Auth](https://support.twilio.com/hc/en-us/articles/223183748-How-to-Protect-Media-Access-With-HTTP-Basic-Authentication) ·
[Messaging limits 2026](https://www.uptail.ai/blog/whatsapp-business-message-limits-2026-broadcast-caps-tier-progression-what-happens-when-you-hit-the-ceiling)

Groq: [Supported models](https://console.groq.com/docs/models) ·
[Vision](https://console.groq.com/docs/vision) ·
[Deprecations](https://console.groq.com/docs/deprecations)

Sarvam: [Saaras v3](https://docs.sarvam.ai/api-reference-docs/models/saaras)
