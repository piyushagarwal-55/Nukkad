import type { FastifyInstance } from 'fastify';
import { prisma } from '@nukkad/db';
import { env, hasVision, hasSarvam } from '../config/env.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    const t0 = Date.now();
    let db = 'down';
    let dbMs = -1;
    try {
      await prisma.$queryRaw`select 1`;
      db = 'up';
      dbMs = Date.now() - t0;
    } catch { /* stays down */ }

    return {
      ok: db === 'up',
      db,
      dbLatencyMs: dbMs,
      // Seoul region costs ~296ms a query from India. If this creeps up,
      // the fix is caching, not retries.
      asr: env.GROQ_ASR_MODEL,
      llm: env.GROQ_LLM_MODEL,
      vision: hasVision ? env.GROQ_VISION_MODEL : 'DISABLED (no multimodal model on this account)',
      secondAsr: hasSarvam ? env.SARVAM_MODEL : 'not configured',
      publicBaseUrl: env.PUBLIC_BASE_URL ?? 'NOT SET, ngrok not running',
    };
  });
}
