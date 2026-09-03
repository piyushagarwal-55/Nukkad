# Nukkad documentation

Written 28 August 2026. Start with the PRD; it links into everything else. These docs are self-contained: a person or AI with zero prior context should be able to read them and know the entire project. Every number in them is either quoted from source with a file reference or measured live against the running system — nothing is illustrative.

## Read in this order

| # | Doc | What it covers |
|---|---|---|
| 1 | **[PRD.md](./PRD.md)** | The master document: what Nukkad is, the problem, every module built, how a message flows, the multi-agent workforce, voice, WhatsApp, payments, bills, resolver, prediction, dashboard, models/services, testing, current status, demo plan. |
| 2 | **[PIPELINE-PHOTO-TO-PAYMENT.md](./PIPELINE-PHOTO-TO-PAYMENT.md)** | One real photo traced end to end — WhatsApp envelope → decrypt → vision → SKU mapping → basket → checkout rows → Razorpay link → settlement → dashboard. Real timings, real confidences, real row values, plus six verified gaps. |
| 3 | **[ARCHITECTURE-DECISIONS.md](./ARCHITECTURE-DECISIONS.md)** | The honest history: 24 decision records. Twilio → Evolution, one-agent → desks, every problem hit and the solution it forced. |
| 4 | **[CONVERSATION-ENGINE.md](./CONVERSATION-ENGINE.md)** | The multi-agent engine: 15 speech acts, the complete desk×act table, transfers, guards, director/composer, state, suites. |
| 5 | **[RETRIEVAL-AND-RESOLUTION.md](./RETRIEVAL-AND-RESOLUTION.md)** | How words become SKUs. Trigram RAG, the in-process ranker, every threshold and weight, the household prior, pack fitting, substitution — and why there are no embeddings. |
| 6 | **[VOICE-PIPELINE.md](./VOICE-PIPELINE.md)** | Sarvam STT/TTS: streaming config, the single turn door, per-desk voices, the one-socket speaker switch, the latency ledger. |
| 7 | **[DATA-AND-SUPABASE.md](./DATA-AND-SUPABASE.md)** | Every table and why it exists, the three connection routes, the pool incident, query surfaces, seeds and caveats. |
| 8 | **[CHANNELS-WHATSAPP.md](./CHANNELS-WHATSAPP.md)** | All six channels, the Twilio limit, the complete Evolution runbook, adapter contract, failure table. |
| 9 | **[EVALS-AND-MEASUREMENT.md](./EVALS-AND-MEASUREMENT.md)** | Every harness, dataset, metric formula and threshold; every committed result number; and which claimed numbers do not yet exist. |
| 10 | **[SYSTEM-REFERENCE.md](./SYSTEM-REFERENCE.md)** | Every HTTP/WS route with its auth guard, the nine-node bill agent, prediction and nudges, telemetry, caching, deployment topology. |

## If you only need one thing

- **"What is this project?"** → PRD §1–3
- **"How does it actually work?"** → PIPELINE-PHOTO-TO-PAYMENT, start to finish
- **"Why is it built this way?"** → ARCHITECTURE-DECISIONS
- **"Is it any good?"** → EVALS-AND-MEASUREMENT
- **"What's broken?"** → PIPELINE §"Known gaps", EVALS §"honest gaps", RETRIEVAL §"Corrections"
