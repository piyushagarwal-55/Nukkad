import { prisma } from '@nukkad/db';
import type { ChannelId, ResolvedLine } from '@nukkad/shared';

/**
 * CONVERSATION STATE, which is the thing that turns a parser into an agent.
 *
 * Before this file existed every card the bot sent offered numbered taps and
 * not one of them did anything. The bot would send "1 = Haan bhej do", the
 * customer would reply "1", and that "1" went into the order extractor as a
 * brand new request -- which found no products in it and answered with the
 * menu. The order stayed at AWAITING forever and nobody could confirm it.
 *
 * The schema already had `state` and `contextJson` on Conversation. Nothing
 * ever wrote to them.
 *
 * TWO RULES SHAPE EVERYTHING HERE.
 *
 * First, a reply to a question is read as an ANSWER FIRST and as a new order
 * second -- but never only as an answer. A customer looking at a confirm
 * card who types "aur ek kilo chini bhi" has not tapped anything, they have
 * amended the order, and a state machine that demands a digit would reject
 * real intent. So every handler that cannot make sense of a reply falls
 * THROUGH to the ordering pipeline rather than complaining. That property is
 * what lets the yes/no vocabulary below stay small without being fragile.
 *
 * Second, an unanswered question is not an order. While the bot is still
 * asking which dal was meant, the lines live here in contextJson and no
 * Order row exists. The row is written when the questions are finished,
 * which is also what keeps half-finished conversations out of the analytics.
 */

/** what the bot is currently waiting to hear back */
export type Pending =
  /**
   * The basket has been read back and the shop is waiting on a yes.
   *
   * Carries no orderId because NO ORDER EXISTS YET. That is the point of
   * the basket: a row is written once, when the customer says send it.
   */
  | { kind: 'CHECKOUT'; askedAt: string }
  | {
      kind: 'DISAMBIGUATE';
      /** every line of the order, including the ones already settled */
      lines: PendingLine[];
      /** which line the question on screen is about */
      index: number;
      /** the options as they were numbered to the buyer, in that order */
      options: Array<{ skuId: string; name: string }>;
      askedAt: string;
      /** carried through so the order row stays attributable to the audio */
      meta: OrderMeta;
    }
  ;

/** a ResolvedLine flattened to something that survives a JSON round trip */
export interface PendingLine {
  sourceText: string;
  quantity: number;
  unitHint: string | null;
  skuId: string | null;
  name: string;
  unitPricePaise: number;
  method: string;
  confidence: number;
  wasSubstituted: boolean;
  alternates: Array<{ skuId: string; name: string; score: number }>;
  needsDisambiguation: boolean;
  /**
   * Set when the options were produced by OPENING A CATEGORY rather than
   * by ranking -- i.e. nothing matched and the shop is eliciting a
   * preference instead of clarifying between candidates. The two are
   * different questions and get different copy.
   */
  elicitedCategory?: string;
  /**
   * How many times the shop has asked about this line.
   *
   * A guard against the worst live failure there is: the same question,
   * forever. Observed five times in a row when an option name was a
   * substring of another and no answer could break the tie. Whatever the
   * cause, a customer must always be able to get past a question.
   */
  asks?: number;
}

/** the provenance an Order row needs, held while questions are outstanding */
export interface OrderMeta {
  source: 'TEXT' | 'VOICE' | 'PHOTO';
  rawText: string | null;
  transcript: string | null;
  asrEngine: string | null;
  mediaPath: string | null;
  startedAt: number;
}

/**
 * How long a question stays open.
 *
 * Not forever, and the reason is concrete rather than tidy. A customer who
 * answers a confirm card twelve hours later is not confirming what they
 * think they are: stock has moved and the shop has closed and reopened. The
 * dangling AWAITING order also sits in the dashboard's pending slice
 * misreporting the shop's day, every day, until someone clears it by hand.
 *
 * Six hours is a shopping-trip length, not a session length.
 */
const PENDING_TTL_MS = 6 * 60 * 60 * 1000;

export const isStale = (p: Pending): boolean =>
  Date.now() - Date.parse(p.askedAt) > PENDING_TTL_MS;

export function flatten(line: ResolvedLine): PendingLine {
  return {
    sourceText: line.sourceText,
    quantity: line.quantity,
    unitHint: line.unitHint,
    skuId: line.chosen?.sku.id ?? null,
    name: line.chosen?.sku.name ?? line.sourceText,
    unitPricePaise: line.chosen?.sku.sellPaise ?? 0,
    method: line.chosen?.method ?? 'UNRESOLVED',
    confidence: line.confidence,
    wasSubstituted: line.chosen?.method === 'SUBSTITUTED',
    alternates: line.alternates.map((a) => ({
      skuId: a.sku.id, name: a.sku.name, score: a.score,
    })),
    needsDisambiguation: line.needsDisambiguation,
  };
}

