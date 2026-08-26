import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import twilio from 'twilio';
import type { ChannelAdapter, InboundMessage, InboundMedia, OutboundMessage } from '@nukkad/shared';
import { env } from '../config/env.js';
import { toE164, toWhatsApp } from '../lib/phone.js';

const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
const MEDIA_DIR = join(process.cwd(), 'media');

/** Twilio posts application/x-www-form-urlencoded. */
interface TwilioInboundForm {
  MessageSid: string;
  From: string;
  To: string;
  Body?: string;
  NumMedia?: string;
  [k: string]: string | undefined;
}

/**
 * GOTCHA THAT COSTS AN HOUR: Twilio media URLs are NOT public. They need
 * HTTP Basic Auth with AccountSid as username and AuthToken as password,
 * and the URL they redirect to is only valid for FOUR HOURS. So download
 * the bytes on receipt and store them. Never persist the URL.
 */
async function downloadMedia(url: string, sid: string, idx: number): Promise<InboundMedia> {
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`twilio media ${res.status} for ${sid}#${idx}`);

  const mime = res.headers.get('content-type') ?? 'application/octet-stream';
  const buf = Buffer.from(await res.arrayBuffer());

  await mkdir(MEDIA_DIR, { recursive: true });
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mpeg') ? 'mp3'
            : mime.includes('jpeg') ? 'jpg' : mime.includes('png') ? 'png' : 'bin';
  const path = join(MEDIA_DIR, `${sid}_${idx}.${ext}`);
  await writeFile(path, buf);

  return { localPath: path, mime, bytes: buf.length };
}

export const twilioAdapter: ChannelAdapter = {
  id: 'twilio',

  async parse(payload: unknown): Promise<InboundMessage> {
    const f = payload as TwilioInboundForm;
    const count = Number.parseInt(f.NumMedia ?? '0', 10) || 0;

    const media: InboundMedia[] = [];
    for (let i = 0; i < count; i++) {
      const url = f[`MediaUrl${i}`];
      if (url) media.push(await downloadMedia(url, f.MessageSid, i));
    }

    return {
      channel: 'twilio',
      senderId: toE164(f.From),
      recipientId: toE164(f.To),
      text: f.Body?.trim() || undefined,
      media,
      externalId: f.MessageSid,
      receivedAt: new Date(),
    };
  },

  async send(to: string, msg: OutboundMessage): Promise<void> {
    // Meta forbids free-form business-initiated messages outside the 24h
    // session window. When templateName is set the caller has already
    // decided this is a knock, so we must not invent copy.
    // Sandbox only exposes a few pre-approved templates, so in sandbox we
    // send the rendered text and rely on the session being warm.
    const body = msg.templateName
      ? renderTemplate(msg)
      : withQuickReplies(msg);

    await client.messages.create({
      from: env.TWILIO_WHATSAPP_FROM,
      to: toWhatsApp(to),
      body,
    });
  },
};

/**
 * Sandbox has no interactive list picker, and a numbered text menu is more
 * robust on a low-end phone anyway. So quick replies render as digits.
 */
function withQuickReplies(msg: OutboundMessage): string {
  if (!msg.quickReplies?.length) return msg.text;
  const lines = msg.quickReplies.map((q) => `${q.id} = ${q.label}`);
  return `${msg.text}\n\n${lines.join('\n')}`;
}

function renderTemplate(msg: OutboundMessage): string {
  let out = msg.text;
  msg.templateVars?.forEach((v, i) => {
    out = out.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, 'g'), v);
  });
  return out;
}
