const BIAS = 0x84;
const CLIP = 32635;

function clamp16(sample: number): number {
  return Math.max(-32768, Math.min(32767, sample | 0));
}

export function muLawToPcm16(muLaw: Buffer): Buffer {
  const out = Buffer.allocUnsafe(muLaw.length * 2);

  for (let i = 0; i < muLaw.length; i += 1) {
    const u = ~muLaw[i]! & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + BIAS) << exponent;
    sample -= BIAS;
    if (sign) sample = -sample;
    out.writeInt16LE(clamp16(sample), i * 2);
  }

  return out;
}

function pcm16SampleToMuLaw(sample: number): number {
  let pcm = clamp16(sample);
  const sign = pcm < 0 ? 0x80 : 0;
  if (pcm < 0) pcm = -pcm;
  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (pcm & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent -= 1;
  }

  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function pcm16ToMuLaw(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / 2);
  const out = Buffer.allocUnsafe(samples);
  for (let i = 0; i < samples; i += 1) {
    out[i] = pcm16SampleToMuLaw(pcm.readInt16LE(i * 2));
  }
  return out;
}

export function resamplePcm16(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return input;

  const inSamples = Math.floor(input.length / 2);
  if (inSamples === 0) return Buffer.alloc(0);

  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = Buffer.allocUnsafe(outSamples * 2);
  const ratio = fromRate / toRate;

  for (let i = 0; i < outSamples; i += 1) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, inSamples - 1);
    const frac = pos - left;
    const a = input.readInt16LE(left * 2);
    const b = input.readInt16LE(right * 2);
    out.writeInt16LE(clamp16(a + (b - a) * frac), i * 2);
  }

  return out;
}
