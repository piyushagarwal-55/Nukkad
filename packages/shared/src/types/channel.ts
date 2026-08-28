/**
 * Channel-agnostic message contract.
 *
 * Every transport (Twilio WhatsApp, the web simulator, later Meta Cloud API
 * or SMS) is an ADAPTER that converts to and from these two shapes. The
 * conversation core never imports a transport SDK.
 *
 * This is what lets the judge-facing web simulator run the IDENTICAL
 * pipeline as a real phone, which is the sentence we say on stage:
 * "same webhook, same ranker, same ledger, only the transport differs".
 */

/**
 * `test` is deliberately separate from `sim`, and the separation is not
 * cosmetic. The conversation row is keyed on (channel, peerPhone), so
 * running the dialogue suite against the same channel the browser voice
 * page uses left its state behind -- a basket, a transcript, and a
 * PENDING CHECKOUT. The next person to say "Hello" into the microphone
 * inherited all three.
 *
 * That produced a trace where a greeting wrote an order and issued a
 * payment link. The guard in conversation/reply.ts is what makes that
 * impossible now; this is what makes it not happen in the first place.
 */
export type ChannelId = 'twilio' | 'sim' | 'cloud' | 'test' | 'evolution';

export interface InboundMedia {
  /** Already downloaded and stored by the adapter. Never a Twilio URL, those expire in 4h. */
  localPath: string;
  mime: string;
  bytes: number;
}

export interface InboundMessage {
  channel: ChannelId;
  /** E.164, no whatsapp: prefix. e.g. +918979560165 */
  senderId: string;
  /** The number the user messaged, i.e. the shop. */
  recipientId: string;
  text?: string;
  media: InboundMedia[];
  /** Transport's own message id, used for idempotency. */
  externalId: string;
  receivedAt: Date;
}

export interface QuickReply {
  /** What the user types or taps, e.g. '1' */
  id: string;
  label: string;
}

export interface OutboundMessage {
  text: string;
  quickReplies?: QuickReply[];
  /**
   * What the SHOP just did, on the same two axes the inbound side is
   * annotated with -- see Message.intent/goal in the Prisma schema and
   * MG-ShopDial (Bernard & Balog, SIGIR '23).
   *
   * Derived rather than classified: the agent knows which Facts it acted
   * on, so labelling its own utterance costs nothing and cannot be wrong.
   * Only the customer's side needs a model to read it.
   */
  intent?: string;
  goal?: string;
  /**
   * Meta requires a PRE-APPROVED TEMPLATE for any business-initiated message
   * sent outside the 24h session window. When this is set the adapter MUST
   * send it as a template and MUST NOT send free-form text.
   * See PRD, "The 24-hour window is an architectural constraint".
   */
  templateName?: string;
  templateVars?: string[];
}

export interface ChannelAdapter {
  readonly id: ChannelId;
  /** Transport payload to InboundMessage. Downloads and normalises media. */
  parse(payload: unknown): Promise<InboundMessage>;
  send(to: string, msg: OutboundMessage): Promise<void>;
}
