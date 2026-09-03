# Nukkad — The Voice Pipeline

Deep reference for `apps/api/src/routes/stream.ts`, `services/asr/`, `services/voice/`, and the voice console at `apps/web/src/app/dashboard/voice/page.tsx`.

## Shape of a voice session

The browser console opens a WebSocket to the API (`/stream`). Mic audio is captured by an AudioWorklet and streamed up as PCM; the session opens with the conversation moved to RECEPTION (`deskTo` — a call starts at the front desk; the basket survives, see ADR-017). Downstream, the customer hears: an instant reaction filler when useful, then the reply audio streamed sentence-by-sentence, with a desk chip and a latency trace rendered per turn. Barge-in: the moment the mic detects the customer speaking, playback stops. Playback is a 24kHz PCM AudioContext fed by binary frames; control frames are JSON (`{type:'pause', ms:650}` among them).

## Listening — Sarvam saaras streaming STT (`services/asr/realtime.ts`)

- WebSocket streaming with server-side VAD deciding turn ends.
- **Partials prepare, finals commit.** Partial transcripts warm the turn (UI, early work) but only a final transcript enters `handle()`. This split is load-bearing: acting on partials double-executes turns.
- **Silence padding is required.** Without trailing silence appended to the stream, finals never fire. (Discovered empirically; the padding is injected server-side.)
- `mode=translit` — Roman output. `codemix` returns Devanagari, which the resolver's normaliser strips to an empty string that then confidently matches the same wrong SKU every time. This single config character is the difference between a working and a silently-broken system (see ADR-005).
- Batch fallback path (voice notes, `routes/voice.ts`): saaras:v4, then Shunya zero-indic (`language=en` — `hi` returns Devanagari), then Groq Whisper (`language=hi` pinned; auto-detect flip-flops on Hinglish). Engines are ranked by `scripts/asr-bench.ts` on recorded real utterances.

## The single turn door

Every way a turn can begin — an STT final, a typed `{type:'text'}` frame from the console's test input — funnels through one `startTurn()` in `stream.ts`. Voice turns and typed turns are indistinguishable to the spine, which means the whole conversation engine is testable without a microphone and the dialogue suite exercises exactly the code a caller hits. Rapid successive inputs coalesce (`conversation/coalesce.ts`) rather than racing.

## Reaction fillers

Keyed on the *speech act* (`REACTIONS` in stream.ts): an acknowledgment sound ("haan ji…", "ek second…") plays while the real answer is composed. Tuned after real complaints: variant pools with last-filler avoidance (no more "haan ji" every single turn), trigger threshold raised 700→1200ms (fast turns need no filler), and two consecutive silences collapse into one filler, not two.

## Speaking — bulbul:v3 streaming TTS (`services/voice/mouth.ts`)

`openMouth({speaker})` holds one TTS WebSocket per session. `BASE_CONFIG`: linear16 PCM, `min_buffer_size` 40, max 180. Two facts about bulbul's protocol shape everything:

1. **`min_buffer_size` alone never triggers synthesis — you must flush.** The composer's token stream is cut at sentence boundaries and each sentence is flushed immediately. Sentence→sound measured at **254–277ms** (vs ~1600ms batch synthesis of the whole reply).
2. **Config is updatable mid-lifecycle, and buffered text flushes in the old voice first.** Therefore a speaker switch is **one JSON config frame on the same socket** — no reconnect, no dead air. `setSpeaker()`: pre-open it edits the handshake config; post-open it sends the frame. Proven live by `scripts/mouth.ts`: 9 chunks in the old voice → config frame → 10 chunks in the new voice, ~250ms, audio continuing after the switch.

## Per-desk voices and the audible handoff

`services/voice/voices.ts` maps `DESK_VOICES`: RECEPTION **priya**, SELLER **rahul**, CHECKOUT **ritu**, ENQUIRY **aditya** — all bulbul:v3 speakers (valid set: aditya, ritu, priya, rahul, pooja, rohan; a stale v2 name 400s the whole call), each overridable via `SARVAM_VOICE_RECEPTION/SELLER/CHECKOUT/ENQUIRY`. On a desk transfer the sequence is: the *old* desk speaks its transfer line in its own voice → the flush's completion event marks the audio boundary → `onDesk` fires the speaker switch → a deliberate **650ms pause** frame is sent to the client (`pauseNext` set at transfer, emitted after the first post-transfer flush completes) → the *new* voice answers the carried message. The pause is pure theatre and entirely the point: it is what makes "connecting you to the counter" feel like being connected rather than like one bot changing its mind.

## Latency ledger (measured, not estimated)

| Metric | Before | After | How |
|---|---|---|---|
| First-turn ear→sound | 13,052ms | 2,198ms | warm Sarvam endpoints, deduplicated understanding, streaming TTS |
| Sentence→first audio | ~1,600ms (batch) | 254–277ms | sentence-cut flush on streaming socket |
| Speaker switch | (reconnect ≈ 1s+) | ~250ms | config frame on same socket |
| Ear (speech-end→final) | ~4,600ms worst observed | VAD + padding tuning | `scripts/ear.ts` |

The console trace is honest by construction: "first sound" is stamped when the first **audio chunk** arrives (bounded wait 4s), after an earlier version stamped at send time and reported a flattering 0ms. Streaming the *composer's* LLM tokens end-to-end was implemented and measured to not help (commit `8401dac`); the measurement was kept, the complexity was not.

## The voice console (`dashboard/voice/page.tsx`)

Open-mic capture with VAD-driven turn ends; a typed input (`sendTyped`) for keyboard testing through the same turn door; the current-desk chip; per-turn trace (ear, first sound, desk, handoff path); 24kHz PCM playback; pause-frame handling. **Open item:** a hybrid spacebar push-to-talk (hold space to gate worklet frames; on release inject ~700ms of silent PCM to force the VAD final) has been prototyped (commit `4385685`) but its final wiring alongside open-mic is pending.

## Voice-specific conversation rules

Spoken replies use `BREVITY_VOICE` — complete, natural sentences rather than clipped fragments (built after the "ur every reply is just cut to cut" feedback) — while text channels keep `BREVITY_TEXT`. The director's anti-repetition avoid-lists matter double on voice, where repeated phrasing is immediately audible; reception uses the caller's name (rationed by `nameThisTurn`); and the BROWSING mode's "never ask quantity" rule exists mostly for voice, where a pushed "Kitna bhejun?" at a browser is the fastest way to sound like a vending machine.
