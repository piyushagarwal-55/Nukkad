import { prisma } from '@nukkad/db';
import { z } from 'zod';
import { groq } from '../../lib/groq.js';
import { env } from '../../config/env.js';
import { rupeeLabel } from '@nukkad/shared';
import { sendText } from '../channels/evolution.js';
import { renderForOwner, type DraftLine } from './plan.js';

/**
 * THE OWNER'S DESK -- a different conversation from every other one here.
 *
 * The four customer desks sell. This one BUYS, and the difference is not
 * cosmetic: the person on the other end owns the shop, the money is the
 * shop's own, and "haan" commits it to a distributor. So this does not
 * reuse the retail speech acts, the retail transition table, or the
 * retail composer. A CHECKOUT act means nothing here; an APPROVE act
 * means nothing at the counter. Sharing them would be how a customer
 * saying "haan bhej do" one day approves a purchase order.
 *
 * The shape is the same as the retail spine, though, because the shape is
 * the part that works: ONE reader that only reads, a table of what each
 * reading means, and deterministic execution. See policy/intent.ts for
 * the original argument.
 */

export const OWNER_ACTS = [
  /** haan, ok, bhej do, theek hai -- send it as it stands */
  'APPROVE',
  /** change how many of one line: "atta 5 kar do", "oil 2 hi" */
  'CHANGE_QTY',
  /** take a line out: "2 number hata do", "toothpaste rehne do" */
  'DROP_ITEM',
  /** put something in: "maggi bhi 10 daal do" */
  'ADD_ITEM',
  /** throw the whole order away */
  'CANCEL',
  /** what is in it, how much is it */
  'ASK',
  'UNKNOWN',
] as const;

export type OwnerAct = (typeof OWNER_ACTS)[number];

const frame = z.object({
  act: z.enum(OWNER_ACTS),
  /** 1-based line number when they pointed at one */
  line: z.number().int().positive().nullable().default(null),
  /** the product words they used, when they named instead of numbered */
  name: z.string().nullable().default(null),
  /** the new amount, for CHANGE_QTY and ADD_ITEM */
  quantity: z.number().positive().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type OwnerFrame = z.infer<typeof frame>;

const PROMPT = [
  'You read ONE message from an Indian kirana shop OWNER, replying to a',
  'stock order his own shop drafted for him. He speaks Hinglish.',
  '',
  'Return ONLY JSON: {"act":"...","line":<n|null>,"name":"<text|null>",',
  '"quantity":<n|null>,"confidence":<0..1>}',
  '',
  'act is one of:',
  '  APPROVE     - he agrees to send it: "haan", "ok bhej do", "theek hai"',
  '  CHANGE_QTY  - a different amount for one item: "atta 5 kar do"',
  '  DROP_ITEM   - remove one item: "2 number hata do", "tel rehne do"',
  '  ADD_ITEM    - add something: "maggi bhi 10 daal do"',
  '  CANCEL      - throw the whole order away: "cancel", "aaj rehne do"',
  '  ASK         - a question about the order: "kitne ka hai"',
  '  UNKNOWN     - anything else',
  '',
  'RULES:',
  '- line is the NUMBER he referred to, if he used one. Else null.',
  '- name is the product words he used, VERBATIM. Do not translate.',
  '- "rehne do" about ONE item is DROP_ITEM. "rehne do" about the whole',
  '  order, or with no item named, is CANCEL.',
  '- A bare "haan"/"ok"/"ji" with nothing else is APPROVE.',
  '- Never answer APPROVE just because the message is short or friendly.',
].join('\n');

export async function readOwner(message: string): Promise<OwnerFrame> {
  try {
    const res = await groq.chat.completions.create({
      model: env.GROQ_LLM_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: message },
      ],
    });
    const parsed = frame.safeParse(
      JSON.parse(res.choices[0]?.message?.content ?? '{}'),
    );
    return parsed.success
      ? parsed.data
      : { act: 'UNKNOWN', line: null, name: null, quantity: null, confidence: 0 };
  } catch {
    return { act: 'UNKNOWN', line: null, name: null, quantity: null, confidence: 0 };
  }
}

/**
 * THE APPROVAL EVIDENCE GUARD, and it is the most important function in
 * this file.
 *
 * A purchase order is money leaving the shop. The retail side learned
 * this the hard way three separate times -- a greeting wrote an order, a
 * greeting cancelled one, a greeting issued a payment link -- every time
 * because a model read CONTEXT rather than the sentence in front of it.
 * The cure there was saysCheckout()/saysCancel(): a message with no
 * checkout language in it must not become a checkout.
 *
 * Same disease, higher stakes, same cure. The model may propose APPROVE;
 * this decides whether the words are actually there.
 */
export function saysApproval(text: string): boolean {
  return /\b(haan|han|haa|ha|ji|yes|ok|okay|okey|theek|thik|sahi|done|bhej\s*do|bhejo|bhej\s*dijiye|kar\s*do|order\s*kar|confirm|approve)\b/i
    .test(text.trim());
}

