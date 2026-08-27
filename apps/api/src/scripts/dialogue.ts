import 'dotenv/config';
import { prisma, Prisma } from '@nukkad/db';
import { handle } from '../services/conversation/core.js';
import type { InboundMessage } from '@nukkad/shared';

/**
 * MULTI-TURN CONVERSATION TESTS.
 *
 *   npm run dialogue --workspace=@nukkad/api
 *
 * smoke.ts sends single messages and checks what comes back. It cannot
 * catch the class of bug this file exists for, because every bug here
 * needs at least two turns: the bot asks a question, the customer answers,
 * and the answer goes nowhere.
 *
 * WHAT IS ASSERTED, AND WHAT DELIBERATELY IS NOT.
 *
 * The prose is written by a model now, so asserting on exact sentences
 * would test the model's mood rather than the system. What gets asserted
 * is what must be true regardless of phrasing:
 *
 *   the DATABASE   status moved, the right number of lines got written
 *   the LEDGER     the appended card is rendered by code, so the product
 *                  names and the total are exact and checkable
 *   the SHAPE      no numbered menus, and never the same sentence twice
 *
 * That last one is not decoration. Repeating a canned line at anyone who
 * goes off-script is the single most bot-like thing a bot does, and it is
 * a property of the whole conversation rather than of any one reply, so
 * nothing but a multi-turn test can see it.
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
  /** substring the reply must contain. Use for LEDGER content, not prose. */
  expect?: string;
  /** substring the reply must NOT contain */
  reject?: string;
  /** checked against the order the conversation is currently holding */
  orderStatus?: string;
  /** how many lines that order must have. Catches merge bugs. */
  lines?: number;
}

interface Case { name: string; why: string; turns: Turn[] }

const CASES: Case[] = [
  {
    name: 'a greeting gets a greeting, not a menu',
    why:
      'the whole complaint. "Hi" used to return a four-item numbered list, ' +
      'which tells the customer they are talking to a form',
    turns: [
      { say: 'Hi' },
      { say: 'kya haal hai bhaiya' },
    ],
  },
  {
    name: 'off-script twice, answered differently twice',
    why:
      'a canned fallback repeats itself, and by the third time the customer ' +
      'has learned that going off-script is pointless',
    turns: [
      { say: 'dukaan kitne baje tak khuli hai' },
      { say: 'aur delivery ho jayegi kya' },
      { say: 'accha theek hai' },
    ],
  },
  {
    name: 'order and confirm',
    why: 'the tap that used to do nothing at all',
    turns: [
      { say: 'do kilo atta bhej dena', expect: 'Atta' },
      { say: 'haan bhej do', orderStatus: 'CONFIRMED' },
    ],
  },
  {
    name: 'cancel moves the row',
    why: 'a nice message that leaves the row at AWAITING is not a cancel',
    turns: [
      { say: 'do kilo atta bhej dena', expect: 'Total' },
      { say: 'nahi rehne do', orderStatus: 'CANCELLED' },
    ],
  },
  {
    name: 'an amendment is merged, not started over',
    why:
      'a naive machine makes a SECOND order and leaves the first pending ' +
      'forever, so the shop sees work nobody will ever pack',
    turns: [
      { say: 'do kilo atta bhej dena', expect: 'Atta' },
      { say: 'aur ek kilo chini bhi bhej dena', expect: 'Sugar' },
      { say: 'haan', orderStatus: 'CONFIRMED', lines: 2 },
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
      { say: '2 kilo chawal' },
    ],
  },
  {
    name: 'the choice is answered by NAME',
    why:
      'the shop stopped numbering options, so it asks "Basmati ya Sona ' +
      'Masoori?" the way a person would -- and a person answers "basmati"',
    turns: [
      { say: 'do kilo chawal aur do kilo atta' },
      { say: 'sona masoori wala', expect: 'Sona Masoori', lines: 2 },
    ],
  },
  {
    name: 'repeat the last order, by saying so',
    why: 'this used to be menu option 1',
    turns: [
      { say: 'wahi wala order dobara bhej do', expect: 'Total' },
    ],
  },
  {
    name: 'ask about the account, by saying so',
    why: 'this used to be menu option 3',
    turns: [
      { say: 'mera hisaab kitna hua', expect: 'Rs' },
    ],
  },
  {
    name: 'a stock question gets a real answer',
    why:
      'the catalogue is right there, so deflecting "atta hai kya" to the ' +
      'shopkeeper makes the assistant feel useless',
    turns: [
      { say: 'atta hai kya' },
    ],
  },
];

/** the shape of an if/else bot, in one regex */
const MENU = /^\s*\d\s*=/m;

/**
 * When a ledger is attached, the sentence above it must contain NO digits.
 *
 * This is the assertion that catches an invented quantity, and it exists
 * because one got through: asked to confirm two kilos of atta, the shop
 * wrote "Ji, 1 kilo atta bhej dena?" while the list underneath said 2 x.
 * A wrong number in front of a customer is the worst thing this system can
 * do. It is not catchable by reading prose for meaning -- but as a SHAPE
 * it is trivial, which is the whole reason the composer is now blinded to
 * the ledger rather than merely told to ignore it.
 */
const HAS_DIGIT = /\d/;

async function reset() {
  await prisma.conversation.updateMany({
    where: { channel: 'sim', peerPhone: HOUSEHOLD },
    data: { state: 'IDLE', contextJson: Prisma.DbNull },
  });
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function run() {
  let passed = 0;
  let failed = 0;

  for (const c of CASES) {
    await reset();
    console.log(`\n${c.name}`);
    console.log(`  why: ${c.why}`);

    let lastOrderId: string | null = null;
    let ok = true;
    const saidByShop: string[] = [];

    for (const turn of c.turns) {
      const replies = await handle(inbound(turn.say));
      const text = replies.map((r) => r.text).join('\n');

      console.log(`  >  ${turn.say}`);
      console.log(`  <  ${text.replace(/\n/g, '\n     ')}`);

      // the reference the ledger prints, so the assertion can find the row
      // without guessing which order was just made
      const ref = /\(#([a-z0-9]{6})\)/.exec(text)?.[1];
      if (ref) lastOrderId = ref;

      // ---- properties that hold for EVERY reply ----------------------
      if (MENU.test(text)) {
        console.log('     FAIL numbered menu in the reply');
        ok = false;
      }
      // the prose is everything above the ledger, which legitimately
      // repeats itself when an order is restated
      const prose = text.split('\n')[0]!;

      if (text.includes('Total:') && HAS_DIGIT.test(prose)) {
        console.log('     FAIL a digit in the prose above the ledger');
        ok = false;
      }

      if (saidByShop.some((prev) => squash(prev) === squash(prose))) {
        console.log('     FAIL said this exact sentence already');
        ok = false;
      }
      saidByShop.push(prose);

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
