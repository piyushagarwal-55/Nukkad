# Eval harness

This produces the single artefact that wins the room.

Almost no hackathon project shows a measured number at all. This one shows
a four row table on real merchant audio, and it directly answers the
objection every judge already has: *how do you know it actually works?*

## The table

| stage | top-1 | top-3 |
|---|---|---|
| raw ASR then extract | | |
| + catalogue constraint | | |
| + household reorder prior | | |
| + buyer confirmation | | |

The claim being tested is narrow and falsifiable: **transcription errors
that are fatal to entity extraction are recoverable by retrieval**, because
the answer is guaranteed to sit inside a few hundred known SKUs and the
household prior is strong.

If the table does not show that, the thesis is wrong and it is better to
find out on day 4 than on stage.

## Running it

```bash
npm run eval
```

Reads `fixtures/golden.json`. Writes `out/ablation.md` and `out/raw.json`.

## The golden set

One entry per real order. `audio` is a path to a real voice note. `expected`
is what a human says the order was.

```json
{
  "id": "hh1-2026-08-20-a",
  "householdPhone": "+918979560165",
  "audio": "fixtures/audio/order-01.ogg",
  "text": null,
  "expected": [
    { "skuName": "Aashirvaad Whole Wheat Atta 10kg", "quantity": 2 },
    { "skuName": "Fortune Sunflower Oil 1L", "quantity": 1 }
  ]
}
```

## The rule that matters

**Real audio only.** Synthetic voice notes read by you into your own phone
do not count, because you will unconsciously enunciate. Thirty real ones
from real households beats three hundred fake ones, and faking these inputs
is the exact mechanism that sank the last project.

Day 2 is a hard GO/NO-GO gate: one real catalogue of 200 to 800 SKUs and 30
or more real order inputs in hand, or the project changes.
