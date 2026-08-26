import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '@nukkad/db';
import { env } from '../../config/env.js';

/**
 * Razorpay signs webhooks with HMAC-SHA256 over the RAW body. If Fastify
 * has already parsed and re-serialised the JSON, key order can differ and
 * the signature will not match. See routes/razorpay.ts for the raw-body
 * content type parser that keeps the original bytes.
 */
export function verifySignature(rawBody: string, signature: string): boolean {
  const expected = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

interface PaymentLinkEntity {
  id: string;
  reference_id?: string;
  amount_paid?: number;
  amount?: number;
  status?: string;
}

/**
 * Razorpay retries. Twilio retries. Every handler here must be safe to run
 * twice, which is what the WebhookEvent unique index buys.
 */
export async function handleRazorpayEvent(
  eventId: string, eventType: string, payload: Record<string, unknown>,
): Promise<'processed' | 'duplicate'> {
  try {
    await prisma.webhookEvent.create({
      data: { source: 'razorpay', externalId: eventId, eventType, payload: payload as never },
    });
  } catch {
    return 'duplicate';
  }

  const body = payload as {
    payload?: {
      payment_link?: { entity?: PaymentLinkEntity };
      payment?: { entity?: Record<string, unknown> };
    };
  };

  const linkEntity = body.payload?.payment_link?.entity;
  const paymentEntity = body.payload?.payment?.entity as
    | { id?: string; amount?: number; method?: string; status?: string }
    | undefined;

  if (linkEntity?.reference_id) {
    const invoice = await prisma.invoice.findUnique({
      where: { referenceId: linkEntity.reference_id },
    });

    if (invoice) {
      const paid = linkEntity.amount_paid ?? 0;
      const total = invoice.amountPaise;

      // The three states that matter. PARTIALLY_PAID is udhaar, and it is
      // the normal case, not an edge case.
      const status =
        eventType === 'payment_link.expired' ? 'EXPIRED'
        : paid >= total ? 'PAID'
        : paid > 0 ? 'PARTIALLY_PAID'
        : invoice.status;

      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { amountPaidPaise: paid, status: status as never },
      });

      if (paymentEntity?.id) {
        await prisma.payment.upsert({
          where: { razorpayPaymentId: paymentEntity.id },
          create: {
            invoiceId: invoice.id,
            razorpayPaymentId: paymentEntity.id,
            amountPaise: paymentEntity.amount ?? 0,
            method: paymentEntity.method ?? null,
            status: paymentEntity.status ?? 'unknown',
            rawJson: paymentEntity as never,
          },
          update: {},
        });
      }
    }
  }

  await prisma.webhookEvent.updateMany({
    where: { source: 'razorpay', externalId: eventId },
    data: { processedAt: new Date() },
  });

  return 'processed';
}
