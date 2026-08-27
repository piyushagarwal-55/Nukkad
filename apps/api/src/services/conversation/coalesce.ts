import type { InboundMessage } from '@nukkad/shared';

/**
 * ONE THOUGHT, ONE REPLY.
 *
 * People do not type in turns. They type in fragments, and then they fix
 * the typo:
 *
 *     7:08  moong dal ka ptice batana
 *     7:08  price*
 *
 * Each of those was its own inbound webhook, so each got its own reply.
 * The first answered the question correctly. The second saw "price*",
 * found no product in it, and read out the whole catalogue -- a wall of
 * text triggered by an asterisk.
 *
 * The same shape is worth more than a typo fix. "do kilo atta" then "aur
 * ek kilo chini bhi" then "bhej do" is three messages and one order, and
 * a shopkeeper reading them would wait for the pause before answering.
 *
 * SO WAIT FOR THE PAUSE. Every message starts a short quiet timer; another
 * message from the same person resets it and joins the batch. When it goes
 * quiet, the whole batch is handled as one turn.
 *
 * THE COST IS REAL AND IT IS PAID BY EVERYONE. A single message now waits
 * QUIET_MS before anything happens, on top of the four to eight seconds
 * the pipeline already takes. That is the trade: a fifth of a second-ish
 * per message against never again answering a correction as if it were a
 * question. It is worth it on WhatsApp, where nobody expects instant, and
 * it would NOT be worth it on a voice call, where the pause IS the
 * conversation -- so the voice agent must not reuse this.
 *
 * Deliberately in memory and deliberately per process. This is a debounce,
 * not a queue: if the process dies mid-window the customer's message is
 * lost, which is the same thing that happens today if it dies mid-handler,
 * and putting it in a database would buy durability at the cost of the
 * latency the whole thing is trying to protect.
 */

/**
 * How long the shop waits to see if you are still typing.
 *
 * Short on purpose. Long enough to catch a correction sent in the same
 * breath, short enough that someone who sends one message and stares at
 * the screen does not notice.
 */
const QUIET_MS = 1500;

/** a batch that has not gone quiet yet */
interface Batch {
  parts: InboundMessage[];
  timer: NodeJS.Timeout;
}

const waiting = new Map<string, Batch>();

/**
 * Fold several messages into the one turn they were meant to be.
 *
 * Text is joined with a space rather than a full stop: "moong dal ka
 * ptice batana" plus "price*" is one sentence being corrected, not two
 * sentences. Media is concatenated so a photo and its caption arrive
 * together. The externalId of the LAST part identifies the batch, because
 * that is the message whose reply the customer is waiting on.
 */
function fold(parts: InboundMessage[]): InboundMessage {
  const last = parts[parts.length - 1]!;
  const text = parts.map((p) => p.text?.trim()).filter(Boolean).join(' ');

  return {
    ...last,
    text: text || undefined,
    media: parts.flatMap((p) => p.media),
  };
}

/**
 * Hold `msg` until its sender stops typing, then hand the batch to `run`.
 *
 * Returns immediately. Errors from `run` are the caller's to handle -- it
 * is invoked from a timer with nobody left to await it, so it must not be
 * allowed to reject into the void.
 */
export function coalesce(
  msg: InboundMessage,
  run: (batch: InboundMessage) => Promise<void>,
): void {
  const key = `${msg.channel}:${msg.senderId}`;
  const open = waiting.get(key);

  if (open) {
    clearTimeout(open.timer);
    open.parts.push(msg);
  }

  const parts = open?.parts ?? [msg];
  const timer = setTimeout(() => {
    waiting.delete(key);
    void run(fold(parts));
  }, QUIET_MS);

  // unref so a pending debounce cannot hold the process open on shutdown
  timer.unref?.();
  waiting.set(key, { parts, timer });
}
