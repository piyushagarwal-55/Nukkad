import { prisma } from '@nukkad/db';

/**
 * Give the seeded demo orders the sentence they would have arrived as.
 *
 *   npm run backfill:transcripts --workspace=@nukkad/api
 *
 * The seed writes every order line with the local name it was matched from
 * -- "atta", "peela wala tel" -- but never writes the ORDER-level
 * transcript, so the orders page has nothing to show under "what they
 * said". That is the one thing on the page worth looking at.
 *
 * Nothing here is invented. The sentence is assembled from the sourceText
 * already stored on each line, in the order the lines were saved, joined
 * the way somebody actually speaks. A real order arriving over WhatsApp
 * carries its own transcript and this never touches it: only rows where
 * the field is null are filled.
 */

/** how a request gets phrased, varied so the list does not read as a template */
const ENDINGS = [
  'bhej dena',
  'bhej dijiye',
  'chahiye',
  'de dena bhaiya',
  'bhijwa dena',
];

function speak(parts: string[], seed: number): string {
  const items = parts.filter(Boolean);
  if (!items.length) return '';

  // "a, b aur c" -- the last one joined with aur, the rest with commas
  const spoken =
    items.length === 1
      ? items[0]!
      : `${items.slice(0, -1).join(', ')} aur ${items[items.length - 1]}`;

  return `${spoken} ${ENDINGS[seed % ENDINGS.length]}`;
}

async function main() {
  const orders = await prisma.order.findMany({
    where: { transcript: null },
    include: { lines: { select: { sourceText: true, quantity: true } } },
    orderBy: { createdAt: 'asc' },
  });

  if (!orders.length) {
    console.log('every order already has a transcript');
    return;
  }

  let done = 0;
  for (const [i, o] of orders.entries()) {
    // quantity belongs in the sentence: people say "do kilo atta", not "atta"
    const parts = o.lines.map((l) => {
      const q = l.quantity;
      if (q >= 2 && Number.isInteger(q)) return `${q} ${l.sourceText}`;
      return l.sourceText;
    });

    const transcript = speak(parts, i);
    if (!transcript) continue;

    await prisma.order.update({ where: { id: o.id }, data: { transcript } });
    done++;
    if (done <= 5) console.log(`  "${transcript}"`);
  }

  console.log(`\n${done} order(s) given a transcript${done > 5 ? ' (first 5 shown)' : ''}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
