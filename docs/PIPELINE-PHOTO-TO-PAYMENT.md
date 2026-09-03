# Nukkad — One Photo, End to End

A complete trace of a single real interaction: a customer photographs a handwritten shopping list, sends it on WhatsApp, and a paid order comes out the other side and appears on the shopkeeper's dashboard. **Every number, model name, confidence score and row value below is real** — measured on the actual photo sent at 9:17pm on 28 August 2026 and read back out of the live database, not illustrated.

The photo:

```
Saman
Atta         5 kg
Chawal       2 kg
Tel          1 L
Cheeni       1 kg
Chai patti   250 g
Namak        1 kg
```

The reply, 8.8 seconds later:

> Aapne 2 kg kaha, ye 5 kg ke packet mein aata hai. Daal diya. Aur kuch chahiye?
> 1 x Ashirwad Besan 1kg · 1 x Aashirvaad Whole Wheat Atta 5kg · 1 x Basmati Rice 5kg · 1 x Dhara Mustard Oil 1L (badla gaya) · 1 x Sugar 1kg · 1 x Tata Tea Gold 500g · 1 x Tata Salt 1kg — **Total: Rs 1,411.53**

---

## Stage 1 — WhatsApp delivers an encrypted envelope (~50ms)

Evolution's gateway posts `MESSAGES_UPSERT` to `POST /evolution/webhook`. The payload contains **no image** — WhatsApp media is end-to-end encrypted, so what arrives is an envelope:

```jsonc
{ "event": "messages.upsert", "instance": "nukkad",
  "data": {
    "key": { "id": "ACC05CE5927BCA6C50BC88654C5CC215", "fromMe": false,
             "remoteJid": "132487359533123@lid",              // ← a privacy alias, not a phone
             "remoteJidAlt": "918979560165@s.whatsapp.net",   // ← the real number
             "addressingMode": "lid" },
    "message": { "imageMessage": {
        "url": "https://mmg.whatsapp.net/o1/v/t24/...", "directPath": "/o1/v/t24/...",
        "mediaKey": "OXCJBRXuulJNgzXLPqf9...", "mimetype": "image/jpeg",
        "fileLength": 33865, "width": 762, "height": 556 } } } }
```

The adapter (`routes/evolution.ts`) does four things in order, and each is defensive for a reason learned the hard way:

1. **Drops echoes** — our own outbound messages come back through the same event (`key.fromMe`).
2. **Resolves the sender.** WhatsApp's newer **LID addressing** delivers the chat as `<opaque>@lid`; the real number rides in `remoteJidAlt` (or `senderPn`). An earlier version demanded `@s.whatsapp.net` and therefore silently rejected this exact photo as "not a customer" — the bug behind *"ai not worked on photo"*. Groups (`@g.us`) and broadcasts are still dropped.
3. **Acks immediately, answers in `setImmediate`.** Evolution retries slow webhooks, and a retried webhook is a customer answered twice.
4. **Decides it wants media.** An `imageMessage` carries no `conversation` text, so a text-only adapter drops it. Caption becomes the text when present; here there was none.

## Stage 2 — fetching and decrypting the bytes (~300ms)

`fetchMedia()` posts the whole `{key, message}` pair back to Evolution's `POST /chat/getBase64FromMediaMessage/nukkad`, which runs Baileys' `downloadMediaMessage` — deriving keys from `mediaKey`, fetching from `mmg.whatsapp.net` via `directPath`, and decrypting. Returns base64.

We write it straight to disk: `apps/api/media/evo_ACC05CE5927BCA6C50BC88654C5CC215.jpg`, **33,865 bytes** — byte-exact against the envelope's `fileLength`, which is how we know decryption succeeded. Disk rather than memory because that is the shape `handle()`'s vision path already eats, identical to the Twilio adapter. If the fetch fails and there was no caption, the customer is told the photo could not be opened rather than being silently ignored.

The turn then enters the universal door — the same call every channel makes:

```ts
handle({ channel: 'evolution', senderId: '+918979560165',
         recipientId: env.EVOLUTION_SHOP_PHONE, text: undefined,
         media: [{ localPath, mime: 'image/jpeg', bytes: 33865 }],
         externalId: 'evo_ACC05CE5927BCA6C50BC88654C5CC215', receivedAt: new Date() })
```

