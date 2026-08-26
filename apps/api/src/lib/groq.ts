import OpenAI from 'openai';
import { env } from '../config/env.js';

/**
 * Groq speaks the OpenAI wire protocol, so one client covers BOTH
 * chat completions and Whisper transcription. No second SDK.
 */
export const groq = new OpenAI({
  apiKey: env.GROQ_API_KEY,
  baseURL: env.GROQ_BASE_URL,
});

/**
 * Groq sits behind Cloudflare, which rejects some default HTTP client
 * fingerprints with `error code: 1010`. The OpenAI SDK sets a normal
 * UA so this is not an issue in the app, but any raw fetch to Groq
 * MUST set one. Keeping the note here so nobody rediscovers it at 2am.
 */
export const GROQ_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
