import 'dotenv/config';
import { z } from 'zod';

/**
 * Fail loud at boot rather than at 3am on stage. Anything the demo cannot
 * run without is required here; anything optional is explicitly optional
 * with the consequence spelled out.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  PUBLIC_BASE_URL: z.string().url().optional(),

  // Runtime uses the session pooler (IPv4-safe). DIRECT_URL is IPv6-only and
  // is read by prisma migrate, not by the app.
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().optional(),

  // Twilio
  TWILIO_ACCOUNT_SID: z.string().startsWith('AC'),
  TWILIO_AUTH_TOKEN: z.string().min(10),
  TWILIO_WHATSAPP_FROM: z.string().min(5),
  TWILIO_SANDBOX_JOIN_CODE: z.string().optional(),

  // Groq. One key does ASR and chat, because Groq is OpenAI-compatible.
  GROQ_API_KEY: z.string().startsWith('gsk_'),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
  GROQ_ASR_MODEL: z.string().default('whisper-large-v3'),
  GROQ_ASR_MODEL_FAST: z.string().default('whisper-large-v3-turbo'),
  // Explicit language beats auto-detect on Hinglish. Auto flip-flops
  // between hi and en mid-utterance and returns mush.
  GROQ_ASR_LANGUAGE: z.string().default('hi'),
  GROQ_LLM_MODEL: z.string().default('openai/gpt-oss-120b'),
  GROQ_LLM_MODEL_FAST: z.string().default('openai/gpt-oss-20b'),
  // Groq's vision models are the Qwen 3.x 27B pair, not Llama 4 (Maverick
  // was deprecated 20 Feb 2026). 3.6 is more faithful on verbatim names and
  // takes 5 images per request; 3.8 is ~25% faster with 3.
  GROQ_VISION_MODEL: z.string().optional(),
  GROQ_VISION_MODEL_FAST: z.string().optional(),

  // Optional second ASR, purely to add a row to the ablation table.
  SHUNYA_API_KEY: z.string().optional(),
  SHUNYA_AUTH_URL: z.string().default('https://app.shunyalabs.ai'),
  SHUNYA_BASE_URL: z.string().default('https://asrv2prod.shunyalabs.ai'),
  SHUNYA_MODEL: z.string().default('zero-indic'),
  /// en, not hi. hi returns Devanagari, which the resolver strips to nothing.
  SHUNYA_LANGUAGE: z.string().default('en'),

  SARVAM_API_KEY: z.string().optional(),
  SARVAM_BASE_URL: z.string().default('https://api.sarvam.ai'),
  SARVAM_MODEL: z.string().default('saaras:v3'),
  SARVAM_MODE: z.string().default('codemix'),

  // Razorpay
  RAZORPAY_KEY_ID: z.string().startsWith('rzp_'),
  RAZORPAY_KEY_SECRET: z.string().min(10),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(8),

  SESSION_SECRET: z.string().min(16),

  DEMO_HOUSEHOLD_NUMBER: z.string().optional(),
  DEMO_KIRANA_NUMBER: z.string().optional(),
});

/**
 * dotenv loads `FOO=` as the empty string, not undefined, so `.optional()`
 * on a url or enum still fails on a blank line. Strip empties first so an
 * unset optional behaves like an unset optional.
 */
const cleaned = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ''),
);

const parsed = schema.safeParse(cleaned);

if (!parsed.success) {
  console.error('\nInvalid environment. Fix .env before starting:\n');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

export const hasVision = Boolean(env.GROQ_VISION_MODEL);
export const hasSarvam = Boolean(env.SARVAM_API_KEY);
export const hasShunya = Boolean(env.SHUNYA_API_KEY);
