# Payment Recovery Integration

Nukkad is the language and channel adapter for the Payment Correctness Recovery Integrity Engine.

## Authority boundary

Nukkad may:

- transcribe voice;
- interpret a payment promise;
- send and receive WhatsApp, SMS, or voice communication;
- deliver a Payment Link already approved by the recovery compiler.

Nukkad may not:

- mark an obligation paid from customer speech;
- choose a recovery amount;
- retry a mandate;
- create a competing Payment Link;
- override a promise hold or contact budget.

## Endpoint

`POST /recovery/payment-promise`

```json
{
  "obligationId": "obl_seed_partial",
  "text": "Kal shaam ko pay karunga",
  "channel": "WHATSAPP"
}
```

The interpreter returns a structured future time, confidence, status, source, and rationale. Nukkad signs the canonical event with HMAC-SHA256 and sends it to the correctness control plane.

Configure both services with the same `PAYCORRECT_CHANNEL_SECRET`. The receiving service rejects stale timestamps, malformed events, invalid signatures, low-confidence confirmed promises, past promises, and replayed event IDs.
