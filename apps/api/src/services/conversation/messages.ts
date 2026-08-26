import { rupeeLabel } from '@nukkad/shared';
import type { ResolvedLine } from '@nukkad/shared';

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
 */

/** The knock. Must map 1:1 to an approved template. Variables only. */
export const TEMPLATE_REORDER = {
  name: 'nukkad_reorder_nudge',
  body: 'Namaste {{1}}, {{2}} din ho gaye pichhle order ko. Dobara bhejne ke liye reply karein.',
};

export const menu = (name: string): string =>
  `Namaste ${name}. Kya karna hai?`;

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
export function confirmCard(lines: ResolvedLine[], totalPaise: number): string {
  const rows = lines.map((l) => {
    const sku = l.chosen?.sku;
    if (!sku) return `  ?  ${l.sourceText}  (samajh nahi aaya)`;
    const sub = l.chosen?.method === 'SUBSTITUTED' ? '  (badla gaya)' : '';
    return `  ${l.quantity} x ${sku.name}${sub}`;
  });

  return [
    'Aapka order:',
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

/** Low confidence goes to the buyer as taps. Never a silent guess. */
export function disambiguation(line: ResolvedLine): string {
  const opts = [line.chosen, ...line.alternates]
    .filter(Boolean)
    .map((c, i) => `${i + 1} = ${c!.sku.name}`);
  return [`"${line.sourceText}" ka matlab?`, '', ...opts, `${opts.length + 1} = Koi nahi`].join('\n');
}

export const outOfStock = (name: string, alt: string): string =>
  `${name} abhi khatam hai. ${alt} bhej dun?`;

export const paymentLine = (url: string, totalPaise: number): string =>
  `Order confirm ho gaya. Total ${rupeeLabel(totalPaise)}.\nAbhi pay karna ho to: ${url}\nYa saamaan aane par de dijiye.`;

/** Tier 2. Silence is consent, which is the only honest form of no-effort. */
export const vetoNotice = (hours: number, totalPaise: number): string =>
  `Aapka order ${hours} ghante mein ja raha hai. Total ${rupeeLabel(totalPaise)}.\nRokne ke liye STOP bhejein, badalne ke liye 2.`;
