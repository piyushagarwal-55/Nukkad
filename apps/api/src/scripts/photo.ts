import 'dotenv/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { prisma } from '@nukkad/db';
import { resetConvo } from '../services/conversation/state.js';
import { handle } from '../services/conversation/core.js';
import { parseList } from '../services/vision/list.js';

/**
 * PHOTOGRAPHED SHOPPING LISTS, end to end.
 *
 *   npm run photo --workspace=@nukkad/api
 *
 * Exists because the WhatsApp line silently could not do this at all. A
 * photo arrived, the code checked whether vision was UNAVAILABLE, found it
 * available, and had no branch for that -- so the image was dropped, the
 * text stayed empty, and the message fell through to the empty-message
 * path. Someone sent a picture of their grocery list and the shop replied
 * "kya haal hai".
 *
 * TWO THINGS ARE CHECKED, and the second is the one that matters.
 *
 * Reading the paper is OCR, and it is reported separately so a reading
 * failure is never mistaken for a resolution failure. Landing on the right
 * SKU is the product: "Flour" is not something this shop sells under that
 * name, "Cooking oil" is not a brand, and neither is written the way the
 * catalogue is.
 *
 * The run does not stop at the first clarification either. A list of six
 * things where the shop asks about the rice and silently drops the other
 * five would look identical to a working system right up to that point, so
 * the harness answers until the order is written and then counts the lines.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const HOUSEHOLD = '+918979560165';
const SHOP = '+919927306131';

interface Fixture { file: string; want: string[] }
const FIXTURES: Fixture[] = JSON.parse(
  readFileSync(resolve(ROOT, 'media/list-fixtures.json'), 'utf-8'),
);

/** just enough of the stored context to find the options that were offered */
interface StoredCtx {
  pending?: { kind: string; options?: Array<{ name: string }> };
}

const show = (who: string, text: string) =>
  console.log(`  ${who.padEnd(9)}: ${text.replace(/\n/g, '\n             ')}`);

async function main() {
  let seq = 0;
  let failed = 0;
  const hh = await prisma.household.findFirstOrThrow({ where: { phone: HOUSEHOLD } });

  for (const fx of FIXTURES) {
    await resetConvo('test', HOUSEHOLD);

    // anything older belongs to the previous fixture
    const startedAt = new Date();
    const path = resolve(ROOT, 'media', fx.file);
    console.log(`\n${fx.file}`);
    console.log(`  on paper : ${fx.want.join(', ')}`);

    // the picture on its own first, so OCR and resolution stay separable
    const t0 = Date.now();
    const { list, model } = await parseList(path);
    console.log(
      `  read     : isList=${list.isList}, ${list.items.length} item(s), ` +
      `${Date.now() - t0}ms (${model})`,
    );
    for (const it of list.items) {
      console.log(`             "${it.text}" x${it.quantity}${it.unit ? ` ${it.unit}` : ''}`);
    }

    // then the whole way through, exactly as a WhatsApp message would go
    const replies = await handle({
      channel: 'test', senderId: HOUSEHOLD, recipientId: SHOP,
      text: undefined, media: [{ localPath: path, mime: 'image/png', bytes: 0 }],
      externalId: `photo_${++seq}`, receivedAt: new Date(),
    });
    show('shop', replies.map((r) => r.text).join('\n'));

    /**
     * Answer whatever it asks, by naming the first option it offered.
     * Read out of the conversation state rather than parsed from the
     * prose, so this tests the machine and not the wording.
     */
    for (let hop = 0; hop < 6; hop++) {
      const convo = await prisma.conversation.findFirst({
        where: { channel: 'test', peerPhone: HOUSEHOLD },
        select: { contextJson: true },
      });
      const pending = (convo?.contextJson as StoredCtx | null)?.pending;
      if (pending?.kind !== 'DISAMBIGUATE') break;

      const pick = pending.options?.[0]?.name;
      if (!pick) break;

      const next = await handle({
        channel: 'test', senderId: HOUSEHOLD, recipientId: SHOP,
        text: pick, media: [], externalId: `photo_${++seq}`, receivedAt: new Date(),
      });
      console.log(`  buyer    : ${pick}`);
      show('shop', next.map((r) => r.text).join('\n'));
    }

    /**
     * Close the basket. Nothing reaches the database until this happens
     * -- see the `basket` note in conversation/state.ts -- so a harness
     * that looked for an order row straight after the photo would find
     * the PREVIOUS fixture's order and score itself against that.
     */
    for (const closing of ['bas itna hi bhej do', 'haan']) {
      const done = await handle({
        channel: 'test', senderId: HOUSEHOLD, recipientId: SHOP,
        text: closing, media: [], externalId: `photo_${++seq}`, receivedAt: new Date(),
      });
      console.log(`  buyer    : ${closing}`);
      show('shop', done.map((r) => r.text).join('\n'));
    }

    const order = await prisma.order.findFirst({
      where: { householdId: hh.id, createdAt: { gte: startedAt } },
      orderBy: { createdAt: 'desc' },
      include: { lines: { include: { sku: true } } },
    });
    const got = order?.lines.filter((l) => l.sku).length ?? 0;
    const ok = got === fx.want.length;
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'MISS'}     ${got} of ${fx.want.length} lines reached the order`);
  }

  console.log();
  await prisma.$disconnect();
  if (failed) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
