import { buildCareCallPlans } from '../services/care-call/plan.js';

// tsx src/workers/care-call-scheduler.ts <kiranaId> [days]
if (process.argv[1]?.includes('care-call-scheduler')) {
  const kiranaId = process.argv[2];
  const days = Number(process.argv[3] ?? 5);
  if (!kiranaId) {
    console.error('usage: tsx src/workers/care-call-scheduler.ts <kiranaId> [days]');
    process.exit(1);
  }

  buildCareCallPlans(kiranaId, Number.isFinite(days) ? days : 5)
    .then((plans) => {
      console.log(`would prepare ${plans.length} outbound care call(s)`);
      for (const p of plans) {
        console.log(`\n${p.household.name} ${p.household.phone}`);
        console.log(p.lines.map((l) => `- ${l.name}${l.daysSincePurchase == null ? '' : ` (${l.daysSincePurchase}d)`}`).join('\n'));
        console.log(`script: ${p.openingScript}`);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
