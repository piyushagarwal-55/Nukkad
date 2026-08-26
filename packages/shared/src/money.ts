/**
 * All money in this codebase is an integer number of PAISE.
 * Razorpay's API is paise too, so nothing converts at the boundary.
 * Never use a float for money.
 */
export type Paise = number;

export const rupeesToPaise = (r: number): Paise => Math.round(r * 100);
export const paiseToRupees = (p: Paise): number => p / 100;

/** Indian digit grouping, no decimals when whole. For WhatsApp copy. */
export function formatINR(p: Paise): string {
  const r = p / 100;
  const whole = Number.isInteger(r);
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(r);
}

export const rupeeLabel = (p: Paise): string => 'Rs ' + formatINR(p);
