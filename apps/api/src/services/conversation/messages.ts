import { rupeeLabel } from '@nukkad/shared';
import type { PendingLine } from './state.js';

/**
 * All buyer-facing copy in one file so it can be reviewed by an actual
 * Hindi speaker in one sitting rather than hunted through the codebase.
 *
 * CONSTRAINT THAT SHAPES EVERYTHING HERE: Meta requires a PRE-APPROVED
 * TEMPLATE with fixed body text and numbered variable slots for any
 * business-initiated message sent outside the 24h session window. The
 * model is mechanically barred from writing that message. So the knock is
 * a dumb template, and all the intelligence lives INSIDE the session once
 * the buyer replies.
 *
 * SECOND CONSTRAINT, learned the hard way on the dashboard: never offer a
 * choice the system will not honour. A card that lists four taps and acts
 * on none of them is worse than a card with no taps, because the customer
 * spends their patience finding that out. Every option below is wired to
 * something in core.ts, including the ones that answer "not yet".
 */

/** The knock. Must map 1:1 to an approved template. Variables only. */
export const TEMPLATE_REORDER = {
  name: 'nukkad_reorder_nudge',
  body: 'Namaste {{1}}, {{2}} din ho gaye pichhle order ko. Dobara bhejne ke liye reply karein.',
};

export const menu = (name: string): string =>
  `Namaste ${name}. Kya karna hai?`;

export const menuAgain = (): string =>
  'Number bhej dijiye, ya seedha likh dijiye kya chahiye.';

export const MENU_OPTIONS = [
  { id: '1', label: 'Pichhla order dobara bhejo' },
  { id: '2', label: 'Naya order (likh kar ya bol kar)' },
  { id: '3', label: 'Mera hisaab dekho' },
  { id: '4', label: 'Automatic order set karo' },
];

/**
 * The confirm card. Stock has ALREADY been checked and substitutions
 * ALREADY resolved before this renders, so the buyer sees reality once
 * and taps once. Going back twice is what makes a demo look broken.
 */
export function confirmCard(
  lines: PendingLine[],
  totalPaise: number,
  amended = false,
): string {
  const rows = lines.map((l) => {
    const sub = l.wasSubstituted ? '  (badla gaya)' : '';
    return `  ${l.quantity} x ${l.name}${sub}`;
  });

  return [
    // the heading changes so an amended card is not mistaken for a second
    // order, which is what it looked like before amendments were merged
    amended ? 'Theek hai, ab order aisa hai:' : 'Aapka order:',
    ...rows,
    '',
    `Total: ${rupeeLabel(totalPaise)}`,
  ].join('\n');
}

export const CONFIRM_OPTIONS = [
  { id: '1', label: 'Haan, bhej do' },
  { id: '2', label: 'Badlaav karna hai' },
  { id: '3', label: 'Cancel' },
];

export const confirmed = (totalPaise: number, ref: string): string =>
  `Order confirm ho gaya. Total ${rupeeLabel(totalPaise)}. (#${ref})\nDukaan se nikalte hi bata denge.`;

export const cancelled = (): string =>
  'Order cancel kar diya. Kuch aur chahiye to bata dijiye.';

/**
 * "Badlaav karna hai" cancels and asks for the whole list again, and says
 * so out loud. Pretending to hold a half-edited order and then quietly
 * dropping a line is the kind of thing that costs a shop a customer.
 */
export const sendAgain = (): string =>
  'Theek hai, wo order cancel kar diya. Poori list dobara bhej dijiye.';

export const stillWaiting = (): string =>
  'Order abhi bheja nahi hai. Bhejun?';

/** Low confidence goes to the buyer as taps. Never a silent guess. */
export function disambiguation(sourceText: string, names: string[]): string {
  const opts = names.map((n, i) => `${i + 1} = ${n}`);
  return [`"${sourceText}" ka matlab?`, '', ...opts, `${opts.length + 1} = Koi nahi`].join('\n');
}

export const nothingUnderstood = (): string =>
  'Maaf kijiye, samajh nahi aaya. Naam aur maatra likh dijiye, jaise "2 kilo atta".';

export const askForOrder = (): string =>
  'Batayiye kya chahiye. Likh dijiye ya voice note bhej dijiye.';

export const noPreviousOrder = (): string =>
  'Abhi tak koi purana order nahi hai. Pehli baar likh kar bata dijiye.';

export const account = (orders: number, spentPaise: number): string =>
  `Ab tak ${orders} order. Kul ${rupeeLabel(spentPaise)}.`;

/**
 * Autonomy tier is the shopkeeper's setting, not the customer's, because
 * it decides whether the shop ships goods nobody explicitly asked for.
 * Saying "not yet" is honest; wiring a tap to it would not be.
 */
export const autoOrderNotYet = (): string =>
  'Automatic order abhi dukaandaar hi chalu karte hain. Unse keh dijiye, wo laga denge.';

export const outOfStock = (name: string, alt: string): string =>
  `${name} abhi khatam hai. ${alt} bhej dun?`;

export const paymentLine = (url: string, totalPaise: number): string =>
  `Order confirm ho gaya. Total ${rupeeLabel(totalPaise)}.\nAbhi pay karna ho to: ${url}\nYa saamaan aane par de dijiye.`;

/** Tier 2. Silence is consent, which is the only honest form of no-effort. */
export const vetoNotice = (hours: number, totalPaise: number): string =>
  `Aapka order ${hours} ghante mein ja raha hai. Total ${rupeeLabel(totalPaise)}.\nRokne ke liye STOP bhejein, badalne ke liye 2.`;
