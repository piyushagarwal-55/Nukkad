import type { Facts } from './compose.js';
import type { Turn } from './state.js';

/**
 * THE RESPONSE DIRECTOR: what this moment FEELS like, as opposed to what
 * is true about it.
 *
 * This layer sits between the facts and the sentence, and it exists
 * because of a failure that is invisible one reply at a time. Told to be
 * warm, the composer became warm and became a machine again in a
 * different way:
 *
 *   Arre, atta bhej dena?          Arre, chini bhi?
 *   Arre, sugar rakh diya.         Arre, order cancel ho gaya.
 *
 * Every one of those is a good sentence. Read together they are worse
 * than the flat ones they replaced, because a tic is a stronger tell than
 * a monotone: the facts changed and the shape did not, which is what a
 * template does. No instruction fixes this class of thing. "Do not repeat
 * yourself" is a request, and the model cannot hear that its own last
 * four replies rhyme.
 *
 * WHAT IS COMPUTED RATHER THAN ASKED FOR. Everything here. The moment
 * comes from the facts, the structure from whether there is genuinely
 * anything to react to, and the avoid-lists from the shop's own recent
 * sentences -- string processing over a transcript already in hand. The
 * model is never asked to notice its habits; it is handed the list.
 *
 * WHY THERE IS NO MODEL CALL IN THIS FILE. A director that costs a round
 * trip costs it on the voice path too, where a turn is already three and
 * a half seconds and the entire argument for streaming was worth a few
 * hundred milliseconds. Style is a decision about a decision that has
 * already been made, and there is nothing in it a second model would know
 * that this one does not.
 *
 * The division of labour running through this codebase is unchanged, and
 * that is the point of restating it here: facts are decided by code,
 * phrasing is chosen by the model, and this file governs the phrasing
 * WITHOUT touching the facts. Nothing below can change what is true, only
 * how it lands.
 */

/**
 * What just happened, conversationally.
 *
 * Not the same question as "what did the shop do" -- ADD is one action
 * and covers both an ordinary line going in and a substitution the
 * customer will not like. Those are different moments wanting different
 * replies, which is exactly what the facts alone could not express.
 */
export type Moment =
  /** they handed the decision back to the shop */
  | 'DELEGATED_CHOICE'
  /** something they wanted is not available, or not in the size they said */
  | 'BAD_NEWS'
  /** it went in, nothing went wrong, nothing to remark on */
  | 'ROUTINE'
  /** it went in BUT something needs explaining: a swap, a pack size, a miss */
  | 'COMPLICATION'
  /** they changed their mind, took something out, called it off */
  | 'CHANGED_MIND'
  /** hello, how are you, thanks */
  | 'SMALL_TALK'
  /** a question the shop cannot answer, or could not follow */
  | 'OFF_SCRIPT'
  /** the order is placed, or the money has landed */
  | 'MILESTONE'
  /** a straight question with a straight answer */
  | 'ANSWERING';

/**
 * Whether a reaction is licensed BEFORE the information.
 *
 * The single most useful field, because the tic came from making the
 * reaction unconditional. A shopkeeper putting a routine kilo of sugar
 * into a bag says "ji" and writes it down; they do not say "arre".
 * Reacting to nothing is not warmth, it is noise, and four in a row is a
 * habit the customer starts hearing instead of the words.
 */
export type Structure = 'REACT_THEN_INFO' | 'INFO_ONLY' | 'INFO_THEN_OFFER';

export type Energy = 'BRISK' | 'CASUAL' | 'CAREFUL' | 'APOLOGETIC';

export interface Delivery {
  moment: Moment;
  structure: Structure;
  energy: Energy;
  /** openings the shop has already used in this conversation */
  avoidOpenings: string[];
  /** closing questions it has already used */
  avoidClosings: string[];
  /** whether to use their name this turn */
  useName: boolean;
}

/** an add that carries something needing explanation */
function complicated(f: Facts): boolean {
  if (f.kind === 'BASKET_ADDED' || f.kind === 'ORDER_DRAFT') {
    return f.substituted.length > 0 || f.packAsks.length > 0 || f.dropped.length > 0;
  }
  return false;
}

