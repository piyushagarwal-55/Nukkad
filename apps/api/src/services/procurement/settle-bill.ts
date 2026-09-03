import { prisma } from '@nukkad/db';
import { rupeeLabel } from '@nukkad/shared';
import { parseBill } from '../bills/parse.js';
import { sendText } from '../channels/evolution.js';

/**
 * THE BILL COMES BACK.
 *
 * The distributor answers a purchase order with a photograph of a bill,
 * or with the breakdown typed into the chat. Either way the shop now has
 * two documents that must be compared: what it ASKED for (PurchaseOrder)
 * and what it is being CHARGED for (this). They are different things and
 * they disagree more often than anyone admits -- a rate moved, an item
 * was short-supplied, a line appeared that nobody ordered.
 *
 * So nothing here pays anything. It reads the bill, lays it beside the
 * order, names every disagreement, and hands the result to the human who
 * owns the money. The payment call is a separate file with a separate
 * gate -- see pay.ts, which is deliberately not wired to a bank.
 */

export interface BilledLine {
  name: string;
  quantity: number;
  ratePaise: number | null;
  amountPaise: number | null;
}

export interface Reconciled {
  lines: BilledLine[];
  totalPaise: number | null;
  /** disagreements against what was ordered, in the owner's language */
  notes: string[];
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Compare a supplier's bill against the order it answers.
 *
 * Every difference is REPORTED, never silently accepted and never
 * silently rejected. A shopkeeper who is told "3 cheezein alag hain"
 * can look; one who is told nothing pays for a bill nobody read.
 */
export function reconcile(
  ordered: Array<{ name: string; quantity: number; costPaise: number | null }>,
  billed: BilledLine[],
): string[] {
  const notes: string[] = [];
  const seen = new Set<number>();

  for (const o of ordered) {
    const ok = key(o.name);
    const idx = billed.findIndex((b, i) => !seen.has(i) && (key(b.name).includes(ok.slice(0, 6)) || ok.includes(key(b.name).slice(0, 6))));
    if (idx < 0) {
      notes.push(`${o.name} bill mein nahi hai (${o.quantity} maanga tha)`);
      continue;
    }
    seen.add(idx);
    const b = billed[idx]!;

    if (Math.abs(b.quantity - o.quantity) > 0.001) {
      notes.push(`${o.name}: maanga ${o.quantity}, bill mein ${b.quantity}`);
    }
    /**
     * A rate that moved is the single most useful thing this comparison
     * finds: it is the distributor quietly raising a price, and it is
     * invisible to a shop that files bills in a drawer.
     */
    if (o.costPaise != null && b.ratePaise != null && b.ratePaise !== o.costPaise) {
      const up = b.ratePaise > o.costPaise;
      const pct = Math.round((Math.abs(b.ratePaise - o.costPaise) / o.costPaise) * 100);
      notes.push(
        `${o.name}: rate ${up ? 'badha' : 'ghata'} — pehle ${rupeeLabel(o.costPaise)}, ab ${rupeeLabel(b.ratePaise)} (${pct}%)`,
      );
    }
  }

  billed.forEach((b, i) => {
    if (!seen.has(i)) notes.push(`${b.name} bill mein hai par order mein nahi tha`);
  });

  return notes;
}

/**
 * Read a typed breakdown out of a chat message.
 *
 * Suppliers often just type it: "atta 10 x 268 = 2680". Parsed by regex
 * on purpose -- these are money figures, and a model that misreads one
 * digit produces a bill nobody notices is wrong.
 */
export function parseTypedBill(text: string): BilledLine[] {
  const out: BilledLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(
      /^(?:\d+[.)]\s*)?(.+?)[\s-]*(\d+(?:\.\d+)?)\s*(?:x|\*|@)\s*(?:rs\.?\s*)?(\d+(?:\.\d+)?)(?:\s*(?:=|-)\s*(?:rs\.?\s*)?(\d+(?:\.\d+)?))?/i,
    );
    if (!m) continue;
    const [, name, qty, rate, amount] = m;
    if (!name?.trim()) continue;
    out.push({
      name: name.trim(),
      quantity: Number(qty),
      ratePaise: Math.round(Number(rate) * 100),
      amountPaise: amount ? Math.round(Number(amount) * 100) : Math.round(Number(qty) * Number(rate) * 100),
    });
  }
  return out;
}

