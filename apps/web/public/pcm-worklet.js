/**
 * MICROPHONE TO 16-BIT PCM, on the audio thread.
 *
 * Sarvam's realtime socket takes linear16 mono and nothing else, and
 * MediaRecorder -- which the button version of this page used -- only
 * produces webm/opus. There is no way to ask it for raw samples, so the
 * capture path has to move down a level to the Web Audio graph.
 *
 * This runs on the audio rendering thread, where the only job is to
 * convert and hand off. Anything expensive here is heard as a glitch, so
 * the loop below does one multiply and one clamp per sample and posts the
 * buffer to the main thread, which owns the socket.
 *
 * The AudioContext is created at 16000Hz by the page, so there is no
 * resampling to do here -- the browser's own graph does it, better than a
 * hand-written decimator would and for free.
 */
class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    /**
     * 128 samples is one render quantum, which at 16kHz is 8ms -- far too
     * small to send as its own frame. Sarvam expects roughly 100ms, so
     * quanta are gathered until there are enough and sent as one.
     */
    this.target = 1600; // 100ms at 16kHz
    this.buffer = new Int16Array(this.target);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    // no input yet, or the track ended. Staying alive is correct either way.
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      /**
       * Float32 in [-1, 1] to signed 16-bit. Clamped rather than trusted:
       * a sample fractionally over 1.0 wraps to a large negative number,
       * which is heard as a click and, worse, read by a recogniser as a
       * consonant that was never spoken.
       */
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;

      if (this.filled === this.target) {
        // a copy, because the port transfers and this buffer is reused
        this.port.postMessage(this.buffer.slice());
        this.filled = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-worklet', PCMWorklet);
