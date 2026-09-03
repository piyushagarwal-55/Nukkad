# Deployment

Nukkad is a monorepo with three runtime pieces:

1. `apps/web` - Next.js dashboard and simulator.
2. `apps/api` - Fastify API, webhooks, voice, Razorpay, procurement, supplier routes.
3. Evolution API - separate WhatsApp gateway for the single shop/bot number.

Supabase Postgres is the database. Do not deploy `.env`; copy the values into
the hosting provider's environment-variable UI.

## Recommended Hackathon Setup

### 1. Database: Supabase

Keep the existing Supabase project.

Required variables for the API:

```text
DATABASE_URL
DIRECT_URL
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
```

Run after first deploy or schema change:

```bash
npm run db:generate
npm run db:push
npm run db:seed
npm run db:seed:kb
```

### 2. API: Render or Railway web service

Deploy the repository as one Node web service.

Root directory:

```text
.
```

Build command:

```bash
npm install && npm run db:generate && npm run build
```

Start command:

```bash
npm run start --workspace=@nukkad/api
```

Set every API variable from `.env.example`, including:

```text
NODE_ENV=production
DATABASE_URL
DIRECT_URL
PUBLIC_BASE_URL=<your deployed API URL>
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_WHATSAPP_FROM
TWILIO_SANDBOX_JOIN_CODE
GROQ_API_KEY
GROQ_BASE_URL
GROQ_ASR_MODEL
GROQ_ASR_MODEL_FAST
GROQ_ASR_LANGUAGE
GROQ_LLM_MODEL
GROQ_LLM_MODEL_FAST
GROQ_VISION_MODEL
GROQ_VISION_MODEL_FAST
SHUNYA_API_KEY
SHUNYA_LANGUAGE
SARVAM_API_KEY
SARVAM_BASE_URL
SARVAM_MODEL
SARVAM_MODE
SARVAM_TTS_MODEL
SARVAM_TTS_SPEAKER
SARVAM_TTS_LANGUAGE
RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET
RAZORPAY_WEBHOOK_SECRET
PAYCORRECT_URL
PAYCORRECT_CHANNEL_SECRET
SESSION_SECRET
EVOLUTION_URL
EVOLUTION_APIKEY
EVOLUTION_INSTANCE
EVOLUTION_SHOP_PHONE
```

Use the deployed API URL for:

```text
PUBLIC_BASE_URL=https://<api-host>
```

Webhook URLs:

```text
Razorpay:  https://<api-host>/rzp/webhook
Twilio:    https://<api-host>/wa/twilio
Evolution: https://<api-host>/evolution/webhook
```

### 3. Web: Vercel

Deploy the same GitHub repo as a separate Vercel project.

Root directory:

```text
apps/web
```

Framework:

```text
Next.js
```

Environment:

```text
NEXT_PUBLIC_API_URL=https://<api-host>
```

If Vercel cannot resolve workspace packages with `apps/web` as root, use repo
root as the root directory and set:

```bash
npm install
npm run build --workspace=@nukkad/web
```

### 4. WhatsApp: Evolution API

Only the shop/bot number is connected to Evolution:

```text
+91 99273 06131
```

The supplier number is only a normal WhatsApp recipient:

```text
+91 63948 31542
```

For the hackathon demo, Evolution may keep running locally on this machine:

```text
EVOLUTION_URL=http://127.0.0.1:8080
```

Then set its webhook to the deployed API:

```http
POST /webhook/set/nukkad
{
  "webhook": {
    "enabled": true,
    "url": "https://<api-host>/evolution/webhook",
    "events": ["MESSAGES_UPSERT"]
  }
}
```

For an always-on production-ish demo, deploy Evolution separately as Docker on
Railway, a VPS, or another service with a persistent volume for paired sessions.
Pair only the shop/bot number by QR.

## What Not To Deploy

Do not deploy or commit:

```text
.env
.codex-temp/
node_modules/
apps/*/dist/
apps/web/.next/
output/
apps/eval/out/
```

## Minimal Phone Setup

Required:

```text
Shop/bot WhatsApp: +91 99273 06131
Supplier WhatsApp: +91 63948 31542
```

Optional:

```text
One customer WhatsApp number for the customer chatbot demo.
```

No owner WhatsApp is needed now because procurement approval happens in the
dashboard at:

```text
/dashboard/procurement
```