function momentOf(f: Facts): Moment {
  switch (f.kind) {
    case 'RECOMMEND':
      return 'DELEGATED_CHOICE';

    case 'GREETING':
      return 'SMALL_TALK';

    /**
     * Reception picking up IS small talk with a job to do, and the
     * missing case here was why the shop stopped using names: momentOf
     * fell through to ANSWERING, which never carries one, so the one
     * desk whose whole role is recognising the caller -- "Namaste
     * Ramesh ji, boliye" -- was structurally barred from saying who it
     * recognised.
     */
    case 'ASK_PURPOSE':
      return 'SMALL_TALK';

    case 'NOT_STOCKED':
    case 'PAYMENT_NOT_SEEN':
    case 'BASKET_EMPTY':
    case 'NO_PREVIOUS_ORDER':
    case 'PHOTO_NOT_A_LIST':
    case 'PHOTO_EMPTY':
    case 'PHOTO_FAILED':
    case 'NO_PHOTO':
      return 'BAD_NEWS';

    case 'STOCK_ANSWER':
      return f.inStock ? 'ANSWERING' : 'BAD_NEWS';

    case 'REJECTED':
    case 'ORDER_CANCELLED':
    case 'ORDER_REPLACED':
      return 'CHANGED_MIND';

    case 'ORDER_CONFIRMED':
    case 'AWAITING_PAYMENT':
      return 'MILESTONE';

    case 'QUESTION':
    case 'NOT_UNDERSTOOD':
    case 'NOT_REGISTERED':
      return 'OFF_SCRIPT';

    case 'BASKET_ADDED':
    case 'ORDER_DRAFT':
      return complicated(f) ? 'COMPLICATION' : 'ROUTINE';

    default:
      return 'ANSWERING';
  }
}

/**
 * The rule that kills the tic: a reaction has to be reacting to
 * something. Only these moments carry news the customer did not already
 * have, and only they get a beat before the information.
 */
const REACTS: ReadonlySet<Moment> = new Set<Moment>([
  'DELEGATED_CHOICE', 'BAD_NEWS', 'COMPLICATION', 'CHANGED_MIND', 'SMALL_TALK',
]);

/** moments where the useful thing is to offer the next step, not to react */
const OFFERS: ReadonlySet<Moment> = new Set<Moment>(['OFF_SCRIPT', 'MILESTONE']);

function energyOf(m: Moment): Energy {
  if (m === 'BAD_NEWS') return 'APOLOGETIC';
  if (m === 'COMPLICATION' || m === 'MILESTONE') return 'CAREFUL';
  if (m === 'SMALL_TALK' || m === 'DELEGATED_CHOICE') return 'CASUAL';
  return 'BRISK';
}

/**
 * The words the shop has already opened with.
 *
 * First word AND first two words, because the habit forms at either
 * length: "Arre," and "Theek hai," are the same failure and only one of
 * them is one word. Lower-cased and stripped of punctuation so "Arre,"
 * and "arre" collapse to one entry, which is how the customer hears them.
 */
function openings(recent: Turn[]): string[] {
  const out = new Set<string>();
  for (const t of recent.filter((x) => x.role !== 'user').slice(-4)) {
    const words = t.text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
    if (words[0]) out.add(words[0]);
    if (words[1]) out.add(`${words[0]} ${words[1]}`);
  }
  return [...out];
}

/**
 * The questions it has already closed with.
 *
 * "Aur kuch chahiye?" is the right thing to ask, and asking it in the
 * same words five times running is the tell. Takes the last question of
 * each reply, which is where a closing lives.
 */
function closings(recent: Turn[]): string[] {
  const out = new Set<string>();
  for (const t of recent.filter((x) => x.role !== 'user').slice(-4)) {
    // the ledger is not speech; only the prose above it has a closing
    const prose = t.text.split('\n\n')[0] ?? '';
    const qs = prose.match(/[^.!?]*\?/g);
    const last = qs?.[qs.length - 1]?.trim();
    if (last && last.length < 60) out.add(last.toLowerCase());
  }
  return [...out];
}

/**
 * WHETHER TO SAY THEIR NAME, decided here rather than left to taste.
 *
 * Told "use it now and then", the model used it in the first two replies
 * and then never again -- the worst of both, because that reads as a
 * greeting macro. Two rules, both checkable: only at a moment carrying
 * some weight, and never when it was used a turn or two ago. Everything
 * else gets no name, which is how people talk across a counter.
 */
