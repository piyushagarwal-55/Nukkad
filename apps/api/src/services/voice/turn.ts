import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { handle } from '../conversation/core.js';
import { toWav16k } from '../asr/audio.js';
import { speak } from './tts.js';
import { prisma } from '@nukkad/db';
import { transcribe } from '../asr/index.js';
import type { PolicyAction } from '../policy/decide.js';
import { warm } from '../conversation/routing.js';

/**
 * ONE VOICE TURN, with no telephony anywhere in it.
 *
 * This is the entire voice agent. A phone call is a transport that hands
 * it audio and plays back what it returns, exactly as WhatsApp is a
 * transport around handle() -- and keeping it that way is what makes the
 * thing testable without spending a rupee. The browser page and the
 * Twilio webhook call this same function; so does the local harness, so
 * an issue found on a call becomes a file you can replay forever.
 *
 * WHAT IT DOES NOT DO. It does not resolve products, choose actions or
 * touch the basket. handle() does all of that, unchanged, which means
 * every fix made for WhatsApp is already in the voice agent and the two
 * can never drift apart.
 *
 * THE LATENCY, MEASURED, and it is the honest weak point:
 *
 *   listen   Sarvam saaras      ~500ms
 *   think    policy + resolver  ~800ms
 *   speak    Sarvam bulbul     ~2000ms
 *
 * Roughly three and a half seconds a turn, and most of it is the mouth.
 * Fine for push-to-talk in a browser, too slow for a phone where silence
 * reads as a dropped line. The fix is streaming TTS rather than a faster
 * anything, so do not reach for a smaller model when this bites.
 */

export interface VoiceTrace {
  /** what the ear returned, exactly */
  heard: string;
  /** the same in the script the engine returned it in, before romanising */
  heardRaw: string;
  asrEngine: string;
  asrMs: number;

  /** what the shop said back, in full, ledger and all */
  reply: string;
  /** the same with the ledger stripped, which is what gets spoken */
  spoken: string;
  /** the shop's own action, on the two axes from the MG-ShopDial schema */
  action: string;
  goal: string;

  ttsMs: number;
  totalMs: number;

  /** what is in the bag after this turn */
  basket: string[];
  /** the product the next "yeh" would refer to */
  lastNamed: string[];
}

export interface VoiceTurn {
  trace: VoiceTrace;
  /** WAV, or null when TTS was unavailable. Text still works without it. */
  audio: Buffer | null;
}

const MEDIA = join(process.cwd(), 'media', 'voice');

/**
 * A card is for reading, not for hearing.
 *
 * "1 x Aashirvaad Whole Wheat Atta 5kg / Total: Rs 351.53" read aloud is
 * unbearable, and on a phone there is nothing to look at anyway. The
 * prose above it already says what happened -- that is exactly the split
 * compose.ts was built around, and here it pays for itself.
 */
function speakable(reply: string): string {
  const [prose] = reply.split('\n\n');
  return (prose ?? reply).trim();
}

