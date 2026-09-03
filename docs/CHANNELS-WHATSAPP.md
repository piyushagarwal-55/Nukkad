# Nukkad — Channels & WhatsApp Transports

Deep reference for every way a customer reaches the shop, and the complete Evolution API runbook. The architectural rule (ADR-001): every channel is a thin adapter over the same `handle()` in `services/conversation/core.ts` — swapping transports is a one-file change.

## Channel inventory

| Channel | Adapter | Status | Notes |
|---|---|---|---|
| Dashboard simulator | `routes/sim.ts` + `apps/web/src/app/sim` | live | WhatsApp-style UI; demo without any external dependency |
| Twilio WhatsApp sandbox | `routes/whatsapp.ts` (`channels/twilio.adapter.ts`) | live, capped | Official; ~50 msgs/day; join-code onboarding; webhook retries deduped via `Message.externalId` + `WebhookEvent` |
| **Evolution API WhatsApp** | `routes/evolution.ts` | **live (dev transport)** | Unlimited volume; unofficial protocol; spare number only |
| Voice notes (batch) | `routes/voice.ts` | live | saaras:v4 → Shunya → Whisper fallback chain |
| Live voice | `routes/stream.ts` (WebSocket) | live | See [VOICE-PIPELINE.md](./VOICE-PIPELINE.md) |
| Typed test input | voice console `{type:'text'}` frame | live | Same `startTurn()` door as voice finals |

## Why Evolution exists (the Twilio problem)

Twilio's sandbox was the original WhatsApp transport: official, safe, and capped at ~50 messages/day — which a single test conversation spends before lunch. Building conversation quality needs hundreds of turns a day. Evolution API pairs a **real WhatsApp account** over the unofficial WhatsApp Web protocol (Baileys family): unlimited messages, no join codes, the actual WhatsApp UX in a demo. **The honest trade, stated where the code lives** (header of `routes/evolution.ts`): this violates WhatsApp's ToS and Meta does ban numbers that use it. Therefore: paired to a **spare number, never a personal one**; a development harness only; the production story remains an official API (Meta Cloud / Twilio via COEXISTENCE onboarding, already modelled on the `Kirana` row). Because the adapter is one file over the same `handle()`, promoting to the official API later replaces this file and nothing else.

## The Evolution deployment (as installed, 28 Aug 2026)

Everything lives on **D:** at the user's request:

```
D:\nukkad\evolution-api    git clone of EvolutionAPI/evolution-api at tag 2.3.7 (bare tag — "v2.3.7" does not exist)
D:\nukkad\node22           portable Node v22.14.0 (Baileys is ESM-only and requires Node ≥ 22; system Node stays 20 for the main repo)
```

Its `.env` (at `D:\nukkad\evolution-api\.env`): `SERVER_PORT=8080`; `AUTHENTICATION_API_KEY=nukkad-dev-key`; `DATABASE_CONNECTION_URI=<Supabase direct URL>?schema=evolution&sslmode=require` (**isolated schema** on our shared Supabase — its ~30 tables never touch ours); `CACHE_REDIS_ENABLED=false`, `CACHE_LOCAL_ENABLED=true` (no Redis dependency); `DEL_INSTANCE=false` (pairing survives restarts).

Install history and its landmines: `npm ci` needed `--fetch-retries=5` (ECONNRESET); `npm run db:generate` + `npm run db:deploy:win` applied all migrations into the `evolution` schema; `npm run build` clean; first start crashed `ERR_REQUIRE_ESM` on Node 20 → portable Node 22. **Boot takes ~60–90s** (Prisma connecting to Seoul) — health-check before use, don't assume.

Start command (PowerShell):
```
Start-Process D:\nukkad\node22\node.exe -ArgumentList "dist/main" -WorkingDirectory D:\nukkad\evolution-api
```
Health: `GET http://127.0.0.1:8080/` → `{"status":200,...,"version":"2.3.7"}`.

## Pairing runbook

