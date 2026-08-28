import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { env } from './config/env.js';
import { loggerConfig } from './lib/logger.js';
import { healthRoutes } from './routes/health.js';
import { whatsappRoutes } from './routes/whatsapp.js';
import { simRoutes } from './routes/sim.js';
import { razorpayRoutes } from './routes/razorpay.js';
import { billRoutes } from './routes/bills.js';
import { authRoutes } from './routes/auth.js';
import { shopRoutes } from './routes/shop.js';
import { analyticsRoutes } from './routes/analytics.js';
import { voiceRoutes } from './routes/voice.js';
import { streamRoutes } from './routes/stream.js';
import { intelligenceRoutes } from './routes/intelligence.js';
import { evolutionRoutes } from './routes/evolution.js';

const app = Fastify({ logger: loggerConfig, bodyLimit: 20 * 1024 * 1024 });

// credentials:true so the session cookie survives the web app's origin
await app.register(cors, { origin: true, credentials: true });
await app.register(cookie);
// Twilio posts urlencoded, the simulator posts JSON. Both are registered.
await app.register(formbody);
// bill upload. 20MB matches Groq's per-image ceiling.
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
/**
 * The voice session. 1MB is generous for ~100ms of 16kHz mono PCM
 * (3200 bytes) and leaves room for a browser that buffers a few frames
 * before a send.
 */
await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

await app.register(healthRoutes);
await app.register(whatsappRoutes);
await app.register(simRoutes);
await app.register(razorpayRoutes);
await app.register(billRoutes);
await app.register(authRoutes);
await app.register(shopRoutes);
await app.register(analyticsRoutes);
await app.register(voiceRoutes);
await app.register(streamRoutes);
await app.register(intelligenceRoutes);
await app.register(evolutionRoutes);

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(`nukkad api on :${env.PORT}`);
  if (!env.PUBLIC_BASE_URL) {
    app.log.warn('PUBLIC_BASE_URL is unset. Start ngrok and set it, or Twilio cannot reach this.');
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
