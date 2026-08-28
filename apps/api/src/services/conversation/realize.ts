import type { Facts } from './compose.js';
import type { Delivery } from './director.js';

/**
 * THE FAST PATH: outcomes that were already decided, said without asking
 * a model to say them.
 *
 * Measured, on the turn a customer takes most often:
 *
 *   route      160ms   cached
 *   policy     600ms   a closed enum, and it earns its keep
 *   resolve    300ms   the ladder
 *   compose   400-1600ms
 *   tts        700ms
 *
 * The composer is the largest single item and on these turns it is being
 * asked to convert {added: ["Atta"]} into "Atta rakh diya" -- a sentence
 * with no judgement in it, no reason to give, nothing to weigh. A second
 * of somebody else's queue to render a fact we already hold.
 *
 * WHY THIS IS NOT THE IF/ELSE BOT WE DELETED, and the distinction is the
 * whole file. That bot had ONE string per branch, so the third time a
 * customer went off script they read the same sentence a third time and
 * learned that going off script was pointless. What made it a form was
 * not that the strings were fixed. It was that they never varied and
 * nobody was checking.
 *
 * The Director already computes what has been said recently -- see
 * avoidOpenings in director.ts, lifted off the shop's own last four
 * replies. The LLM gets that list as a constraint. So does this: a
 * variant whose opening has just been used is not eligible, and when
 * every variant is ineligible this returns null and the composer runs
 * after all. Repetition is therefore impossible rather than discouraged,
 * which is a stronger guarantee than the prompt gets.
 *
 * WHAT IS NEVER REALIZED HERE. Anything requiring judgement: a
 * substitution needs its reason, an ambiguity needs a question, a
 * recommendation needs to say why, a customer going off script needs a
 * person. The Director's `moment` already draws that line -- ROUTINE
 * means "nothing went wrong and nothing needs explaining", which is the
 * fast-path predicate stated in the vocabulary we already had.
 */

/** every variant carries its own opening word, so eligibility is cheap */
interface Variant {
  /** first word, lowercased, matched against the Director's avoid list */
  opening: string;
  text: string;
}

/**
 * SCRIPT MIRRORING IS THE ONE THING A TEMPLATE CANNOT DO.
 *
 * The composer is told to answer in the script it was addressed in,
 * because someone who types "daal kaunsi kaunsi h" cannot necessarily
 * READ Devanagari and the reverse is just as true. A fixed Roman string
 * has no way to honour that.
 *
 * So Devanagari in means the composer, always. Roman covers the ASR
 * output -- Sarvam runs in translit mode -- and the overwhelming majority
 * of typed Hinglish, which is what this path exists for.
 */
function roman(said: string): boolean {
  return !/[ऀ-ॿ]/.test(said);
}