function nameThisTurn(m: Moment, recent: Turn[], buyerName: string): boolean {
  if (!buyerName || buyerName.length < 2) return false;

  const weighty =
    m === 'SMALL_TALK' || m === 'BAD_NEWS' || m === 'MILESTONE' || m === 'DELEGATED_CHOICE';
  if (!weighty) return false;

  const needle = buyerName.toLowerCase();
  const usedRecently = recent
    .filter((t) => t.role !== 'user')
    .slice(-3)
    .some((t) => t.text.toLowerCase().includes(needle));

  return !usedRecently;
}

export function direct(facts: Facts, recent: Turn[], buyerName: string): Delivery {
  const moment = momentOf(facts);
  return {
    moment,
    structure: REACTS.has(moment)
      ? 'REACT_THEN_INFO'
      : OFFERS.has(moment)
        ? 'INFO_THEN_OFFER'
        : 'INFO_ONLY',
    energy: energyOf(moment),
    avoidOpenings: openings(recent),
    avoidClosings: closings(recent),
    useName: nameThisTurn(moment, recent, buyerName),
  };
}

const MOMENT_NOTE: Record<Moment, string> = {
  DELEGATED_CHOICE:
    'They have handed the choice back to you. They already said they do'
    + ' not know, so a question back is the one reply that cannot help.',
  BAD_NEWS:
    'You are telling them something they did not want to hear. Do not'
    + ' dress it up and do not apologise twice.',
  ROUTINE:
    'Nothing went wrong and nothing needs explaining. This is a kilo of'
    + ' sugar going into a bag.',
  COMPLICATION:
    'It went in, but something about it needs explaining before they find'
    + ' out from the bill.',
  CHANGED_MIND:
    'They have changed their mind. That is completely normal and you'
    + ' should sound like it is.',
  SMALL_TALK: 'They are being friendly, not ordering. Be a person back.',
  OFF_SCRIPT:
    'They asked something outside what you can answer. Be straight about'
    + ' that rather than filling the space.',
  MILESTONE: 'Something has actually happened. Mark it, briefly.',
  ANSWERING: 'A straight question. Answer it.',
};

const STRUCTURE_NOTE: Record<Structure, string> = {
  REACT_THEN_INFO:
    'React FIRST -- a few words, in their register -- then give the'
    + ' information. The reaction is to what they SAID, not to the fact.',
  INFO_ONLY:
    'NO opening interjection. None. Not "arre", not "achha", not "ji",'
    + ' not "theek hai". Start with the information itself. Reacting to'
    + ' nothing is not warmth, it is a tic, and four in a row is all the'
    + ' customer can hear.',
  INFO_THEN_OFFER:
    'Give the information plainly, then offer the next useful thing.',
};

const ENERGY_NOTE: Record<Energy, string> = {
  BRISK: 'Quick and light. They are mid-shop.',
  CASUAL: 'Unhurried. No transaction is happening this second.',
  CAREFUL: 'Slow down. Money or a mistake is involved.',
  APOLOGETIC: 'Warm, and honest that this is not what they wanted.',
};

/**
 * The plan, as prompt.
 *
 * Written as a SITUATION rather than as a style rule, because "be
 * natural" is not actionable and "they have handed the choice back to
 * you" is. The avoid-lists carry most of the weight: an instruction not
 * to repeat is a request, and a list of the exact words already used is a
 * constraint.
 */
export function deliveryBrief(d: Delivery, buyerName: string): string {
  const lines = [
    'THIS MOMENT:',
    `- ${MOMENT_NOTE[d.moment]}`,
    `- ${STRUCTURE_NOTE[d.structure]}`,
    `- ${ENERGY_NOTE[d.energy]}`,
    d.useName
      ? `- Use their name (${buyerName}) once, naturally.`
      : '- Do NOT use their name this time.',
  ];

  if (d.avoidOpenings.length) {
    lines.push(
      `- You have already opened replies with: ${d.avoidOpenings.map((w) => `"${w}"`).join(', ')}.`
      + ' Do not open with any of those again. Find another way in, or just'
      + ' start with the thing itself.',
    );
  }

  if (d.avoidClosings.length) {
    lines.push(
      `- You have already asked: ${d.avoidClosings.map((q) => `"${q}"`).join(', ')}.`
      + ' Ask differently this time, or do not ask at all.',
    );
  }

  return lines.join('\n');
}