/**
 * THE NOISE A PERSON MAKES WHILE REACHING FOR THE SHELF.
 *
 * Measured: first sound at 3990ms against a 4152ms turn. The composer
 * streams sentence by sentence and it buys almost nothing, because a
 * short reply comes back from the model in one or two chunks -- the
 * sentences all finish within tens of milliseconds of each other.
 * Streaming was the right shape and the wrong bottleneck.
 *
 * What costs the caller is the SHAPE of the turn: ear, then policy, then
 * resolver, then composer, and only then a mouth. Nothing can be said
 * until all of it is done, so the line is silent for four seconds, and
 * four seconds of silence on a phone is a dropped call -- people say
 * "hello?" and start again.
 *
 * KEYED ON THE ACTION, not a single generic filler. "Hmm" before every
 * turn is the tic the Response Director exists to prevent, rebuilt one
 * layer down: a shopkeeper reaching for a bag and a shopkeeper checking
 * a price make different noises, and the policy layer already knows
 * which is happening ~600ms in -- see the onDecision hook.
 *
 * It carries no information, which is what makes it safe. It cannot be
 * wrong about a price, a product or a payment, and every rule about what
 * this system may claim is untouched by it.
 *
 * SILENCE IS AN OPTION, and for the ambiguous cases it is the right one.
 * A turn heading for "kaunsa chahiye?" should not be prefixed with a
 * confident-sounding "karta hoon" -- the shop is about to admit it does
 * not know, and sounding busy first makes that worse.
 *
 * ONLY IF THE TURN IS ACTUALLY SLOW. A reaction on a fast turn is worse
 * than none: it delays the real answer in order to say nothing. The
 * timer is cancelled the instant a real sentence appears, so the fast
 * path in realize.ts -- which is most adds -- never triggers it at all.
 *
 * VOICE ONLY. WhatsApp has a typing indicator; a bubble saying "ji"
 * followed by a bubble with the answer is clutter, not warmth.
 */
const REACT_AFTER_MS = 700;

const REACTIONS: Partial<Record<PolicyAction, string[]>> = {
  ADD_EXPLICIT_PRODUCT: ['Haan, rakhta hoon...', 'Ji, likh raha hoon...'],
  ADD_FROM_STATE: ['Haan ji, karta hoon...', 'Theek hai, rakh raha hoon...'],
  REMOVE_EXPLICIT_PRODUCT: ['Haan, hata raha hoon...'],
  REMOVE_FROM_STATE: ['Ji, hata deta hoon...'],
  ANSWER_PRICE: ['Ek second, dekhta hoon...', 'Haan, rate dekh raha hoon...'],
  ANSWER_STOCK: ['Ruko, dekhta hoon...', 'Haan, check karta hoon...'],
  SEARCH_PRODUCT: ['Ek minute, dekhta hoon...'],
  RECOMMEND: ['Hmm, sochne dijiye...', 'Achha, ek second...'],
  REPEAT_LAST_ORDER: ['Haan, pichhla order nikaal raha hoon...'],
  ACCOUNT_SUMMARY: ['Ek second, hisaab dekh raha hoon...'],
  CHECKOUT: ['Haan ji, total nikaal raha hoon...'],
  PAYMENT_STATUS_QUERY: ['Ek second, check karta hoon...'],

  /**
   * Deliberately absent: CLARIFY, NOT_UNDERSTOOD, GREET,
   * CONFIRM/REJECT_PENDING_ACTION, CANCEL_ORDER. The first two are about
   * to ask a question, the rest are fast enough that the timer never
   * fires. An empty entry means silence, and silence is a valid reaction.
   */
};

function reactionFor(action: PolicyAction, said: string): string | null {
  const options = REACTIONS[action];
  if (!options?.length) return null;

  /**
   * Hashed off what they said rather than random, so a demo is
   * reproducible: the same sentence twice makes the same noise, and a
   * bug that shows up one turn in four is one nobody can hold still.
   */
  let h = 0;
  for (const ch of said) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return options[h % options.length]!;
}