const list = (xs: string[]): string =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} aur ${xs[xs.length - 1]}`;

/**
 * The variants, per fact.
 *
 * Written as a shopkeeper writes, which is the same brief the composer
 * gets: things are rakh diya and likh liya, never "added to your basket".
 * Returns nothing for any fact this path may not handle.
 */
function variantsFor(f: Facts, named: string | null): Variant[] {
  switch (f.kind) {
    /**
     * Only the uncomplicated add. A swap, a pack-size question or a line
     * the shop could not match all need explaining, and explaining is
     * the composer's job -- see `complicated` in director.ts, which is
     * the same test stated as a moment.
     */
    case 'BASKET_ADDED': {
      if (f.substituted.length || f.packAsks.length || f.dropped.length) return [];
      const what = list(f.added);
      if (!what) return [];
      /**
       * Whole thoughts, not fragments. "Sugar rakh diya. Kuch aur?" is
       * fine in a chat bubble and curt when spoken -- these lines go
       * through the mouth verbatim, so they carry the full sentence a
       * person would actually say across a counter.
       */
      return [
        { opening: 'ji', text: `Ji, ${what} rakh diya hai aapke liye. Aur kuch groceries bhi leni hain, ya filhaal itna hi?` },
        { opening: 'ho', text: `Ho gaya, ${what} likh liya hai order mein. Bataiye, aur kya kya chahiye aapko?` },
        { opening: what.split(' ')[0]!.toLowerCase(), text: `${what} daal diya hai bag mein. Aur kuch bhi chahiye ho to bolte jaiye.` },
        { opening: 'theek', text: `Theek hai ji, ${what} note kar liya hai. Aur kuch lena ho to bata dijiye.` },
      ];
    }

    case 'ORDER_CANCELLED':
      return [
        { opening: 'koi', text: 'Koi baat nahi, cancel kar diya. Jab chahiye ho bata dijiye.' },
        { opening: 'theek', text: 'Theek hai, hata diya. Aur kuch ho to bataiye.' },
        { opening: 'ji', text: 'Ji, order cancel. Kabhi bhi bata dena.' },
      ];

    case 'BASKET_EMPTY':
      return [
        { opening: 'abhi', text: 'Abhi to kuch liya hi nahi. Kya chahiye?' },
        { opening: 'thaila', text: 'Thaila khali hai ji. Bataiye kya bhejun?' },
        { opening: 'kuch', text: 'Kuch rakha hi nahi abhi. Kya chahiye aapko?' },
      ];

    /**
     * In stock only. "Khatam hai" is bad news, and the Director marks bad
     * news APOLOGETIC for a reason -- how you say a no matters more than
     * how you say a yes, so that one keeps the composer.
     */
    case 'STOCK_ANSWER': {
      if (!f.inStock) return [];
      /**
       * BROWSING, NOT BUYING. These used to end in "Kitna bhejun?" --
       * the quantity push at somebody who only asked what the shelf
       * holds, which is the single most machine-like habit this shop
       * had. A stock answer offers MORE INFORMATION, not a transaction;
       * the customer says when they want it in the bag.
       */
      return [
        { opening: 'ji', text: `Ji haan, ${f.name} hai humare paas, ${f.price} ka. Aap chahein to aur options bhi bata doon?` },
        { opening: 'hai', text: `Hai ji bilkul, ${f.name} ${f.price} ka mil jayega. Koi aur cheez bhi dekhni ho to bataiye.` },
        { opening: f.name.split(' ')[0]!.toLowerCase(), text: `${f.name} available hai ji, ${f.price} ka. Aur kuch jaanna ho iske baare mein to pooch lijiye.` },
      ];
    }

    /**
     * The first turn of every conversation, and the most deterministic
     * reply in the system: there is nothing to look up and nothing to
     * weigh. It was costing an LLM call ranging 1925ms to 5321ms, which
     * is the worst possible place to spend it -- a caller's first
     * impression is how long the shop takes to say hello.
     *
     * The name is the Director's call, not this file's. See
     * nameThisTurn(): a greeting is a weighty moment, so it usually
     * carries one, and never twice running.
     */
    /**
     * RECEPTION PICKING UP. Note what none of these contain: a product,
     * a category, or a request for an order. This desk does not know
     * what is on the shelf and must not sound like it does.
     */
    case 'ASK_PURPOSE': {
      const you = named ? ` ${named}` : '';
      return [
        { opening: 'namaste', text: `Namaste${you}! Boliye, aaj kya kaam tha aapka?` },
        { opening: 'haan', text: `Haan ji${you}, kahiye. Kis cheez ke liye phone kiya aapne?` },
        { opening: 'ji', text: `Ji${you}, bataiye. Main kya madad kar sakta hoon aapki?` },
        { opening: 'arre', text: `Arre${you}, kaise hain aap? Bataiye, kya kaam tha aaj?` },
      ];
    }

    case 'GREETING': {
      const you = named ? ` ${named}` : '';
      return [
        { opening: 'namaste', text: `Namaste${you}! Kya chahiye aaj?` },
        { opening: 'haan', text: `Haan ji${you}, bataiye kya bhejun?` },
        { opening: 'arre', text: `Arre${you}, kaise hain? Kuch chahiye to bata dijiye.` },
        { opening: 'ji', text: `Ji${you}, kahiye. Kya nikaalun?` },
      ];
    }

    case 'ACCOUNT':
      return [
        { opening: 'ab', text: `Ab tak ${f.orders} order, kul ${f.spent}.` },
        { opening: 'aapke', text: `Aapke ${f.orders} order hue hain, ${f.spent} ka saamaan.` },
      ];

    default:
      return [];
  }
}

/**
 * A sentence for this fact, or null to let the composer write one.
 *
 * Null is the safe answer and it is returned generously: an unhandled
 * fact, a script this cannot mirror, or -- the interesting one -- a set
 * of variants that have all been used recently. The last is what keeps
 * this from becoming the thing it replaced.
 */
export function realize(
  facts: Facts,
  delivery: Delivery,
  said: string,
  name: string,
): string | null {
  if (!roman(said)) return null;

  const variants = variantsFor(facts, delivery.useName ? name : null);
  if (!variants.length) return null;

  const used = new Set(delivery.avoidOpenings);
  const fresh = variants.filter((v) => !used.has(v.opening));

  // every way of saying this has just been said. Ask for a new one.
  if (!fresh.length) return null;

  /**
   * Chosen by hashing what they SAID, not at random.
   *
   * A demo has to be reproducible, and a bug that appears one turn in
   * four is a bug nobody can hold still long enough to fix. The same
   * sentence in the same conversational position picks the same variant
   * every time, while different messages spread across the set.
   */
  let h = 0;
  for (const ch of said) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return fresh[h % fresh.length]!.text;
}
