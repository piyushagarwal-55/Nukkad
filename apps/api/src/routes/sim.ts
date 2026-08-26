import type { FastifyInstance } from 'fastify';
import { simAdapter, drainSimOutbox } from '../channels/index.js';
import { handle } from '../services/conversation/core.js';

/**
 * The judge-facing surface.
 *
 * Identical pipeline to /wa/twilio, different transport. This is what lets
 * a judge drive the demo from a laptop with no join code, no US number and
 * no app, and it is what saves the demo when venue wifi kills the tunnel.
 *
 * On stage: "same webhook, same ranker, same ledger, only the transport
 * differs."
 */
export async function simRoutes(app: FastifyInstance) {
  app.post('/wa/sim', async (req) => {
    const inbound = await simAdapter.parse(req.body);
    const replies = await handle(inbound);
    for (const r of replies) await simAdapter.send(inbound.senderId, r);
    return { ok: true, replies };
  });

  app.get('/wa/sim/outbox', async (req) => {
    const { phone } = req.query as { phone?: string };
    if (!phone) return { messages: [] };
    return { messages: drainSimOutbox(phone) };
  });
}