/** one line of the running transcript, kept so the voice has memory */
export interface Turn {
  role: 'user' | 'shop';
  text: string;
}

export interface Convo {
  id: string;
  /**
   * Mutable on purpose. Handlers set this as they go and the whole
   * conversation is written ONCE at the end of the turn, instead of every
   * branch paying for its own round trip to a database in another region.
   */
  pending: Pending | null;
  recent: Turn[];
  /**
   * THE BASKET, and it is what makes this a shop rather than a form.
   *
   * Items accumulate here across the whole conversation. A customer adds
   * a kilo of dal, asks what sugar costs, adds sugar, asks about tea, and
   * only then says send it -- one basket, one order, the way it works at
   * a counter.
   *
   * Before this existed every request wrote its own Order row at AWAITING
   * and asked "bhej dun?" immediately. Adding a second item CANCELLED the
   * first order and wrote a third, so a three item conversation left two
   * cancelled rows behind and the shopkeeper's dashboard filled up with
   * orders nobody ever placed.
   *
   * Nothing is written to the database until checkout.
   */
  basket: PendingLine[];
  /**
   * The products the shop named in its LAST reply.
   *
   * Exists so "1 kg yeh pack kar do" means something. A customer who has
   * just been told the price of moong dal says "yeh", not "moong dal" --
   * and without a referent that pronoun went to the knowledge base as a
   * product name and came back as DRY YEAST, which the shop then
   * apologised for not stocking.
   *
   * Only the last turn, deliberately. A referent that survives three
   * turns is more likely to be wrong than useful, and the shop asking
   * "kaunsa?" is a much cheaper mistake than silently ordering a thing
   * mentioned two minutes ago.
   */
  lastNamed: Array<{ skuId: string; name: string }>;
}

/**
 * How much of the conversation the voice can see.
 *
 * Small deliberately. It exists so the reply does not repeat the sentence
 * it just sent -- which is the specific thing that makes a bot feel like a
 * bot -- and not so the model can reason over history. Everything that
 * needs remembering properly is in `pending` or in the database.
 */
const RECENT_MAX = 8;

/** what actually lands in contextJson */
interface Stored {
  pending: Pending | null;
  recent: Turn[];
  basket: PendingLine[];
  lastNamed: Array<{ skuId: string; name: string }>;
}

/**
 * Load, creating on first contact. The route also upserts this row before
 * calling in, which is deliberate duplication: the route needs it to hang
 * inbound messages off for idempotency, and the simulator never goes
 * through the route at all. Both paths must work.
 */
export async function loadConvo(
  channel: ChannelId,
  peerPhone: string,
  householdId: string,
  kiranaId: string,
): Promise<Convo> {
  const row = await prisma.conversation.upsert({
    where: { channel_peerPhone: { channel, peerPhone } },
    create: { channel, peerPhone, partyRole: 'HOUSEHOLD', householdId, kiranaId },
    // backfilled on every turn: the route creates this row before anyone
    // knows which shop or household the number belongs to
    update: { householdId, kiranaId },
    select: { id: true, contextJson: true },
  });

  const stored = (row.contextJson as Stored | null) ?? null;
  return {
    id: row.id,
    pending: stored?.pending ?? null,
    recent: stored?.recent ?? [],
    basket: stored?.basket ?? [],
    lastNamed: stored?.lastNamed ?? [],
  };
}

type StateName =
  | 'IDLE' | 'MENU' | 'AWAITING_ORDER_INPUT'
  | 'AWAITING_CONFIRM' | 'AWAITING_DISAMBIGUATION' | 'AWAITING_VETO';

const STATE_OF: Record<Pending['kind'], StateName> = {
  CHECKOUT: 'AWAITING_CONFIRM',
  DISAMBIGUATE: 'AWAITING_DISAMBIGUATION',
};

/**
 * One write per turn, at the end.
 *
 * The recent transcript is trimmed here rather than at every append, so a
 * long conversation cannot grow contextJson without bound.
 */
export async function save(convo: Convo): Promise<void> {
  const stored: Stored = {
    pending: convo.pending,
    recent: convo.recent.slice(-RECENT_MAX),
    basket: convo.basket,
    lastNamed: convo.lastNamed,
  };
  await prisma.conversation.update({
    where: { id: convo.id },
    data: {
      state: convo.pending ? STATE_OF[convo.pending.kind] : 'IDLE',
      contextJson: stored as never,
    },
  });
}