## Stage 3 — routing and the photo branch (~40ms)

`handle()` maps the sender phone to a `Kirana` + `Household` (here: Ramesh Sharma), loads the conversation state, and reaches `turn()`. The image is found by `msg.media.find(isImage)` and takes a branch **before everything else**:

```ts
if (image) return photo(ctx, image.localPath);
```

Two deliberate consequences. **Photos jump the queue past any outstanding question** — a customer who was asked "which rice?" and answers with a photograph of their whole list has moved on, and holding them to the old question would be pedantic. And a photo **skips the policy model entirely**: there is no ambiguity to resolve, the items came off paper, they name themselves, and there is no conversation around them to point at. (This is why the `AgentEvent` for this turn records `act=DISCLOSE` — the MG-ShopDial annotation — rather than a speech act, and why the desk in that row is whichever desk the customer was already at. Noted as a real architectural seam in §11.)

Before this branch existed the code checked whether vision was *unavailable*, found it available, and fell through with empty text — so someone sent a picture of their grocery list and the shop replied *"kya haal hai"*.

## Stage 4 — image preparation (~120ms)

`services/vision/image.ts` caps the long edge at **1100px** and re-encodes to **JPEG quality 88**. Both numbers are measured, not guessed: the same invoice at 1357×1920 and 777×1100 both returned three lines with the total read correctly, in 1409ms and 1286ms — the extra pixels were paying rent. And JPEG rather than PNG because a phone photo re-encoded losslessly *grows* (85KB → 291KB on one bill, for no accuracy gain). This photo was 762×556, already under the cap, so it passed through untouched.

## Stage 5 — vision reads the paper (**2,067ms measured**)

