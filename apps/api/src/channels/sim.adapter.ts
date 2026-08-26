import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChannelAdapter, InboundMessage, InboundMedia, OutboundMessage } from '@nukkad/shared';
import { toE164 } from '../lib/phone.js';

const MEDIA_DIR = join(process.cwd(), 'media');

/**
 * The judge-facing surface.
 *
 * A browser posts here instead of Twilio, and everything downstream is
 * identical. That is the whole point, and it is the sentence said on
 * stage: same webhook, same ranker, same ledger, only the transport
 * differs. It also means the demo survives dead venue wifi and a judge
 * who does not want to text a US sandbox number.
 */

const outbox = new Map<string, OutboundMessage[]>();

export interface SimInbound {
  senderId: string;
  recipientId: string;
  text?: string;
  /** data URI or base64. Browser MediaRecorder gives webm/opus, WhatsApp gives ogg/opus. */
  mediaBase64?: string;
  mediaMime?: string;
}

export const simAdapter: ChannelAdapter = {
  id: 'sim',

  async parse(payload: unknown): Promise<InboundMessage> {
    const p = payload as SimInbound;
    const media: InboundMedia[] = [];

    if (p.mediaBase64) {
      const mime = p.mediaMime ?? 'audio/webm';
      const raw = p.mediaBase64.includes(',') ? p.mediaBase64.split(',')[1]! : p.mediaBase64;
      const buf = Buffer.from(raw, 'base64');
      await mkdir(MEDIA_DIR, { recursive: true });
      const ext = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : 'bin';
      const path = join(MEDIA_DIR, `sim_${randomUUID()}.${ext}`);
      await writeFile(path, buf);
      media.push({ localPath: path, mime, bytes: buf.length });
    }

    return {
      channel: 'sim',
      senderId: toE164(p.senderId),
      recipientId: toE164(p.recipientId),
      text: p.text?.trim() || undefined,
      media,
      externalId: `sim_${randomUUID()}`,
      receivedAt: new Date(),
    };
  },

  async send(to: string, msg: OutboundMessage): Promise<void> {
    const key = toE164(to);
    const list = outbox.get(key) ?? [];
    list.push(msg);
    outbox.set(key, list);
  },
};

/** The simulator page polls this to render the thread. */
export function drainSimOutbox(to: string): OutboundMessage[] {
  const key = toE164(to);
  const list = outbox.get(key) ?? [];
  outbox.set(key, []);
  return list;
}