/** the same idea for throwing the whole thing away */
export function saysCancel(text: string): boolean {
  return /\b(cancel|nahi|nai|na|mat|rehne\s*do|rahne\s*do|chhod|chod|band|skip|aaj\s*nahi)\b/i
    .test(text.trim());
}

type PO = Awaited<ReturnType<typeof loadOpenOrder>>;

export const loadOpenOrder = (kiranaId: string) =>
  prisma.purchaseOrder.findFirst({
    where: { kiranaId, status: { in: ['DRAFT', 'AWAITING_OWNER'] } },
    include: { lines: { orderBy: { id: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });

const asDraft = (l: { skuId: string | null; name: string; quantity: number; why: string | null; inStock: number; costPaise: number | null }): DraftLine => ({
  skuId: l.skuId, name: l.name, quantity: l.quantity,
  why: l.why ?? '', inStock: l.inStock, costPaise: l.costPaise,
});

/** which line did he mean -- by number if he gave one, else by name */
function pick(order: NonNullable<PO>, f: OwnerFrame) {
  if (f.line && f.line >= 1 && f.line <= order.lines.length) {
    return order.lines[f.line - 1]!;
  }
  if (f.name) {
    const q = f.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (q) {
      return order.lines.find((l) =>
        l.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(q)
        || q.includes(l.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6)),
      ) ?? null;
    }
  }
  return null;
}

/** append one turn to the order's audit trail */
async function log(orderId: string, existing: unknown, entry: object) {
  const rows = Array.isArray(existing) ? existing : [];
  await prisma.purchaseOrder.update({
    where: { id: orderId },
    data: { ownerLog: [...rows, { ...entry, at: new Date().toISOString() }] as never },
  });
}

export interface OwnerReply { text: string; sentToSupplier?: boolean }

/**
 * One owner message against the open purchase order.
 *
 * Every edit re-renders the whole order and asks again, which is
 * deliberate: the owner should approve the thing that will actually be
 * sent, not the thing he approved two edits ago.
 */
export async function handleOwnerMessage(
  kiranaId: string,
  text: string,
): Promise<OwnerReply> {
  const order = await loadOpenOrder(kiranaId);
  if (!order) {
    return { text: 'Abhi koi order pending nahi hai. Raat ko stock dekh kar bhejunga.' };
  }

  const kirana = await prisma.kirana.findUnique({ where: { id: kiranaId } });
  const shopName = kirana?.name ?? 'Aapki dukaan';
  const f = await readOwner(text);
  await log(order.id, order.ownerLog, { heard: text, act: f.act });

  const reRender = async () => {
    const fresh = await loadOpenOrder(kiranaId);
    return fresh ? renderForOwner(shopName, fresh.lines.map(asDraft)) : '';
  };

  switch (f.act) {
    case 'CANCEL': {
      // the whole order dies only when the words are actually there
      if (!saysCancel(text)) break;
      await prisma.purchaseOrder.update({
        where: { id: order.id }, data: { status: 'CANCELLED' },
      });
      return { text: 'Theek hai, aaj ka order cancel kar diya. Kal phir dekhunga.' };
    }

    case 'DROP_ITEM': {
      const line = pick(order, f);
      if (!line) return { text: 'Kaunsa item hata dun? Number bata dijiye.' };
      await prisma.purchaseOrderLine.delete({ where: { id: line.id } });
      const left = await loadOpenOrder(kiranaId);
      if (!left?.lines.length) {
        await prisma.purchaseOrder.update({
          where: { id: order.id }, data: { status: 'CANCELLED' },
        });
        return { text: `${line.name} hata diya. Ab kuch bacha nahi, order cancel kar diya.` };
      }
      return { text: `${line.name} hata diya.\n\n${await reRender()}` };
    }

    case 'CHANGE_QTY': {
      const line = pick(order, f);
      if (!line) return { text: 'Kis item ka number badalna hai? Number bata dijiye.' };
      if (!f.quantity) return { text: `${line.name} kitne packet kar dun?` };
      await prisma.purchaseOrderLine.update({
        where: { id: line.id },
        data: { quantity: f.quantity, why: 'aapne bola' },
      });
      return { text: `${line.name} ab ${f.quantity} packet.\n\n${await reRender()}` };
    }

    case 'ADD_ITEM': {
      if (!f.name) return { text: 'Kya add karna hai?' };
      /**
       * Matched against the catalogue when possible, but an unmatched
       * name is still added -- the owner asking for something the
       * catalogue has never heard of is exactly how a new product
       * enters a shop, and refusing it would be the tail wagging the dog.
       */
      const sku = await prisma.sku.findFirst({
        where: { kiranaId, active: true, name: { contains: f.name, mode: 'insensitive' } },
      });
      await prisma.purchaseOrderLine.create({
        data: {
          orderId: order.id,
          skuId: sku?.id ?? null,
          name: sku?.name ?? f.name,
          quantity: f.quantity ?? 1,
          why: 'aapne bola',
          inStock: 0,
          costPaise: sku?.costPaise ?? null,
        },
      });
      return { text: `Add kar diya.\n\n${await reRender()}` };
    }

    case 'ASK':
      return { text: await reRender() };

    case 'APPROVE': {
      /**
       * THE GUARD. The model said yes; the sentence has to say yes too.
       * Without this a distracted "hmm dekhta hoon" is a purchase order.
       */
      if (!saysApproval(text)) break;
      return sendToSupplier(kiranaId, order.id);
    }

    default:
      break;
  }

  return {
    text: `Samajh nahi aaya. "haan" bolein to bhej dun, ya bataiye kya badalna hai.\n\n${await reRender()}`,
  };
}

/**
 * Approved. Tell the distributor, in words the owner has already seen.
 */
export async function sendToSupplier(
  kiranaId: string,
  orderId: string,
): Promise<OwnerReply> {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: orderId, kiranaId },
    include: { lines: { orderBy: { id: 'asc' } } },
  });
  if (!order?.lines.length) return { text: 'Order khali hai, kuch bhejne ko nahi.' };

  const supplier = order.supplierId
    ? await prisma.supplier.findUnique({ where: { id: order.supplierId } })
    : await prisma.supplier.findFirst({ where: { kiranaId, active: true }, orderBy: { createdAt: 'asc' } });

  if (!supplier) {
    return { text: 'Koi distributor add nahi kiya hai abhi. Dashboard par add kar dijiye.' };
  }

  const kirana = await prisma.kirana.findUnique({ where: { id: kiranaId } });
  const body = [
    `Namaste ${supplier.name} ji,`,
    `${kirana?.name ?? 'Nukkad'} se order hai:`,
    '',
    ...order.lines.map((l, i) => `${i + 1}. ${l.name} — ${l.quantity} packet`),
    '',
    'Bill ke saath rate bhej dijiyega. Kab tak pahunch jayega?',
  ].join('\n');

  const res = await sendText(supplier.phone, body);

  const convo = await prisma.conversation.upsert({
    where: { channel_peerPhone: { channel: 'evolution', peerPhone: supplier.phone } },
    create: { channel: 'evolution', peerPhone: supplier.phone, partyRole: 'SUPPLIER', kiranaId },
    update: { partyRole: 'SUPPLIER', kiranaId },
  });
  await prisma.message.create({
    data: {
      conversationId: convo.id,
      direction: 'OUT',
      externalId: res.externalId ?? null,
      body: res.ok ? body : `[not delivered: ${res.error}]\n${body}`,
      intent: 'REQUEST',
      goal: 'RESTOCKING',
    },
  });

  await prisma.purchaseOrder.update({
    where: { id: order.id },
    data: {
      status: res.ok ? 'SENT' : 'AWAITING_OWNER',
      supplierId: supplier.id,
      sentText: body,
      approvedAt: new Date(),
      sentAt: res.ok ? new Date() : null,
      amountPaise: order.lines.every((l) => l.costPaise != null)
        ? Math.round(order.lines.reduce((s, l) => s + (l.costPaise ?? 0) * l.quantity, 0))
        : null,
    },
  });

  return {
    text: res.ok
      ? `Bhej diya ${supplier.name} ko. Bill aate hi bata dunga.`
      : `Bhej nahi paya: ${res.error}. Dobara koshish karun?`,
    sentToSupplier: res.ok,
  };
}

