import { prisma } from '@nukkad/db';
import { draftPurchaseOrder } from '../services/procurement/plan.js';
import { askOwner } from '../services/procurement/owner.js';
import { env } from '../config/env.js';

/**
 * THE NIGHTLY PASS.
 *
 *   npm run procure --workspace=@nukkad/api            (dry run, sends nothing)
 *   npm run procure --workspace=@nukkad/api -- --send  (asks the owner)
 *
 * Dry by default, like the nudge scheduler, and for the same reason: the
 * failure mode of a scheduler that sends by default is a message nobody
 * meant to send, at an hour nobody is awake to stop.
 *
 * ONE ORDER AT A TIME PER SHOP. If last night's order is still waiting on
 * the owner, tonight does not draft a second one -- two open orders means
 * "haan" is ambiguous, and an ambiguous approval that spends money is not
 * a thing this system will have.
 */

export async function runProcurementPass(dryRun = true) {
  const shops = await prisma.kirana.findMany({ select: { id: true, name: true, phone: true } });
  let drafted = 0;
  let asked = 0;

  for (const shop of shops) {
    const open = await prisma.purchaseOrder.findFirst({
      where: { kiranaId: shop.id, status: { in: ['DRAFT', 'AWAITING_OWNER', 'SENT'] } },
    });
    if (open) {
      console.log(`skip ${shop.name}: ${open.status} order already open (${open.id.slice(-6)})`);
      continue;
    }

    const order = await draftPurchaseOrder(shop.id);
    if (!order) {
      console.log(`${shop.name}: kuch order karne layak nahi`);
      continue;
    }
    drafted++;

    console.log(`\n${shop.name} — draft ${order.id.slice(-6)}, ${order.lines.length} line(s)`);
    for (const l of order.lines) {
      console.log(`   ${l.name} x${l.quantity}  (${l.why})`);
    }

    if (dryRun) continue;

    /**
     * WHOSE PHONE. The owner's WhatsApp is env-overridable because the
     * demo number and the shop's registered number are not always the
     * same handset; without an override it is the shop's own phone,
     * which is the honest default.
     */
    const ownerPhone = env.OWNER_WHATSAPP || shop.phone;
    const res = await askOwner(shop.id, order.id, ownerPhone);
    console.log(res.ok ? `   asked ${ownerPhone}` : `   ask failed: ${res.error}`);
    if (res.ok) asked++;
  }

  return { drafted, asked };
}

// tsx src/workers/procurement-scheduler.ts [--send]
if (process.argv[1]?.includes('procurement-scheduler')) {
  const send = process.argv.includes('--send');
  runProcurementPass(!send)
    .then((r) => {
      console.log(`\n${send ? 'asked' : 'would ask'}: ${r.drafted} order(s) drafted, ${r.asked} sent`);
      process.exit(0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