1. Instance already exists: `nukkad` (created via `POST /instance/create {"instanceName":"nukkad","qrcode":true,"integration":"WHATSAPP-BAILEYS"}`, apikey header `nukkad-dev-key`). Re-creating an existing instance errors — use connect instead.
2. QR: `GET /instance/connect/nukkad` returns `{pairingCode, code, base64, count}` — `base64` is a data-URI PNG. **QRs rotate every ~40s**, so a saved image usually dies before it's scanned; the reliable path is the **manager UI** at `http://localhost:8080/manager` (server URL `http://localhost:8080`, API key `nukkad-dev-key`) whose QR self-refreshes. Scan with the spare phone: WhatsApp → Linked Devices → Link a Device.
3. Confirm: `GET /instance/connectionState/nukkad` → `{"state":"open"}` = paired. (Current status: **paired**.)
4. Webhook (done, 201): `POST /webhook/set/nukkad` body `{"webhook":{"enabled":true,"url":"http://127.0.0.1:3000/evolution/webhook","events":["MESSAGES_UPSERT"]}}`.
5. Project `.env` (done): `EVOLUTION_URL=http://127.0.0.1:8080`, `EVOLUTION_APIKEY=nukkad-dev-key`, `EVOLUTION_INSTANCE=nukkad`, `EVOLUTION_SHOP_PHONE=+919927306131`. The route answers 503 until these exist — restart the API after adding them.

## The adapter contract (`routes/evolution.ts`)

Inbound: Evolution wraps events as `{event, instance, data}`; a message is `MESSAGES_UPSERT` with `data.key.remoteJid` (peer), `data.key.fromMe`, `data.pushName`, and text in `data.message.conversation` **or** `data.message.extendedTextMessage.text` depending on message kind. The adapter normalises the event name case-insensitively, drops `fromMe` (our own outbound echoes back through the same event), drops non-`@s.whatsapp.net` JIDs (groups and broadcast lists are not customers), and **logs the message-kind keys when no text is found** instead of guessing — the payload shape is the one thing we cannot pin from our side, so surprises surface in logs, not silent drops. The phone becomes `+<jid-digits>` and enters `handle()` with `channel:'evolution'` and `externalId: evo_<whatsapp-message-id>` (idempotency even across webhook retries).

**Ack-then-answer:** the webhook returns `{ok:true}` immediately and the turn runs in `setImmediate` — Evolution retries slow webhooks, and a retried webhook is a customer answered twice. Outbound: `POST /message/sendText/nukkad` `{number, text}` with the apikey header; failures are logged with status and body, never thrown into the webhook path.

Not yet wired on this transport: media (photos of lists/bills) — text only for now; the batch-voice and vision pipelines exist and are used by other channels, so this is adapter plumbing, not new capability.

## Routing and identity

`EVOLUTION_SHOP_PHONE` identifies which kirana the paired number answers for. The *sender's* phone must match a registered `Household` under that kirana to get the full experience (the seeded test household is +91 89795 60165 "Ramesh"); unregistered numbers get the polite not-registered path — that is correct behaviour, not a bug. Twilio routing works the same way with `TWILIO_WHATSAPP_FROM`.

## Failure modes & cures

| Symptom | Cause | Cure |
|---|---|---|
| Webhook 503 | `EVOLUTION_URL`/`APIKEY` missing in API env | add env, restart API |
| No reply to WhatsApp msg | API not restarted after env change; or sender not a registered household; or Evolution boot not finished | check API logs — adapter logs every drop reason |
| `state` ≠ `open` | pairing lost / phone offline | re-pair via manager UI QR |
| Number banned | Meta enforcement against unofficial protocol | expected risk; spare number absorbs it; switch to Twilio adapter meanwhile |
| Evolution boot "hangs" | Seoul Prisma connect | wait 60–90s, health-check `GET /` |
| `ERR_REQUIRE_ESM` on start | ran with Node < 22 | use `D:\nukkad\node22\node.exe` |