/** Ask the owner about tonight's draft. */
export async function askOwner(kiranaId: string, orderId: string, ownerPhone: string) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: orderId, kiranaId },
    include: { lines: { orderBy: { id: 'asc' } } },
  });
  if (!order?.lines.length) return { ok: false, error: 'empty order' };

  const kirana = await prisma.kirana.findUnique({ where: { id: kiranaId } });
  const body = renderForOwner(kirana?.name ?? 'Aapki dukaan', order.lines.map(asDraft));
  const res = await sendText(ownerPhone, body);

  const convo = await prisma.conversation.upsert({
    where: { channel_peerPhone: { channel: 'evolution', peerPhone: ownerPhone } },
    create: { channel: 'evolution', peerPhone: ownerPhone, partyRole: 'KIRANA', kiranaId },
    update: { partyRole: 'KIRANA', kiranaId },
  });
  await prisma.message.create({
    data: {
      conversationId: convo.id,
      direction: 'OUT',
      externalId: res.externalId ?? null,
      body: res.ok ? body : `[not delivered: ${res.error}]\n${body}`,
      intent: 'REQUEST',
      goal: 'RESTOCKING',
    },
  });

  await prisma.purchaseOrder.update({
    where: { id: order.id },
    data: { status: res.ok ? 'AWAITING_OWNER' : 'DRAFT', askedAt: new Date() },
  });

  return { ok: res.ok, error: res.error, text: body };
}

/** used by the bill-ingestion path to report a total back to the owner */
export const money = (paise: number) => rupeeLabel(Math.round(paise));
