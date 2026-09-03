# Nukkad — System Reference

Every route, worker, and supporting service in one place, with file references. Companion to [PRD.md](./PRD.md). Where a subsystem has its own deep doc, this file gives the map and points there.

---

## 1. Complete HTTP / WS surface (`apps/api/src/routes/`)

Auth column: **session** = `requireSession(req)` on the handler's first line (401 without the `nukkad_session` cookie); **public** = no guard, protected by signature or by obscurity; **signed** = HMAC-verified payload.

### Conversation transports
| Method | Path | Auth | What it does |
|---|---|---|---|
| POST | `/wa/twilio` | public | Twilio WhatsApp webhook. Parses form-encoded payload, downloads media with Basic auth (Twilio media URLs expire in 4h — bytes are stored, never the URL), calls `handle()`, sends replies, logs `Message` rows both directions. |
| POST | `/evolution/webhook` | public | Evolution (unofficial WhatsApp) webhook. `MESSAGES_UPSERT` only; acks first and answers in `setImmediate`; resolves LID→phone; fetches media bytes via `getBase64FromMediaMessage`. See [CHANNELS-WHATSAPP.md](./CHANNELS-WHATSAPP.md). |
| POST | `/wa/sim` | public | Dashboard simulator inbound. Same `handle()`, replies queued to an in-memory outbox. |
| GET | `/wa/sim/outbox` | public | Drains simulator replies for the web UI. |
| POST | `/voice/turn` | public | One batch voice-note turn: audio → ASR → `handle()` → TTS. |
| POST | `/voice/warm` · `/voice/reset` | public | Pre-warms ASR/TTS/LLM endpoints (kills first-turn cold latency); resets the voice conversation. |
| GET | `/voice/stream` | public (WS) | The live voice session. See [VOICE-PIPELINE.md](./VOICE-PIPELINE.md). |
| POST | `/voice/stream/reset` | public | Clears live-session state between demos. |

### Money
| Method | Path | Auth | What it does |
|---|---|---|---|
| POST | `/rzp/webhook` | **signed** | The only inbound money path. Raw-body parser preserves bytes for HMAC-SHA256 verification against `RAZORPAY_WEBHOOK_SECRET`; bad signature → 400 before any DB work. Deduped by `x-razorpay-event-id` in `WebhookEvent`. Details in [PIPELINE-PHOTO-TO-PAYMENT.md](./PIPELINE-PHOTO-TO-PAYMENT.md). |

### Shop management (all **session**)
| Method | Path | What it does |
|---|---|---|
| GET/POST/PATCH/DELETE | `/catalogue`, `/catalogue/:skuId` | SKU CRUD for the signed-in shop. |
| POST | `/catalogue/:skuId/aliases` | Add a local name by hand. |
| GET | `/orders` | Last 60 orders with household, lines (incl. resolution method + confidence), invoice; computes `outstandingPaise`. |
| GET | `/orders/:orderId` | Order detail. `kiranaId` sits **in the WHERE clause** — a foreign order 404s rather than leaking. Adds per-line margin (`linePaise − costPaise×qty`, null when no cost basis), household average, substitution provenance, invoice + payments. |
| GET/POST | `/households` | Customer list and creation. |
| GET | `/shop/qr`, `/shop/connect` | WhatsApp connection state for the Connect page. |

