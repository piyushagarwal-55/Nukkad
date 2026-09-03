import type { Facts } from './compose.js';
import type { ReplyVerification } from '@nukkad/shared';

const moneyOrStatusKinds = new Set<Facts['kind']>([
  'ORDER_DRAFT',
  'BASKET_ADDED',
  'BASKET_REVIEW',
  'ORDER_AMENDED',
  'ORDER_CONFIRMED',
  'AWAITING_PAYMENT',
  'PAYMENT_NOT_SEEN',
  'NO_PAYMENT_PENDING',
  'ORDER_REPLACED',
  'ORDER_CANCELLED',
  'ACCOUNT',
  'ORDER_STATUS',
  'OFFER_ANSWER',
]);

const paidClaims = [
  /\bpaid\b/i,
  /\bpayment\s+(received|done|successful|success|confirmed)\b/i,
  /\border\s+(confirmed|success|successful)\b/i,
  /\bconfirmed\b/i,
  /payment\s+(mil|aa)\s*(gaya|gayi|hai)?/i,
  /paisa\s+(mil|aa)\s*(gaya|gayi|hai)?/i,
];

function allowedDigits(f: Facts): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown) => {
    for (const m of String(v ?? '').matchAll(/\d+/g)) out.add(m[0]!);
  };

  switch (f.kind) {
    case 'ASK_WHICH':
      f.options.forEach(add);
      add(f.sourceText);
      break;
    case 'RECOMMEND':
      add(f.name);
      add(f.price);
      add(f.why);
      f.alternatives.forEach(add);
      break;
    case 'REJECTED':
      f.options.forEach(add);
      add(f.rejected);
      break;
    case 'STOCK_ANSWER':
      add(f.name);
      add(f.price);
      break;
    case 'LISTING':
      add(f.asked);
      f.options.forEach(add);
      break;
    case 'PRICES':
      f.items.forEach((i) => {
        add(i.name);
        add(i.price);
      });
      break;
    case 'CATALOGUE':
      f.categories.forEach(add);
      break;
    case 'ACCOUNT':
      add(f.orders);
      add(f.spent);
      break;
    case 'ORDER_STATUS':
      add(f.ref);
      add(f.stage);
      add(f.total);
      break;
    case 'ORDER_CONFIRMED':
    case 'AWAITING_PAYMENT':
      add(f.ref);
      break;
    case 'OFFER_ANSWER':
      add(f.applies?.title);
      add(f.applies?.off);
      add(f.almost?.title);
      add(f.almost?.needs);
      break;
    case 'NOT_STOCKED':
      add(f.product);
      break;
    case 'BASKET_ADDED':
    case 'ORDER_DRAFT':
      f.packAsks.forEach((p) => {
        add(p.asked);
        add(p.sold);
        add(p.units);
      });
      break;
  }

  return out;
}

function proseOnly(reply: string): string {
  return reply.split(/\n\s*\n/, 1)[0] ?? reply;
}

export function verifyReply(facts: Facts, reply: string, fallbackUsed = false): ReplyVerification {
  const allowed = allowedDigits(facts);
  const issues: string[] = [];
  const prose = proseOnly(reply);

  for (const m of prose.matchAll(/\d+/g)) {
    const digit = m[0]!;
    if (!allowed.has(digit)) issues.push(`ungrounded digit ${digit}`);
  }

  if (/\btotal\b/i.test(prose)) {
    issues.push('total claim belongs in the deterministic card');
  }

  if (facts.kind !== 'ORDER_CONFIRMED') {
    const claimedPaid = paidClaims.some((rx) => rx.test(prose));
    if (claimedPaid) issues.push('payment/order success claim is not grounded in this fact');
  }

  if (!moneyOrStatusKinds.has(facts.kind) && /\b(rupees?|rs\.?|inr|paise|payment|paid|total|discount)\b/i.test(prose)) {
    issues.push('money language used without a money-bearing fact');
  }

  return {
    ok: issues.length === 0,
    issues,
    allowedDigits: [...allowed].sort(),
    fallbackUsed,
  };
}

export function guardedReply(facts: Facts, candidate: string, fallback: string, card?: string): {
  text: string;
  verification: ReplyVerification;
} {
  const first = verifyReply(facts, candidate, false);
  if (first.ok) return { text: candidate, verification: first };

  const safe = card ? `${fallback}\n\n${card}` : fallback;
  return {
    text: safe,
    verification: {
      ...verifyReply(facts, safe, true),
      issues: first.issues,
      fallbackUsed: true,
    },
  };
}