/**
 * A supplier answered an order. Read whatever they sent, compare, store,
 * and tell the owner what to look at.
 */
export async function ingestSupplierBill(args: {
  kiranaId: string;
  supplierName: string;
  imagePath?: string;
  mime?: string;
  text?: string;
}): Promise<{ handled: boolean; ownerText?: string; totalPaise?: number | null }> {
  const order = await prisma.purchaseOrder.findFirst({
    where: { kiranaId: args.kiranaId, status: 'SENT' },
    include: { lines: { orderBy: { id: 'asc' } } },
    orderBy: { sentAt: 'desc' },
  });
  if (!order) return { handled: false };

  let billed: BilledLine[] = [];
  let total: number | null = null;
  let billId: string | null = null;

  if (args.imagePath) {
    /**
     * The same reader the catalogue-onboarding path uses. A bill is a
     * bill: there is no second vision prompt for procurement, because
     * two prompts reading the same paper would drift apart.
     */
    const parsed = await parseBill(args.imagePath, args.mime ?? 'image/jpeg');
    billed = parsed.bill.items.map((i) => ({
      name: i.name,
      quantity: i.qty,
      ratePaise: i.ratePaise ?? null,
      amountPaise: i.amountPaise ?? null,
    }));
    total = parsed.bill.totalPaise ?? null;

    const row = await prisma.supplierBill.create({
      data: {
        kiranaId: args.kiranaId,
        status: 'PARSED',
        imagePath: args.imagePath,
        mime: args.mime ?? 'image/jpeg',
        bytes: 0,
        supplierName: parsed.bill.supplier ?? args.supplierName,
        totalPaise: total,
        visionModel: parsed.model,
        parseMs: parsed.latencyMs,
        docType: 'PURCHASE',
      },
    });
    billId = row.id;
  } else if (args.text) {
    billed = parseTypedBill(args.text);
    if (!billed.length) return { handled: false };
    total = billed.reduce((s, b) => s + (b.amountPaise ?? 0), 0) || null;
  } else {
    return { handled: false };
  }

  if (!billed.length) return { handled: false };

  const notes = reconcile(order.lines, billed);

  await prisma.purchaseOrder.update({
    where: { id: order.id },
    data: { status: 'BILLED', billedAt: new Date(), billId, amountPaise: total },
  });

  const ownerText = [
    `${args.supplierName} ne bill bhej diya.`,
    '',
    ...billed.map((b, i) =>
      `${i + 1}. ${b.name} — ${b.quantity}`
      + (b.ratePaise != null ? ` x ${rupeeLabel(b.ratePaise)}` : '')
      + (b.amountPaise != null ? ` = ${rupeeLabel(b.amountPaise)}` : '')),
    '',
    total != null ? `Total: ${rupeeLabel(total)}` : 'Total bill par nahi likha tha.',
    ...(notes.length
      ? ['', 'Dhyan dijiye:', ...notes.map((n) => `• ${n}`)]
      : ['', 'Order se poora milta hai.']),
    '',
    /**
     * The one sentence that will change when UPI Reserve Pay is live.
     * Until then the shop says plainly that a human pays -- claiming an
     * automatic payment that has not happened would be the same class of
     * lie as marking an order paid from a message.
     */
    'Payment abhi aap khud kar dijiye — auto-pay Razorpay approval ke baad chalu hoga.',
  ].join('\n');

  return { handled: true, ownerText, totalPaise: total };
}

/** tell the owner, on WhatsApp */
export async function notifyOwner(kiranaId: string, ownerPhone: string, text: string) {
  const res = await sendText(ownerPhone, text);
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
      body: res.ok ? text : `[not delivered: ${res.error}]\n${text}`,
      intent: 'INFORM',
      goal: 'RESTOCKING',
    },
  });
  return res;
}
