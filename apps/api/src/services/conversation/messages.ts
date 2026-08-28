import { rupeeLabel } from '@nukkad/shared';
import type { PendingLine } from './state.js';
import type { PackAsk } from './compose.js';

/**
 * TWO KINDS OF TEXT LIVE HERE, and they are not the same kind of thing.
 *
 * THE LEDGER. `orderCard` renders quantities, product names and the total.
 * It is plain code and it always will be. Every rupee a customer reads is
 * computed here and appended to the reply verbatim, so no model is ever in
 * a position to round a total, drop a line, or invent a price. See
 * ./compose.ts for the rule; this file is the half that enforces it.
 *
 * THE FALLBACKS. The flat strings below are what gets sent if the composer
 * call fails. They are the old canned replies, kept for exactly that, and
 * they are why an outage costs the shop a duller sentence rather than a
 * dropped message. They are not the normal path any more. Nothing here
 * offers a numbered menu.
 */

/** The knock. Must map 1:1 to a Meta-approved template. Variables only. */
export const TEMPLATE_REORDER = {
  name: 'nukkad_reorder_nudge',
  body: 'Namaste {{1}}, {{2}} din ho gaye pichhle order ko. Dobara bhejne ke liye reply karein.',
};

/**
 * The ledger. Substitutions are marked because a customer who is handed
 * Dhara when they asked for Fortune must see that before they agree, not
 * when the bag arrives.
 */
export function orderCard(lines: PendingLine[]): string {
  const rows = lines.map((l) => {
    const sub = l.wasSubstituted ? '  (badla gaya)' : '';
    return `  ${l.quantity} x ${l.name}${sub}`;
  });
  const total = lines.reduce((s, l) => s + l.unitPricePaise * l.quantity, 0);

  return [...rows, '', `Total: ${rupeeLabel(Math.round(total))}`].join('\n');
}

// ---- fallbacks, used only when the composer call fails ----------------

export const GREETING = 'Namaste. Bataiye, kya chahiye?';

export const NOT_REGISTERED =
  'Aapka number register nahi hai. Apne dukaandaar se poochhein.';

export const NO_PHOTO =
  'Abhi photo nahi padh sakte. Bol kar ya likh kar bhej dijiye.';

export const PHOTO_NOT_A_LIST =
  'Is photo mein list nahi dikh rahi. List bhej dijiye ya likh dijiye.';

export const PHOTO_EMPTY =
  'Photo saaf nahi hai, padha nahi gaya. Thoda paas se ek aur bhej dijiye.';

export const PHOTO_FAILED =
  'Photo khul nahi payi. Dobara bhej dijiye ya likh dijiye.';

export const NOT_UNDERSTOOD =
  'Maaf kijiye, samajh nahi aaya. Naam aur maatra likh dijiye, jaise "2 kilo atta".';

export const QUESTION =
  'Ye dukaandaar se pooch kar bata denge. Tab tak order likhwa dijiye.';

export const CANCELLED = 'Theek hai, cancel kar diya.';

export const SEND_AGAIN = 'Theek hai, wo cancel kar diya. Poori list dobara bhej dijiye.';

export const STILL_WAITING = 'Order abhi bheja nahi hai. Bhej dun?';

export const NO_PREVIOUS_ORDER =
  'Abhi tak koi purana order nahi hai. Likh kar bata dijiye kya chahiye.';

/**
 * The confirm prompt, and the ONE fallback that is not merely a duller
 * version of what the composer would have said.
 *
 * A pack mismatch has to reach the customer. Measured over four runs of
 * "do kilo atta" against a shop selling 5kg bags, the composer said so
 * three times and fell back to a generic line once -- a 25% chance of
 * quietly handing someone five kilos when they asked for two. So the
 * sentence is built here, from the same facts, and the model's version is
 * an improvement on it rather than the only source of it.
 */
export const BASKET_EMPTY =
  'Abhi basket khali hai. Bataiye kya chahiye?';

/** what went in the bag, and the invitation to keep going */
export const addedToBasket = (added: string[], packAsks: PackAsk[] = []): string => {
  const what = added.join(' aur ');
  if (!packAsks.length) return `${what} daal diya. Aur kuch chahiye?`;
  const a = packAsks[0]!;
  return `Aapne ${a.asked} kaha, ye ${a.sold} ke packet mein aata hai. Daal diya. Aur kuch chahiye?`;
};