### Bills onboarding (all **session**)
`POST /bills/parse` (upload + run the agent graph) · `GET /bills/:id/plan` (the review screen's data: lines, decisions, reasoning, candidates, disputes) · `POST /bills/:id/commit` (write catalogue + stock + cost basis) · `GET /bills` (history) · `POST /aliases/:id/approve` · `DELETE /aliases/:id`.

### Analytics & intelligence (all **session**)
`GET /analytics?month=YYYY-MM` (30-day series, revenue windows, month calendar, totals — IST-bucketed via a `+330min` offset) · `GET /analytics/day?date=YYYY-MM-DD` · `GET /analytics/insights` (7-day unmet demand grouped by `normalise()`, 30-day top products, stock ≤5) · `GET /analytics/demand/detail?q=` · `GET /analytics/product/detail?skuId=` · `GET /intel/attention` (≤3 cards) · `GET /intel/customers` · `GET /intel/customer/detail?householdId=` · `GET /intel/conversations` (last 120 `AgentEvent` rows) · `GET /intel/workforce` (30-day per-desk aggregation) · `GET/POST /intel/restock` + `POST /intel/restock/status`.

### Auth
`POST /auth/signup` · `POST /auth/otp` (10-minute TTL, hash = `sha256(otp + SESSION_SECRET)`) · `POST /auth/verify` (single-use OTP; sets `nukkad_session`: httpOnly, sameSite lax, 30-day HMAC-signed cookie) · `GET /auth/me` · `POST /auth/logout` · `GET /health`.

**Why `curl` gets 401 on intel endpoints:** the cookie is httpOnly and set only by `/auth/verify`; `verify()` recomputes an HMAC over the payload and compares with `timingSafeEqual`, then checks expiry. The web app succeeds because `apps/web/src/lib/api.ts` sends `credentials: 'include'` against `cors({origin: true, credentials: true})`. Note the **web-side guard is client-only** — `dashboard/layout.tsx` redirects on a failed `/auth/me`, but there is no `middleware.ts`, so the HTML shell is public and only the data is protected.

---

## 2. The bill agent graph (`services/bills/graph.ts`)

Nine nodes, each persisted as a `BillAgentStep` row (seq, node, OK/RETRY/FAIL/SKIP, ms, note, detail) so the review screen replays the run:

1. **extract** — vision reads the bill into raw lines (skipped when a reading is supplied by the caller).
2. **normalise** — Devanagari → Roman working form; skipped when already Roman.
3. **repair** — fixes obviously-broken cells before anything reasons about them.
4. **verify** — arithmetic conscience: re-derives `qty × rate` against the printed amount and the GST decomposition; disagreement forces the line to AMBIGUOUS with a `disputeNote`, because a misread digit on a handwritten bill doesn't look like an error, it looks like a price.
5. **retrieve** — pulls catalogue candidates for each line (the RAG step; see [RETRIEVAL-AND-RESOLUTION.md](./RETRIEVAL-AND-RESOLUTION.md)).
6. **reconcile** — decides RESTOCK / NEW / AMBIGUOUS / SKIPPED per line with a confidence and a one-sentence `reasoning`, storing every candidate with scores in `candidatesJson`.
7. **price** — computes `priceDeltaPaise` vs what the shop last paid and proposes `proposedSellPaise` by carrying the old margin forward, so a shop's own pricing survives a restock.
8. **alias** — proposes household subnames for each line, grounded in `ProductKb`.
9. **critic** — a final adversarial pass over the plan; skips itself when every restock was already near-certain.

Each node is individually disable-able for ablation runs, and each SKIP records *why* it skipped.

---

## 3. Prediction and the proactive knock

**`services/depletion/burn.ts`** — `seedHousehold()` writes one `BurnRate` per (household, SKU) from `HCES_URBAN_SEED`, the MoSPI Household Consumption Expenditure Survey, scaled by `memberCount`. This solves cold start: the agent is useful on order **one** instead of after three observed cycles, and "a public government survey" is a better answer to a judge than "we guessed". Seeds never clobber observed rates (`update: {}`).

`observePurchase()` updates from reality: `gapDays = max(1, (now − lastPurchaseAt)/86.4e6)`, `observed = lastQty / gapDays`, and once there are ≥2 observations it blends **0.6 × observed + 0.4 × previous** so one odd cycle can't throw the model; `seeded` flips false and `predictedDepletionAt = now + (qty / qtyPerDay) days`.

`dueForReorder(kiranaId, withinDays = 3)` finds households whose staples run out inside the window.

**`workers/nudge-scheduler.ts`** — one knock per household (not per SKU), suppressed if any nudge was sent in the last 3 days. Because a message outside Meta's 24-hour session window is business-initiated, **the model is mechanically barred from writing it**: the worker only fills numbered variables in the pre-approved `TEMPLATE_REORDER`. All the intelligence happens after the household replies and the session opens. Every knock writes a `Nudge` row carrying `predictedBasketJson`, which is later diffed against the order that actually followed — the depletion-accuracy row of the ablation table, generated by operation rather than assembled by hand. Runs dry by default: `tsx src/workers/nudge-scheduler.ts <kiranaId> [--send]`.

---

## 4. Cross-cutting services

**`services/telemetry/span.ts`** — per-turn profiling on `AsyncLocalStorage`. Built because the honest answer to "why does the voice agent take ten seconds" was a guess: a trace reading *ear 762ms, think 6492ms, first sound +10151ms* locates the problem inside "think", a word covering a policy call, a resolver, a composer, and a dozen-plus database round trips to a region 3,000km away. `profile(fn)` opens a turn; `span(name, fn, note?)` measures one step and records nothing when no turn is active (so scripts, crons and webhooks can call instrumented functions freely). AsyncLocalStorage rather than a module-level array because two simultaneous callers would otherwise pour timings into one bucket. Cost: one `Date.now()` and an array push — cheap enough to leave on permanently. It is also the skeleton of the event log: a span already knows what happened, in what order, and how long it took.

**`services/lang/romanise.ts`** — Devanagari in, Roman out, for the same reason `SARVAM_MODE=translit` exists: the resolver's normaliser strips everything outside `[a-z0-9]`, so a Devanagari transcript becomes an empty string that scores identically against every SKU. Measured: "आदा", "तेल" and "चाई पाड़ी" all resolved to Sugar 1kg at 0.30 — a confident wrong answer, not a visible failure. And it is a *separate step* on purpose, because asking Whisper for Roman directly makes it guess at English words instead of hearing Hindi phonemes. Measured on one clip: `language=hi` + transliterate → atta 0.40, tel 1.00, chai 0.99 (**3 of 3**); `language=en` direct → atta ✗, tel 0.57, chai ✗ (**1 of 3**). Hearing correctly and writing in the right alphabet are two jobs; doing them in one step does both worse.

**`services/catalog/cache.ts`** — in-process catalogue, stock and prior caches with explicit invalidation (`invalidateStock`, `invalidatePrior` fire on settlement). Removes most of the per-turn database round trips the span profiler exposed.

**`services/conversation/coalesce.ts`** — merges rapid-fire consecutive messages (the WhatsApp habit of sending five short lines) into one turn instead of racing five turns through the spine.

**`services/vision/image.ts`** — shared image prep for both photo readers, so the bill agent and the WhatsApp line are measured on the same input. Long edge capped at **1100px**: measured on the same invoice, 1357×1920 and 777×1100 both returned three lines with the total correct, in 1409ms and 1286ms — the extra pixels were paying rent and doing nothing. Re-encodes to **JPEG quality 88**, not PNG, because a phone photo re-encoded losslessly *grows* (one invoice went 85KB → 291KB for no gain). Exposes a `RateLimited` error type so a 429 is never mistaken for a reading failure.

---

## 5. Deployment topology

| Piece | Where | Port |
|---|---|---|
| API (Fastify) | `apps/api`, `npm run dev:api` | 3000 |
| Web (Next.js) | `apps/web`, `npm run dev:web` | 3001 |
| Public tunnel | ngrok (`PUBLIC_BASE_URL`) | — |
| Evolution gateway | `D:\nukkad\evolution-api` via portable Node 22 | 8080 |
| Database | Supabase Postgres (Seoul) | 6543 runtime / 5432 DDL |

Everything starts from the repo root with `npm run dev` (turbo). The API validates its entire environment at boot (`config/env.ts`) and exits with a printed list of problems rather than failing at 3am on stage.
