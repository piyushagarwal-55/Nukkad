import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openEar } from '../services/asr/realtime.js';

/**
 * DOES THE REALTIME EAR ACTUALLY WORK.
 *
 *   npm run ear --workspace=@nukkad/api
 *
 * Streams a recorded WAV into saaras:v3-realtime at the pace it was
 * spoken and prints every event as it arrives. Written before trusting
 * the socket in the browser, because a WebSocket protocol is a lot of
 * assumptions -- query parameters, header auth, base64 framing, event
 * names -- and finding out which one is wrong through a microphone and a
 * React page is a bad way to spend an afternoon.
 *
 * What it proves, in order of how likely each was to be wrong:
 *
 *   the handshake      right URL, right header, accepted parameters
 *   the framing        100ms of linear16 base64 in an audio_input event
 *   the partials       interim text arriving DURING the audio, not after
 *   the VAD            speech_start and speech_end without being asked
 *   the final          one complete utterance, in Roman script
 *
 * PACED IN REAL TIME on purpose. Firing the whole file at once would tell
 * you the transcription works and nothing about whether partials arrive
 * early, which is the entire reason for the change.
 */

const DIR = join(process.cwd(), 'media', 'voice');
const CHUNK = 3200; // 100ms of 16-bit mono at 16kHz

const files = (await readdir(DIR).catch(() => [])).filter((f) => f.endsWith('.wav'));
if (!files.length) {
  console.error(`no wav files in ${DIR} -- record a turn on /dashboard/voice first`);
  process.exit(1);
}

const pick = process.argv[2] ?? files[files.length - 1]!;
const wav = await readFile(join(DIR, pick));

/**
 * The 44-byte canonical header is skipped rather than parsed. These files
 * are written by our own toWav16k, so the format is known -- and if it
 * ever is not, the transcript comes back as noise, which is a louder
 * failure than a silently mis-parsed chunk offset.
 */
const pcm = wav.subarray(44);
console.log(`${pick}  ${(pcm.length / 32000).toFixed(1)}s of audio\n`);

const at = Date.now();
const since = () => String(Date.now() - at).padStart(5);

let partials = 0;
let firstPartialMs = 0;
let speechEndMs = 0;
let finalMs = 0;

const ear = openEar({
  onSpeechStart: () => console.log(`${since()}ms  vad.speech_start`),
  onSpeechEnd: () => {
    speechEndMs = Date.now() - at;
    console.log(`${since()}ms  vad.speech_end`);
  },
  onPartial: (text) => {
    partials++;
    if (!firstPartialMs) firstPartialMs = Date.now() - at;
    console.log(`${since()}ms  partial   "${text}"`);
  },
  onFinal: (text, language) => {
    finalMs = Date.now() - at;
    console.log(`${since()}ms  FINAL     "${text}"  [${language ?? 'unknown'}]`);
  },
  onError: (message, fatal) => console.error(`${since()}ms  error     ${message} (fatal=${fatal})`),
  onClose: () => {
    /**
     * THE NUMBER THAT MATTERS IS THE FINAL AFTER SPEECH ENDS, not the
     * partial before it.
     *
     * The first version of this report compared the first partial to the
     * end of the audio file and called a late partial a failure. Wrong
     * question, twice over. Partials are never acted on -- they exist to
     * put words on a screen -- and the file's length includes whatever
     * silence was recorded before anyone actually spoke.
     *
     * What the agent waits for is the final, and what the CUSTOMER waits
     * for is the gap between finishing their sentence and the shop having
     * their words. Under the batch API that gap was a whole upload plus a
     * whole transcription: ~550ms warm, 4603ms on the first turn of a
     * session. Here it is whatever prints below.
     */
    console.log(`\n  ${partials} partials, first at ${firstPartialMs}ms`);
    console.log(`  speech ended ${speechEndMs}ms, final ${finalMs}ms`);
    console.log(`  TRANSCRIPT READY ${finalMs - speechEndMs}ms after they stopped talking`);
    process.exit(0);
  },
});

for (let i = 0; i < pcm.length; i += CHUNK) {
  ear.send(pcm.subarray(i, i + CHUNK));
  // paced as spoken, so the partials mean what they appear to mean
  await new Promise((r) => setTimeout(r, 100));
}

/**
 * SILENCE AFTER THE WORDS, and this is not padding for its own sake.
 *
 * Server-side VAD ends a turn when it HEARS silence, and simply
 * stopping the stream is not silence -- it is nothing at all, which is
 * indistinguishable from a stalled connection. The first run of this
 * script sent 2.0s of speech, stopped dead, and got vad.speech_start
 * with no transcript: the recogniser was still waiting for the utterance
 * to end. A live microphone always sends the room tone that follows a
 * sentence; a file has to be given some.
 */
const quiet = Buffer.alloc(CHUNK);
for (let i = 0; i < 15; i++) {
  ear.send(quiet);
  await new Promise((r) => setTimeout(r, 100));
}

await new Promise((r) => setTimeout(r, 3000));
ear.close();