`services/vision/list.ts` sends one Groq call: model **`qwen/qwen3.8-27b`**, `temperature: 0`, `response_format: json_object`, image as a data URI. The prompt is narrow on purpose and its rules are all scar tissue: copy the item name **verbatim** (do not translate, do not fix spelling, do not add a brand that isn't on the paper — *"something downstream matches it to this shop's catalogue"*), Devanagari or Roman as written, **skip crossed-out lines**, ignore prices/headings/dates/phone numbers, and skip illegible lines rather than guessing a product.

The response is zod-validated, and `isList` is a **guard, not a formality**: people photograph bills, broken packets, their children — and *a model asked to extract groceries from a picture of a dog will find groceries in a picture of a dog*. A malformed reply is treated as "not a list", which routes to a human sentence rather than an empty order.

Actual output on this photo, six items, quantities and units intact:

| text (verbatim) | quantity | unit |
|---|---|---|
| `Atta` | 5 | kg |
| `Chawal` | 2 | kg |
| `Tel` | 1 | L |
| `Cheeni` | 1 | kg |
| `Chai patti` | 250 | g |
| `Namak` | 1 | kg |

Note what it is **not**: a bill. A list has no rates, amounts, total or GST, so running it through the nine-node bill agent would mean reconciling arithmetic over zero rupees. Different document, different reader — but the same downstream ranker.

## Stage 6 — mapping words to SKUs (~600ms)

`addExplicit()` loads three things in parallel — this shop's catalogue, its stock map, and **this household's purchase prior** — then hands the verbatim strings to the one resolver that text, voice and photos all share. The catalogue constraint does not care which sense the words arrived by; that is the whole reason the resolver takes strings.

What it actually decided, read back from the `OrderLine` rows:

| said | matched SKU | method | confidence |
|---|---|---|---|
| `Atta` | Aashirvaad Whole Wheat Atta 5kg | EXACT | **0.864** |
| `Chawal` | Basmati Rice 5kg | EXACT | **0.562** |
| `Tel` | Dhara Mustard Oil 1L | **SUBSTITUTED** | 0.644 |
| `Cheeni` | Sugar 1kg | EXACT | **0.941** |
| `Chai patti` | Tata Tea Gold 500g | EXACT | **0.805** |
| `Namak` | Tata Salt 1kg | EXACT | **0.818** |

Three mechanisms fired on this one list, and each is visible in the reply:

**Substitution.** `Tel` resolved to an oil that was out of stock, so `findSubstitutes()` ranked replacements by price, pack size and familiarity and swapped in Dhara Mustard Oil — recording the original in `alternates` and setting `wasSubstituted = true`. The customer was told, in the shop's own terms: **"(badla gaya)"**. The explanation is chosen by reading back which factor actually carried the decision (`whySwap()`: *"aap ye pehle le chuke hain"* / *"thoda sasta bhi hai"* / *"same daam"* / *"wahi size"*), so it is the real reason rather than a pleasant-sounding one.

**Pack fitting** — the line the customer actually noticed. They wrote **2 kg** of rice; the shop sells rice in **5 kg** packets. Until `fitPack()` existed, every quantity was treated as a count of packets whatever unit was written, so "Tea 500 g" ordered **250 packets** of 500g. Now a request that doesn't divide into whole packets is not rounded in silence — it becomes a sentence: **"Aapne 2 kg kaha, ye 5 kg ke packet mein aata hai."** Same for `Chai patti 250 g` → one 500g pack. Every stored quantity is therefore `1` (packets), not the number on the paper.

**The prior.** The household's own history boosts SKUs they actually buy, which is why `Chawal` — a generic word matching several rices at only 0.562 — still landed on the one this family buys instead of asking.

Anything that had matched nothing would have taken a different exit: open the category via the KB (`retrieveKb`), or, if the KB recognises the phrase but the shop doesn't stock it, say so plainly (*"namkeen"* → NOT_STOCKED) — and either way write an `UnmetDemand` row with the customer's verbatim words. Scoring weights, thresholds and the full tier chain are in [RETRIEVAL-AND-RESOLUTION.md](./RETRIEVAL-AND-RESOLUTION.md).

## Stage 7 — the basket, and composing the reply (~5,900ms of the 8,793ms turn)

Resolved lines are merged into the conversation basket (`mergeBasket` — same-category non-additive restatements *replace* rather than append). The basket already held Besan and Atta from an earlier exchange, which is why the card lists seven lines and totals **₹1,411.53** rather than the six on the paper. The basket is conversation state, not an order: **nothing has been written to the `Order` table yet.**

The typed Fact (`BASKET_ADDED`, plus the pack question) goes to the composer with the desk's brief and register, the Response Director's mode note, and a **digit whitelist** — the model may only utter figures the fact provided, checked by `violates()` after generation. The item list and total are attached as a *card* built by code (`copy.orderCard`), never written by the model.

**Measured total for this turn: 8,793ms** (`AgentEvent.latencyMs`), of which vision was 2,067ms.

## Stage 8 — checkout writes the rows (**1,945ms measured**)

Nothing above committed anything. The customer then typed **"haa isko order kr do"**, which reads as a `CHECKOUT` speech act. Before any row is written, the deterministic guard `saysCheckout(ctx.said)` re-checks the *sentence itself* — a message with no checkout language in it must not become a checkout, whatever the conversation history primed the model to think.

`writeOrder()` then does three writes, and the ordering is deliberate:

```ts
const orderId = randomUUID();                     // minted client-side
await Promise.all([
  prisma.order.create({ ..., lines: { create: [...] } }),   // parent+children, one implicit tx
  razorpayLinkFor(...),                                     // external call, races in parallel
]);
await recordInvoice(...);                                   // sequential, after both land
```

The Order write and the Razorpay call run **in parallel** to save a round trip, and are deliberately **not** in a shared transaction: if the order write fails the link is orphaned, which costs nothing, whereas making the customer wait serially costs a second on every checkout. `recordInvoice` is awaited afterwards and wrapped in try/catch — if it fails, the link is **not** offered, because a link the shop has no record of is worse than no link.

**The `Order` row** — `id` a client-minted UUID, `status: 'PAYMENT_PENDING'`, `paymentStatus: 'PENDING'`, `source` (`TEXT` here — the *checkout turn* was typed; the photo's `PHOTO` source belongs to the earlier turn, see §11), `rawText: "haa isko order kr do"`, `totalPaise: 131553`, `latencyMs: 1945`, and `paidAt`/`confirmedAt` left **null**.

**Six `OrderLine` rows** — each keeping `sourceText` **verbatim from the paper** ("Atta", "Chawal", "Tel"…) beside the resolved `skuId`, `quantity` (packets, post-fit), `unitPricePaise`, `linePaise = round(unitPrice × quantity)`, and the full audit trail: `method`, `confidence`, `wasSubstituted`, `alternatesJson` (the runners-up as offered, so a rejected suggestion stays analysable). The verbatim text is never overwritten — the eval harness diffs against it.

**The `Invoice` row** — `amountPaise: 131553`, `amountPaidPaise: 0`, `status: ISSUED`, `referenceId: nukkad_1bbbe85a-0a91-4b2e`, `razorpayLinkId: plink_TVFOztfs4IpjDN`, `razorpayShortUrl: https://rzp.io/rzp/ugAmoypN`, `acceptPartial: true`.

**Stock is not touched here.** Goods move only when money is verified (§10).

## Stage 9 — the Razorpay link

`createRazorpayLink()` calls `paymentLink.create` with `amount` **in paise** (Razorpay's native unit — no ×100 anywhere, a classic double-multiplication bug avoided by matching units end to end), `currency: 'INR'`, `description: "Order #<last 6 of id>"`, `reference_id: nukkad_<first 18 chars of a UUID>`, the customer's name and phone, `notify: {sms: false, email: false}` (we deliver it in the WhatsApp thread the customer is already in), `reminder_enable: false`, `accept_partial: true`, and `notes: {orderId, source: 'nukkad'}`.

**`reference_id` is the only key the webhook reconciles by**, and `Invoice.referenceId` is `@unique` — so a payment can be tied to exactly one invoice, and the `orderId` in `notes` is never read back.

The short URL then reaches the customer **without ever entering the LLM prompt**. The composer is explicitly told *"the payment link is attached below your reply — do NOT write it out yourself"*, given the `NO_NUMBERS` contract, and the slip is concatenated by code:

```
Total: Rs 1,315.53
Pay: https://rzp.io/rzp/ugAmoypN
(#0b55a2)
```

A model that can retype a URL is a model that can mistype one.

## Stage 10 — money, and the only two doors it comes through

`PaymentStatus.SUCCESS` is reachable from exactly two places, both of which ask the world instead of believing the customer.

**Door 1 — the webhook** (`POST /rzp/webhook`). A raw-body parser preserves the exact bytes so the HMAC matches; `verifySignature` computes `HMAC-SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET)` and compares with `timingSafeEqual` behind a length guard. A bad or missing signature returns **400 before any database work happens**. The event is then inserted into `WebhookEvent` keyed `(source, externalId)` — **the insert *is* the dedupe**: a unique-constraint throw returns `{result: 'duplicate'}` and nothing re-runs. Reconciliation looks the invoice up by `reference_id`, sets `amountPaidPaise` and a status (`PAID` when `paid ≥ total`, `PARTIALLY_PAID` when `paid > 0` — that is the udhaar mechanic), upserts a `Payment` row (`update: {}`, so a redelivery never mutates it), and calls `settle()`. Configured events: `payment_link.paid`, `payment_link.partially_paid`, `payment_link.expired`, `payment.failed`.

**Door 2 — asking Razorpay directly.** When the customer says *"payment is done"*, the `PAYMENT_CLAIM` act maps to `VERIFY_PAYMENT`, which finds their pending order and calls `checkAndSettle()`: fetch the payment link from Razorpay's API, read `amount_paid`, and settle **only if `paid ≥ amountPaise`**. An unreachable API returns `null` — unreachable is not paid. A partial payment does not settle.

**`settle()` is the single door, and it claims atomically:**

```ts
const claimed = await prisma.order.updateMany({
  where: { id: orderId, paymentStatus: 'PENDING' },      // ← the claim
  data: { paymentStatus: 'SUCCESS', status: 'CONFIRMED',
          paidAt: new Date(), confirmedAt: new Date() },
});
if (claimed.count === 0) return null;    // webhook vs API-read race: the loser sends nothing
```

Only then does stock move, in one transaction, **guarded**: `updateMany({where: {skuId, quantity: {gte: line.quantity}}, data: {decrement}})` — a line whose count comes back 0 had insufficient stock and is collected as a shortfall. Caches are invalidated, the basket is cleared across every conversation for that household, and a bill is rendered **by code, not by a model** ("Payment mil gaya. Order confirm hai." + lines + total + ref).

**What actually happened here, from the database:** `paidAt = 16:01:27.763Z`, `status = CONFIRMED`, `paymentStatus = SUCCESS`, invoice `PAID` with `amountPaidPaise = 131553`. The customer's *"payment is done"* turn completed at 16:01:36 and replied **"Payment mil gaya. Order confirm hai."** — nine seconds *after* the money was actually verified. The sentence did not settle the order; the settled order licensed the sentence.

**And an honest gap:** `WebhookEvent` and `Payment` are both **empty (0 rows)**. Razorpay never called our webhook — it is not registered against the current ngrok URL — so every settlement so far has come through **door 2**. The invariant held perfectly, but the webhook leg is currently unproven in this environment. §11 lists it as an open item.

## Stage 11 — the dashboard

The shopkeeper's browser holds an httpOnly `nukkad_session` cookie (HMAC-signed, 30-day TTL, issued by `/auth/verify` after a single-use OTP). Every read endpoint starts with `requireSession(req)`, which throws a `401` — this is why `curl` without the cookie gets `{"statusCode":401,"error":"Unauthorized"}` while the browser succeeds (`credentials: 'include'` against `cors({origin: true, credentials: true})`).

`GET /orders` returns the last 60 orders with household, lines (**including `method` and `confidence` per line**, so the resolution audit is visible in the UI) and `outstandingPaise = amountPaise − amountPaidPaise`. `GET /orders/:orderId` adds per-line **margin** (`linePaise − costPaise × qty`, null where no cost basis exists — the dashboard does not invent a margin it cannot compute), the household's average order, substitution provenance, and the invoice with its payments. Tenant isolation is structural: `kiranaId` sits **in the WHERE clause**, so another shop's order 404s rather than leaking.

The photo's fingerprints survive all the way here: the order detail page shows `sourceText` "Atta" beside the matched SKU, the `SUBSTITUTED` badge on the oil, and the per-line confidences above.

---

## Timing ledger (measured, this photo)

| Stage | Time |
|---|---|
| Webhook → adapter parse | ~50ms |
| Media fetch + decrypt (Evolution/Baileys) | ~300ms |
| Image prep | ~120ms (no resize needed) |
| **Vision (`qwen/qwen3.8-27b`)** | **2,067ms** |
| Resolver (catalogue + stock + prior, 6 lines) | ~600ms |
| Compose + send | remainder |
| **Total photo turn (`AgentEvent.latencyMs`)** | **8,793ms** |
| Checkout turn (order + link + invoice) | **1,945ms** |
| Payment verify turn | 14,281ms (includes the Razorpay API round trip) |

## Known gaps found while writing this document

These are real, verified in code, and listed here rather than smoothed over.

1. **`PAYMENT_PENDING` is invisible in the orders UI.** Every checked-out order is written with `status: 'PAYMENT_PENDING'`, but `apps/web/src/app/dashboard/orders/page.tsx` has no such key in its `STATUS` map (it falls back to draft styling), and the "Waiting on them" tab filters `status === 'AWAITING'` — a value no row ever holds. The string `PAYMENT_PENDING` appears nowhere in `apps/web/src`. Result: freshly ordered, unpaid orders look like drafts and the tab is permanently empty.
2. **Stock shortfalls are computed and then dropped.** `settle()` returns `short[]` for lines the shelf couldn't cover, with a comment insisting it must not be swallowed — but the webhook route sends only `settled.text`. A customer who paid for out-of-stock goods is told "Order confirm hai" with the full list; the only trace is a `console.error`.
3. **The webhook path is unexercised** — 0 `WebhookEvent` rows, 0 `Payment` rows. Registering `<PUBLIC_BASE_URL>/rzp/webhook` in the Razorpay dashboard would exercise door 1 before the demo.
4. **Payment links never expire.** `expiresInMins` is never passed, so `expire_by` is omitted and `Invoice.expiresAt` stays null — making the `payment_link.expired` branch unreachable in practice.
5. **`GET /analytics` is unbounded** — it fetches every order the shop has ever placed on each dashboard load, with no date floor or `take`.
6. **A photo bypasses desk ownership.** The `if (fromPhoto)` branch runs `addExplicit()` *before* the transition table, so a photo sent while the customer is at the CHECKOUT desk still edits the basket — which the CHECKOUT desk is otherwise structurally forbidden from doing. Visible in the real data: the photo turn's `AgentEvent` records `desk=CHECKOUT`. Defensible (a photo is unambiguous and the desks exist to disambiguate), but it is an exception to the "no request executes until desk ownership is resolved" rule and should be a deliberate one.