export async function voiceTurn(
  audioIn: Buffer,
  opts: {
    phone: string;
    shopPhone: string;
    mime?: string;
    /**
     * Synthesise the whole reply here. False when the caller intends to
     * speak it a sentence at a time -- see voice/speech.ts -- which is
     * what every real transport does, because waiting for the last
     * sentence before playing the first is the thing that made a turn
     * feel like a dropped line.
     */
    speak?: boolean;
    /**
     * Called with each finished sentence AS THE MODEL WRITES IT, so the
     * caller can start synthesising sentence one while sentence two is
     * still being composed. See composeStream in conversation/compose.ts.
     */
    onSentence?: (sentence: string) => void | Promise<void>;
  },
): Promise<VoiceTurn> {
  const started = Date.now();
  await mkdir(MEDIA, { recursive: true });

  /**
   * Everything is normalised to 16k mono WAV before it reaches the ear.
   * A browser sends webm/opus and a phone sends 8k mu-law; Sarvam takes
   * neither reliably, and one conversion here beats a special case in
   * every transport.
   */
  const raw = join(MEDIA, `${randomUUID()}.in`);
  await writeFile(raw, audioIn);
  const wav = await toWav16k(raw, `${raw}.wav`);

  /**
   * TRANSCRIBED HERE, not inside handle().
   *
   * handle() will transcribe audio if you give it audio, and then the
   * transcript is gone -- it goes into the Order row and a turn that asks
   * a question makes no Order. Doing it here costs the same one ASR call
   * and hands back what was heard, which is the single most useful line
   * in the whole trace: nearly every voice bug is visible the moment you
   * can see what the ear actually got.
   */
  /**
   * THE EAR AND THE LOOKUPS AT THE SAME TIME.
   *
   * Transcription is ~760ms during which nothing else happens, and
   * everything the next step needs -- which shop, which household, the
   * catalogue, the stock map, the reorder prior -- is knowable from the
   * phone numbers alone, which arrived with the audio. Doing them in
   * series was about a second of a voice turn spent twice.
   *
   * warm() never throws and never blocks the real path: if it loses the
   * race, handle() does the work itself exactly as before.
   */
  const [heard] = await Promise.all([
    transcribe(wav),
    warm(opts.phone, opts.shopPhone),
  ]);

  /**
   * The filler races the composer, and loses on any turn that is quick.
   * Wrapping onSentence rather than sitting beside it means one place
   * decides whether anything has been said yet, so the two can never both
   * think they are first.
   */
  let spokenYet = false;
  let reacting: NodeJS.Timeout | undefined;
  const relay = opts.onSentence;

  const onSentence = relay
    ? async (sentence: string) => {
        spokenYet = true;
        clearTimeout(reacting);
        await relay(sentence);
      }
    : undefined;

  /**
   * The timer starts only once the action is known, so the reaction can
   * be the right one. That costs nothing: the policy call resolves ~600ms
   * in and the pipeline still has the resolver and the composer to go.
   */
  const onDecision = relay
    ? (action: PolicyAction) => {
        const line = reactionFor(action, heard.text);
        if (!line) return;
        reacting = setTimeout(() => {
          if (spokenYet) return;
          spokenYet = true;
          void relay(line);
        }, REACT_AFTER_MS);
      }
    : undefined;

  let replies;
  try {
    replies = await handle(
      {
        channel: 'sim',
        senderId: opts.phone,
        recipientId: opts.shopPhone,
        text: heard.text,
        media: [],
        externalId: `voice_${randomUUID()}`,
        receivedAt: new Date(),
      },
      { onSentence, onDecision },
    );
  } finally {
    clearTimeout(reacting);
  }

  const reply = replies.map((r) => r.text).join('\n') || '';
  const spoken = speakable(reply);
  const said = opts.speak === false ? null : await speak(spoken);

  const convo = await prisma.conversation.findFirst({
    where: { channel: 'sim', peerPhone: opts.phone },
    select: { contextJson: true },
  });
  const ctx = convo?.contextJson as {
    basket?: Array<{ quantity: number; name: string }>;
    lastNamed?: Array<{ name: string }>;
  } | null;

  return {
    audio: said?.audio ?? null,
    trace: {
      heard: heard.text,
      heardRaw: heard.raw,
      asrEngine: heard.engine,
      asrMs: heard.latencyMs,
      reply,
      spoken,
      action: replies[0]?.intent ?? 'UNKNOWN',
      goal: replies[0]?.goal ?? 'UNKNOWN',
      ttsMs: said?.latencyMs ?? 0,
      totalMs: Date.now() - started,
      basket: (ctx?.basket ?? []).map((l) => `${l.quantity} x ${l.name}`),
      lastNamed: (ctx?.lastNamed ?? []).map((l) => l.name),
    },
  };
}
