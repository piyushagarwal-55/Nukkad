import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';

/**
 * Two audio formats arrive and they are not the same:
 *   WhatsApp voice note  -> audio/ogg; codecs=opus
 *   Browser MediaRecorder -> audio/webm; codecs=opus
 *
 * Whisper on Groq accepts both, so normalisation is usually a no-op. It
 * is kept behind this boundary anyway so that the day a transport sends
 * amr or m4a, exactly one file changes.
 */
export async function ffmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => resolve(false));
    p.on('close', (c) => resolve(c === 0));
  });
}

export async function toWav16k(inputPath: string, outputPath: string): Promise<string> {
  if (!(await ffmpegAvailable())) return inputPath;
  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', outputPath]);
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg exit ' + c))));
  });
  await access(outputPath);
  return outputPath;
}

export const isAudio = (mime: string): boolean => mime.startsWith('audio/');
export const isImage = (mime: string): boolean => mime.startsWith('image/');
