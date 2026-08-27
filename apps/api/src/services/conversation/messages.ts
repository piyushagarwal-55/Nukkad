import { rupeeLabel } from '@nukkad/shared';
import type { PendingLine } from './state.js';

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

export const NOT_UNDERSTOOD =
  'Maaf kijiye, samajh nahi aaya. Naam aur maatra likh dijiye, jaise "2 kilo atta".';

export const QUESTION =
  'Ye dukaandaar se pooch kar bata denge. Tab tak order likhwa dijiye.';

export const CANCELLED = 'Theek hai, cancel kar diya.';

export const SEND_AGAIN = 'Theek hai, wo cancel kar diya. Poori list dobara bhej dijiye.';

export const STILL_WAITING = 'Order abhi bheja nahi hai. Bhej dun?';

export const NO_PREVIOUS_ORDER =
  'Abhi tak koi purana order nahi hai. Likh kar bata dijiye kya chahiye.';

export const readyToSend = (): string => 'Ye lijiye. Bhej dun?';

export const confirmed = (totalPaise: number, ref: string): string =>
  `Order confirm ho gaya. Total ${rupeeLabel(totalPaise)}. (#${ref})`;

export const account = (orders: number, spent: string): string =>
  `Ab tak ${orders} order. Kul ${spent}.`;

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
