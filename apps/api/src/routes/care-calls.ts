import type { FastifyInstance } from 'fastify';
import { requireSession } from './auth.js';
import { buildCareCallPlans } from '../services/care-call/plan.js';

export async function careCallRoutes(app: FastifyInstance) {
  app.get('/care-calls/due', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const days = Number((req.query as { days?: string }).days ?? 5);
    if (!Number.isFinite(days) || days < 1 || days > 30) {
      return reply.code(400).send({ error: 'days must be between 1 and 30' });
    }

    const plans = await buildCareCallPlans(kiranaId, days);
    return {
      mode: 'outbound-care-call',
      separation:
        'This is intentionally separate from the inbound WhatsApp/order agent. It prepares a call script; it does not change conversation/core.ts.',
      plans,
    };
  });
}
