import type { Sku } from '@nukkad/shared';

/**
 * HOW MUCH THEY ASKED FOR versus HOW IT IS SOLD.
 *
 * The catalogue has carried packSize and unit since the first migration and
 * nothing ever read them. Every quantity in the system was treated as a
 * count of packets, whatever unit the customer actually used, and the bill
 * for that arrived in a photographed shopping list:
 *
 *     paper: Flour 5 kg        ordered: 5 x Aashirvaad Atta 5kg   (25 kg)
 *     paper: Tea   500 g       ordered: 250 x Tata Tea Gold 500g  (125 kg)
 *     total: Rs 79,055.65
 *
 * It is not a photo bug. "do kilo atta" through the text path meant two
 * FIVE-KILO packets, and every test passed because they all counted lines
 * and none of them read the quantity.
 *
 * THE HARD PART IS NOT THE ARITHMETIC, IT IS WHAT TO DO WHEN IT DOES NOT
 * DIVIDE.
 *
 * Two kilos of atta from a shop that sells five-kilo packets is not an
 * order, it is a conversation. Rounding it silently either short-changes
 * the customer or bills them for three kilos they did not ask for, and
 * both are the kind of thing that loses a kirana a regular. So a fit that
 * does not divide is reported as such and the shop ASKS -- which is the
 * same rule the ranker already follows for an uncertain product, applied
 * to an uncertain amount.
 */

/** grams and millilitres, because a shop weighs in one and pours the other */
const IN_GRAMS: Record<string, number> = {
  kg: 1000, kilo: 1000, kilos: 1000, kilogram: 1000, g: 1, gm: 1, gram: 1, grams: 1,
};
const IN_ML: Record<string, number> = {
  l: 1000, ltr: 1000, litre: 1000, liter: 1000, ml: 1,
};

/**
 * Units that mean "one of the things on the shelf" rather than an amount.
 * A customer saying "do packet maggi" has already done this conversion.
 */
const COUNTING = new Set([
  'packet', 'packets', 'pkt', 'pack', 'packs', 'piece', 'pieces', 'pc', 'pcs',
  'bottle', 'bottles', 'box', 'boxes', 'dozen', 'unit', 'units', 'item',
]);

const clean = (u: string | null) => (u ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');

/** the amount, in grams or millilitres, or null when it is a count */
function amount(quantity: number, unit: string | null): { base: number; kind: 'mass' | 'volume' } | null {
  const u = clean(unit);
  if (!u || COUNTING.has(u)) return null;
  if (IN_GRAMS[u]) return { base: quantity * IN_GRAMS[u]!, kind: 'mass' };
  if (IN_ML[u]) return { base: quantity * IN_ML[u]!, kind: 'volume' };
  return null;
}

export interface PackFit {
  /** how many packets to actually put in the order */
  units: number;
  /**
   * false when the requested amount does not divide into whole packets.
   * The shop must ASK rather than round, see the note above.
   */
  exact: boolean;
  /** what they asked for, phrased for the question: "2 kg" */
  asked: string;
  /** how the shop sells it: "5 kg" */
  sold: string;
}

/**
 * Turn "5 kg of flour" into "1 packet of Atta 5kg".
 *
 * Returns exact:true and the quantity unchanged whenever the request is
 * already a count, or the units are not comparable -- a request in kg
 * against a SKU sold by the piece cannot be converted, and inventing a
 * conversion there would be worse than leaving it alone.
 */
/**
 * The pack size written into the NAME, when the fields do not have it.
 *
 * Not defensive programming for its own sake -- the catalogue really is
 * like this. A SKU created by applying a supplier bill gets its name from
 * the invoice and its pack fields left at the default, so the shop holds:
 *
 *     India Gate Basmati Rice 5kg    packSize=5  unit=kg     <- seeded
 *     Basmati Rice 5kg               packSize=1  unit=pc     <- from a bill
 *
 * The second one says 5kg in its name and claims to be one piece, so
 * "Rice 5 kg" against it converted to five packets: twenty-five kilos of
 * rice, on a card, for a customer who asked for five.
 *
 * Reading the name is the fix that works on the rows that already exist.
 * The bill-apply path should also stop creating them, which is a separate
 * change in a separate place.
 */
const PACK_IN_NAME = /(\d+(?:\.\d+)?)\s*(kg|g|gm|ml|l|ltr)\b/i;

function declaredPack(sku: Sku): { size: number; unit: string } {
  const own = clean(sku.unit);
  if (IN_GRAMS[own] || IN_ML[own]) return { size: sku.packSize, unit: sku.unit };

  const m = PACK_IN_NAME.exec(sku.name);
  if (m) return { size: Number(m[1]), unit: m[2]!.toLowerCase() };

  return { size: sku.packSize, unit: sku.unit };
}

export function fitPack(quantity: number, unitHint: string | null, sku: Sku): PackFit {
  const declared = declaredPack(sku);
  const want = amount(quantity, unitHint);
  const pack = amount(declared.size, declared.unit);

  const sold = `${declared.size} ${declared.unit}`;
  const asked = unitHint ? `${quantity} ${unitHint}` : String(quantity);

  // a count, or units that do not compare: take the number as given
  if (!want || !pack || want.kind !== pack.kind || pack.base <= 0) {
    return { units: quantity, exact: true, asked, sold };
  }

  const ratio = want.base / pack.base;
  const whole = Math.round(ratio);

  /**
   * A hair under a whole number is a rounding artefact, not a request.
   * 0.999 packets is one packet; 0.4 packets is a question.
   */
  if (whole >= 1 && Math.abs(ratio - whole) < 0.01) {
    return { units: whole, exact: true, asked, sold };
  }

  /**
   * Round UP, never down, and flag it. Rounding up at least gives them
   * what they asked for plus some; rounding down hands over less than the
   * amount they said out loud, which no shopkeeper would do. Either way
   * the shop says so, so the customer decides.
   */
  return { units: Math.max(1, Math.ceil(ratio)), exact: false, asked, sold };
}