export const readyToSend = (packAsks: PackAsk[] = []): string => {
  if (!packAsks.length) return 'Ye lijiye. Bhej dun?';
  const a = packAsks[0]!;
  // the product name is on the card below and usually carries the pack
  // size already, so repeating both reads as "Atta 5kg 5 kg ke packet"
  return `Aapne ${a.asked} kaha, ye ${a.sold} ke packet mein aata hai. Bhej dun?`;
};

/**
 * Checked out, link sent. Careful with the wording: this order is NOT
 * confirmed, and telling someone it is before their money has arrived is
 * the one thing the whole payment path exists to avoid.
 */
export const awaitingPayment = (totalPaise: number, link: string | null): string =>
  link
    ? `Total ${rupeeLabel(totalPaise)}. Pay karne ke liye: ${link}
Paise aate hi order pakka ho jayega.`
    : `Total ${rupeeLabel(totalPaise)}. Online link abhi nahi ban paya, saamaan aane par de dijiye.`;

/**
 * The slip that follows the reply: total, link, reference. Code-rendered
 * for the same reason the order card is -- a model that paraphrases a
 * URL sends the customer nowhere.
 */
export const paymentSlip = (totalPaise: number, link: string | null, ref: string): string =>
  [
    `Total: ${rupeeLabel(totalPaise)}`,
    link ? `Pay: ${link}` : 'Saamaan aane par de dijiye.',
    `(#${ref})`,
  ].join('\n');

export const PAYMENT_NOT_SEEN =
  'Abhi tak payment nahi dikha. Ek minute lagta hai kabhi kabhi -- aate hi order apne aap chala jayega.';

export const NO_PAYMENT_PENDING =
  'Abhi koi payment baaki nahi hai. Kuch chahiye to bataiye.';

export const confirmed = (totalPaise: number, ref: string): string =>
  `Order confirm ho gaya. Total ${rupeeLabel(totalPaise)}. (#${ref})`;

export const account = (orders: number, spent: string): string =>
  `Ab tak ${orders} order. Kul ${spent}.`;

export const notStocked = (product: string): string =>
  `${product} hum abhi nahi rakhte. Aur kuch chahiye?`;

export const rejected = (name: string): string =>
  `Theek hai, ${name} nahi. Aur kya dekhun?`;

export const prices = (items: Array<{ name: string; price: string }>): string =>
  `${items.map((i) => `${i.name} ${i.price}`).join(', ')}. Kaun sa chahiye?`;

export const listing = (names: string[]): string =>
  `${names.join(', ')} hai. Kaun sa chahiye?`;

/**
 * Reception's fallback, and note what is not in it: no product, no
 * category, no price. This desk has no catalogue and its words should
 * not imply otherwise.
 */
export const ASK_PURPOSE = 'Namaste ji, boliye. Kya kaam tha aaj?';

export const recommend = (name: string, price: string, why: string): string =>
  why ? `${name} ${price} le lijiye, ${why}. Kitna bhejun?`
      : `${name} ${price} le lijiye. Kitna bhejun?`;

export const catalogue = (categories: string[]): string =>
  `Humare paas ${categories.join(', ')} sab hai. Bataiye kya chahiye?`;

export const askWhich = (sourceText: string, names: string[]): string =>
  `"${sourceText}" mein se kaunsa? ${names.join(', ')}`;

export const stockAnswer = (name: string, inStock: boolean): string =>
  inStock ? `${name} hai. Kitna bhejun?` : `${name} abhi khatam hai.`;

export const outOfStock = (name: string, alt: string): string =>
  `${name} abhi khatam hai. ${alt} bhej dun?`;

export const paymentLine = (url: string, totalPaise: number): string =>
  `Order confirm ho gaya. Total ${rupeeLabel(totalPaise)}.\nAbhi pay karna ho to: ${url}\nYa saamaan aane par de dijiye.`;

/** Tier 2. Silence is consent, which is the only honest form of no-effort. */
export const vetoNotice = (hours: number, totalPaise: number): string =>
  `Aapka order ${hours} ghante mein ja raha hai. Total ${rupeeLabel(totalPaise)}.\nRokne ke liye STOP bhejein, badalne ke liye 2.`;
