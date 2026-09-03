import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { interpretPaymentPromise } from '../services/recovery/promise.js';
import { sendPaymentPromise } from '../services/recovery/client.js';

const requestSchema = z.object({
  obligationId: z.string().min(4).max(160),
  text: z.string().min(3).max(1_000),
  channel: z.enum(['WHATSAPP', 'SMS', 'VOICE', 'EMAIL']).default('WHATSAPP'),
}).strict();

export async function recoveryRoutes(app: FastifyInstance) {
  app.post('/recovery/payment-promise', async (request, reply) => {
    const input = requestSchema.parse(request.body);
    const interpretation = await interpretPaymentPromise(input.text);
    const delivered = await sendPaymentPromise({ obligationId: input.obligationId, channel: input.channel, rawText: input.text, promisedFor: interpretation.promisedFor, expiresAt: interpretation.expiresAt, confidence: interpretation.confidence, status: interpretation.status });
    return reply.code(202).send({ accepted: true, interpretation, correctness: delivered.response });
  });
}
