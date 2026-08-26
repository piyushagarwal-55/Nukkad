import type { FastifyInstance } from 'fastify';
import { verifySignature, handleRazorpayEvent } from '../services/payments/webhook.js';

/**
 * Razorpay signs the RAW body with HMAC-SHA256. If Fastify parses the JSON
 * and we re-serialise it, key order can shift and the signature check
 * fails for no visible reason. So this route keeps the original bytes.
 *
 * Dashboard > Account & Settings > Webhooks > Add New Webhook
 *   URL:    $PUBLIC_BASE_URL/rzp/webhook
 *   Secret: RAZORPAY_WEBHOOK_SECRET from .env
 *   Events: payment_link.paid, payment_link.partially_paid,
 *           payment_link.expired, payment.failed
 */
export async function razorpayRoutes(app: FastifyInstance) {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      (req as unknown as { rawBody: string }).rawBody = body as string;
      try { done(null, JSON.parse(body as string)); }
      catch (err) { done(err as Error, undefined); }
    },
  );

  app.post('/rzp/webhook', async (req, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const sig = req.headers['x-razorpay-signature'] as string | undefined;

    if (!sig || !verifySignature(raw, sig)) {
      app.log.warn('razorpay webhook signature mismatch');
      return reply.code(400).send({ error: 'bad signature' });
    }

    const body = req.body as { event?: string; [k: string]: unknown };
    const eventId = (req.headers['x-razorpay-event-id'] as string) ?? `${body.event}_${Date.now()}`;

    const result = await handleRazorpayEvent(eventId, body.event ?? 'unknown', body);
    app.log.info({ event: body.event, result }, 'razorpay webhook');

    return { ok: true, result };
  });
}
