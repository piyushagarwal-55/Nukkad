import { prisma } from '@nukkad/db';
import { dueForReorder } from '../services/depletion/burn.js';
import { twilioAdapter } from '../channels/index.js';
import { TEMPLATE_REORDER } from '../services/conversation/messages.js';

/**
 * The proactive knock.
 *
 * THE CONSTRAINT THAT SHAPES THIS WHOLE FILE: a message sent outside the
 * 24h session window is BUSINESS-INITIATED, and Meta requires it to be a
 * pre-approved template with fixed body text and numbered variable slots.
 * The model is mechanically barred from writing it. So this worker only
 * ever fills template variables. All the intelligence happens after the
 * household replies and the session opens.
 *
 * Getting this wrong is not a style issue, it is a channel-access issue.
 */
const DAY = 86_400_000;

export async function runNudgePass(kiranaId: string, dryRun = true): Promise<number> {
  const due = await dueForReorder(kiranaId, 2);

  // one knock per household, not one per SKU
  const byHousehold = new Map<string, typeof due>();
  for (const row of due) {
    const list = byHousehold.get(row.householdId) ?? [];
    list.push(row);
    byHousehold.set(row.householdId, list);
  }

  let sent = 0;

  for (const [householdId, rows] of byHousehold) {
    const hh = rows[0]!.household;

    // do not knock twice in one cycle
    const recent = await prisma.nudge.findFirst({
      where: { householdId, sentAt: { gte: new Date(Date.now() - 3 * DAY) } },
    });
    if (recent) continue;

    const lastOrder = await prisma.order.findFirst({
      where: { householdId, status: { in: ['CONFIRMED', 'FULFILLED'] } },
      orderBy: { createdAt: 'desc' },
      include: { lines: { include: { sku: true } } },
    });

    const daysSince = lastOrder
      ? Math.round((Date.now() - lastOrder.createdAt.getTime()) / DAY)
      : 0;

    if (dryRun) {
      console.log(`[dry] ${hh.name} (${hh.phone}) - ${daysSince}d - ${rows.length} item(s) due`);
      sent++;
      continue;
    }

    await twilioAdapter.send(hh.phone, {
      text: TEMPLATE_REORDER.body,
      templateName: TEMPLATE_REORDER.name,
      templateVars: [hh.name, String(daysSince)],
    });

    await prisma.nudge.create({
      data: {
        householdId,
        templateName: TEMPLATE_REORDER.name,
        predictedBasketJson: rows.map((r) => ({
          skuId: r.skuId,
          name: r.sku.name,
          predictedDepletionAt: r.predictedDepletionAt,
        })) as never,
      },
    });
    sent++;
  }

  return sent;
}

// tsx src/workers/nudge-scheduler.ts <kiranaId> [--send]
if (process.argv[1]?.includes('nudge-scheduler')) {
  const kiranaId = process.argv[2];
  const send = process.argv.includes('--send');
  if (!kiranaId) {
    console.error('usage: tsx src/workers/nudge-scheduler.ts <kiranaId> [--send]');
    process.exit(1);
  }
  runNudgePass(kiranaId, !send)
    .then((n) => { console.log(`${send ? 'sent' : 'would send'} ${n} nudge(s)`); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
