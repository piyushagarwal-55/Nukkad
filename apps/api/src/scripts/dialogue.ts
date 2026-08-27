import 'dotenv/config';
import { prisma, Prisma } from '@nukkad/db';
import { handle } from '../services/conversation/core.js';
import type { InboundMessage } from '@nukkad/shared';

/**
 * MULTI-TURN CONVERSATION TESTS.
 *
 *   npm run dialogue --workspace=@nukkad/api
 *
 * smoke.ts already sends single messages and checks what comes back. It
 * cannot catch the class of bug this file exists for, because every bug
 * here needs at least two turns to show up: the bot asks a question, the
 * customer answers, and the answer goes nowhere.
 *
 * That was the actual state of the WhatsApp agent. Every card offered
 * numbered taps and not one of them did anything -- "1" went into the
 * order extractor as a fresh request, found no products, and got the menu
 * back. Orders sat at AWAITING forever.
 *
 * So each case below is a SCRIPT, and the assertions are about the
 * database as much as the reply text. A confirm that does not move the row
 * to CONFIRMED is not a confirm, however nice the message sounds.
 */

const HOUSEHOLD = '+918979560165';
const SHOP = '+919927306131';

let seq = 0;
const inbound = (text: string): InboundMessage => ({
  channel: 'sim',
  senderId: HOUSEHOLD,
  recipientId: SHOP,
  text,
  media: [],
  externalId: `dlg_${++seq}`,
  receivedAt: new Date(),
});

interface Turn {
  say: string;
  /** substring the reply must contain */
  expect?: string;
  /** substring the reply must NOT contain */
  reject?: string;
  /** checked against the order the conversation is currently holding */
  orderStatus?: string;
  /**
   * how many lines that order must have.
   *
   * The assertion that catches merge bugs. Reply text can look perfect
   * while the row behind it holds one line instead of two.
   */
  lines?: number;
}

interface Case { name: string; why: string; turns: Turn[] }

const CASES: Case[] = [
  {
    name: 'tap 1 confirms',
    why: 'the tap the confirm card actually offers',
    turns: [
      { say: 'do kilo atta bhej dena', expect: 'Total' },
      { say: '1', expect: 'confirm ho gaya', orderStatus: 'CONFIRMED' },
    ],
  },
  {
    name: 'typed haan confirms',
    why: 'nobody types the number, they type haan',
    turns: [
      { say: 'ek kilo chini bhejo', expect: 'Total' },
      { say: 'haan bhej do', expect: 'confirm ho gaya', orderStatus: 'CONFIRMED' },
    ],
  },
  {
    name: 'tap 3 cancels',
    why: 'and the row must actually move, not just the message',
    turns: [
      { say: 'do kilo atta bhej dena', expect: 'Total' },
      { say: '3', expect: 'cancel', orderStatus: 'CANCELLED' },
    ],
  },
  {
    name: 'an amendment is merged, not started over',
    why:
      'staring at a confirm card and typing more items is the commonest ' +
      'real reply. A rigid machine answers it with the menu; a naive one ' +
      'makes a SECOND order and leaves the first pending forever',
    turns: [
      { say: 'do kilo atta bhej dena', expect: 'Atta' },
      // the card must now hold BOTH, and the catalogue says Sugar, not chini
      { say: 'aur ek kilo chini bhi bhej dena', expect: 'Sugar', reject: 'Kya karna hai' },
      { say: 'haan', expect: 'confirm', orderStatus: 'CONFIRMED', lines: 2 },
    ],
  },
  {
    name: 'a restated quantity replaces, not stacks',
    why: 'someone correcting two kilos to three means three, not five',
    turns: [
      { say: 'do kilo atta bhej dena', expect: '2 x' },
      { say: 'nahi teen kilo atta karo', expect: '3 x', lines: 1 },
    ],
  },
  {
    name: 'a quantity is not a tap',
    why:
      '"2 kilo chawal" contains a 2, and reading that as option 2 would ' +
      'cancel or edit an order the customer was adding to',
    turns: [
      { say: 'do kilo atta bhej dena', expect: 'Total' },
      { say: '2 kilo chawal', expect: 'Chawal', reject: 'dobara bhej' },
    ],
  },
  {
    name: 'other lines survive a question',
    why:
      'the old code found the first uncertain line, asked about it, and ' +
      'discarded every other line in the order. chawal is genuinely ' +
      'ambiguous across three rice SKUs, so it is a real question and not ' +
      'a staged one',
    turns: [
      { say: 'do kilo chawal aur do kilo atta', expect: 'matlab' },
      // answering about the rice must bring the ATTA back with it
      { say: '1', expect: 'Atta', lines: 2 },
    ],
  },
  {
    name: 'menu tap 3 answers',
    why: 'the menu offered four taps and none of them did anything',
    turns: [
      { say: 'kya haal hai', expect: 'Kya karna hai' },
      { say: '3', expect: 'order' },
    ],
  },
];

/** wipe conversation state so each case starts from a known place */
async function reset() {
  await prisma.conversation.updateMany({
    where: { channel: 'sim', peerPhone: HOUSEHOLD },
    data: { state: 'IDLE', contextJson: Prisma.DbNull },
  });
}

async function run() {
  let passed = 0;
  let failed = 0;

  for (const c of CASES) {
    await reset();
    console.log(`\n${c.name}`);
    console.log(`  why: ${c.why}`);

    let lastOrderId: string | null = null;
    let ok = true;

    for (const turn of c.turns) {
      const replies = await handle(inbound(turn.say));
      const text = replies.map((r) => r.text).join('\n');

      console.log(`  >  ${turn.say}`);
      console.log(`  <  ${text.replace(/\n/g, '\n     ')}`);

      // the reference the confirm card prints, so the assertion can find
      // the row without guessing which order was just made
      const ref = /\(#([a-z0-9]{6})\)/.exec(text)?.[1];
      if (ref) lastOrderId = ref;

      if (turn.expect && !text.toLowerCase().includes(turn.expect.toLowerCase())) {
        console.log(`     FAIL expected to contain "${turn.expect}"`);
        ok = false;
      }
      if (turn.reject && text.toLowerCase().includes(turn.reject.toLowerCase())) {
        console.log(`     FAIL should NOT contain "${turn.reject}"`);
        ok = false;
      }

      if (turn.orderStatus || turn.lines !== undefined) {
        const order = lastOrderId
          ? await prisma.order.findFirst({
              where: { id: { endsWith: lastOrderId } },
              orderBy: { createdAt: 'desc' },
              include: { lines: true },
            })
          : null;

        if (!order) {
          console.log('     FAIL no order row to check');
          ok = false;
        } else {
          if (turn.orderStatus && order.status !== turn.orderStatus) {
            console.log(`     FAIL order is ${order.status}, expected ${turn.orderStatus}`);
            ok = false;
          }
          if (turn.lines !== undefined && order.lines.length !== turn.lines) {
            console.log(`     FAIL order has ${order.lines.length} lines, expected ${turn.lines}`);
            ok = false;
          }
          console.log(`     db   order ${lastOrderId} ${order.status}, ${order.lines.length} line(s)`);
        }
      }
    }

    if (ok) { passed++; console.log('  PASS'); }
    else { failed++; console.log('  FAIL'); }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  if (failed) process.exit(1);
}

run().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
