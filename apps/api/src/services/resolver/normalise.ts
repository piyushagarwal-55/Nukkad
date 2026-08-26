/**
 * Hinglish romanisation is not standardised. The same product is written
 * atta / aata / aatta, tel / tail, cheeni / chini / chinni. Folding these
 * before scoring is the single cheapest accuracy win available, worth
 * more than any embedding model on a 400-item catalogue.
 */
const FOLD: Array<[RegExp, string]> = [
  [/aa+/g, 'a'], [/ee+/g, 'i'], [/oo+/g, 'u'], [/ii+/g, 'i'],
  [/kh/g, 'k'], [/gh/g, 'g'], [/dh/g, 'd'], [/th/g, 't'], [/bh/g, 'b'], [/ph/g, 'f'],
  [/w/g, 'v'], [/z/g, 'j'], [/ck/g, 'k'], [/y$/g, 'i'],
];

const STOP = new Set([
  'wala', 'wali', 'vala', 'vali', 'wo', 'vo', 'ye', 'yeh', 'ka', 'ki', 'ke',
  'ek', 'aur', 'bhi', 'bhej', 'dena', 'do', 'chahiye', 'packet', 'pack',
]);

export function normalise(s: string): string {
  let out = s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ');
  for (const [re, to] of FOLD) out = out.replace(re, to);
  return out.replace(/\s+/g, ' ').trim();
}

export function tokens(s: string): string[] {
  return normalise(s).split(' ').filter((t) => t.length > 1 && !STOP.has(t));
}
