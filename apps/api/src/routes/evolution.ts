import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { InboundMedia } from '@nukkad/shared';
import { prisma } from '@nukkad/db';
import { handle } from '../services/conversation/core.js';
import { env } from '../config/env.js';
import { sendText, evolutionReady } from '../services/channels/evolution.js';
import { supplierByPhone } from '../services/suppliers/order.js';
import { handleOwnerMessage } from '../services/procurement/owner.js';
import { ingestSupplierBill, notifyOwner } from '../services/procurement/settle-bill.js';

const MEDIA_DIR = join(process.cwd(), 'media');

/**
 * WHATSAPP THROUGH EVOLUTION API -- the development transport.
 *
 * Twilio's sandbox allows 50 messages a day, which a single test
 * conversation can spend before lunch. Evolution pairs a REAL WhatsApp
 * account over the unofficial Web protocol (whatsmeow/Baileys family):
 * unlimited messages, no join codes, actual WhatsApp UX in a demo.
 *
 * THE HONEST TRADE, stated where the code lives: this is against
 * WhatsApp's terms and Meta does ban numbers that use it. It is paired
 * with a SPARE number, never a personal one, and it is a development
 * harness -- the production story remains an official API (Meta Cloud /
 * Twilio), which is why this file is one thin adapter over the same
 * handle() every other transport uses. Swapping transports later means
 * replacing this file, nothing else.
 *
 * SETUP (once):
 *   docker run -d --name evolution -p 8080:8080 \
 *     -e AUTHENTICATION_API_KEY=<pick-a-key> atendai/evolution-api:v2.1.1
 *   POST {EVOLUTION_URL}/instance/create {"instanceName":"nukkad","qrcode":true}
 *   scan the QR with the spare phone's WhatsApp
 *   POST {EVOLUTION_URL}/webhook/set/nukkad
 *     {"webhook":{"enabled":true,"url":"<this-server>/evolution/webhook",
 *      "events":["MESSAGES_UPSERT"]}}
 */
export async function evolutionRoutes(app: FastifyInstance) {
  const configured = evolutionReady;

  /**
   * Which shop does this number OWN, if any. The env override wins so a
   * demo handset can act as the owner without editing the shop's row.
   */
  const ownerOf = async (phone: string) => {
    if (env.OWNER_WHATSAPP) {
      return env.OWNER_WHATSAPP === phone
        ? prisma.kirana.findFirst({ orderBy: { createdAt: 'asc' } })
        : null;
    }
    return prisma.kirana.findFirst({ where: { phone } });
  };

  /** send one text back through the paired account */
  async function send(to: string, text: string): Promise<void> {
    const res = await sendText(to, text);
    if (!res.ok) app.log.warn({ to, error: res.error }, 'evolution send failed');
  }

  /**
   * Pull the actual bytes for an image or voice note. The webhook carries
   * only the encrypted-media envelope; Evolution's
   * getBase64FromMediaMessage decrypts and downloads. We pass the whole
   * {key, message} pair from the webhook so it never needs a store
   * lookup, and we save to disk because that is the shape handle()'s
   * vision and ASR pipelines already eat (same as the Twilio adapter).
   */
  async function fetchMedia(d: {
    key?: { id?: string };
    message?: object;
  }): Promise<InboundMedia | null> {
    try {
      const res = await fetch(
        `${env.EVOLUTION_URL}/chat/getBase64FromMediaMessage/${env.EVOLUTION_INSTANCE}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: env.EVOLUTION_APIKEY! },
          body: JSON.stringify({
            message: { key: d.key, message: d.message },
            convertToMp4: false,
          }),
        },
      );
      if (!res.ok) {
        app.log.warn({ status: res.status, body: await res.text() }, 'evolution media fetch failed');
        return null;
      }
      const j = (await res.json()) as { base64?: string; mimetype?: string };
      if (!j.base64) return null;

      const buf = Buffer.from(j.base64, 'base64');
      const mime = j.mimetype ?? 'application/octet-stream';
      const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('png') ? 'png'
                : mime.includes('webp') ? 'webp' : mime.includes('ogg') ? 'ogg'
                : mime.includes('mpeg') ? 'mp3' : mime.includes('mp4') ? 'm4a' : 'bin';
      await mkdir(MEDIA_DIR, { recursive: true });
      const path = join(MEDIA_DIR, `evo_${d.key?.id ?? randomUUID()}.${ext}`);
      await writeFile(path, buf);
      return { localPath: path, mime, bytes: buf.length };
    } catch (err) {
      app.log.warn({ err }, 'evolution media fetch threw');
      return null;
    }
  }

  app.post('/evolution/webhook', async (req, reply) => {
    if (!configured()) return reply.code(503).send({ error: 'evolution not configured' });

    /**
     * Evolution wraps events as { event, instance, data }. A message is
     * MESSAGES_UPSERT with data.key.remoteJid (the peer),
     * data.key.fromMe, and the text living in one of two places
     * depending on message kind. Parsed defensively and LOGGED when the
     * shape surprises us, because the payload format is the one thing
     * here we cannot pin from our side.
     */
    const body = req.body as {
      event?: string;
      data?: {
        key?: {
          remoteJid?: string;
          fromMe?: boolean;
          id?: string;
          /** when addressingMode is "lid", the real phone jid rides here */
          remoteJidAlt?: string;
          senderPn?: string;
        };
        message?: {
          conversation?: string;
          extendedTextMessage?: { text?: string };
          imageMessage?: { caption?: string; mimetype?: string };
          audioMessage?: { mimetype?: string };
          documentMessage?: { caption?: string; mimetype?: string };
        };
        pushName?: string;
      };
    };

    const event = (body.event ?? '').toLowerCase().replace(/_/g, '.');
    if (event !== 'messages.upsert') return { ok: true };

    const d = body.data;
    // our own outbound messages echo back through the same event
    if (!d?.key?.remoteJid || d.key.fromMe) return { ok: true };
    // groups and broadcast lists are not customers
    const jid = d.key.remoteJid;
    if (jid.endsWith('@g.us') || jid.includes('broadcast')) return { ok: true };

    /**
     * WHATSAPP'S LID ADDRESSING, the bug that ate a photo. Newer clients
     * deliver a chat as "<opaque>@lid" -- a privacy alias, not a phone --
     * with the real number in key.remoteJidAlt (or senderPn on some
     * builds). The old check here demanded @s.whatsapp.net and silently
     * dropped every LID message as "not a customer".
     */
    const pnJid = [jid, d.key.remoteJidAlt, d.key.senderPn].find((j) =>
      j?.endsWith('@s.whatsapp.net'),
    );
    if (!pnJid) {
      app.log.warn({ jid, keys: Object.keys(d.key) }, 'evolution: no phone jid on message');
      return { ok: true };
    }

    /**
     * A photo of a saman list arrives as imageMessage (caption optional),
     * a voice note as audioMessage, and some phones send photos as
     * documents. All carry no `conversation` text -- which is why "ai not
     * worked on photo" was the bug report that added this branch.
     */
    const m = d.message ?? {};
    const docIsImage = m.documentMessage?.mimetype?.startsWith('image/') ?? false;
    const wantsMedia = !!m.imageMessage || !!m.audioMessage || docIsImage;
    const text =
      m.conversation
      ?? m.extendedTextMessage?.text
      ?? m.imageMessage?.caption
      ?? (docIsImage ? m.documentMessage?.caption : undefined)
      ?? '';
    if (!text.trim() && !wantsMedia) {
      app.log.info({ keys: Object.keys(m) }, 'evolution: no text or media in message');
      return { ok: true };
    }

    const phone = `+${pnJid.split('@')[0]}`;

    /**
     * Answered AFTER acking the webhook, not inside it. Evolution
     * retries slow webhooks, and a retried webhook is a customer
     * answered twice. The externalId carries WhatsApp's own message id,
     * so even a delivered retry would be traceable.
     */
    setImmediate(async () => {
      try {
        /**
         * A SUPPLIER IS NOT A CUSTOMER, and the desks must never see one.
         *
         * The distributor replying "kal bhej dunga" to a restock order is
         * not shopping. Without this the message would route straight
         * into handle(), find no household, and the shop would try to
         * sell its own supplier a kilo of atta -- and worse, a supplier
         * saying "haan bhej do" could answer a pending question that
         * belonged to somebody else's conversation.
         *
         * So it is recorded on the supplier thread and answered by
         * nobody. The shopkeeper reads it on the dashboard, which is
         * where a reply from a distributor actually belongs.
         */
        /**
         * THE OWNER IS NOT A CUSTOMER EITHER, and this branch outranks
         * every other one.
         *
         * When the shopkeeper replies to the nightly stock order, "haan"
         * means SPEND MY MONEY WITH THE DISTRIBUTOR. Sent into the retail
         * spine that same "haan" would answer whatever question the desks
         * happened to be holding -- confirming a basket, approving a
         * checkout -- which is the wrong yes to the wrong question with
         * real rupees behind it.
         *
         * So the owner's number reaches the procurement desk and nothing
         * else. Two different conversations that happen to share a
         * transport, kept apart at the door.
         */
        const owner = await ownerOf(phone);
        if (owner) {
          const reply = await handleOwnerMessage(owner.id, text);
          const convo = await prisma.conversation.upsert({
            where: { channel_peerPhone: { channel: 'evolution', peerPhone: phone } },
            create: {
              channel: 'evolution', peerPhone: phone,
              partyRole: 'KIRANA', kiranaId: owner.id, lastInboundAt: new Date(),
            },
            update: { partyRole: 'KIRANA', kiranaId: owner.id, lastInboundAt: new Date() },
          });
          await prisma.message.createMany({
            data: [
              { conversationId: convo.id, direction: 'IN', externalId: d.key?.id ?? null, body: text, intent: 'INSTRUCT', goal: 'RESTOCKING' },
              { conversationId: convo.id, direction: 'OUT', body: reply.text, intent: 'ANSWER', goal: 'RESTOCKING' },
            ],
            skipDuplicates: true,
          }).catch(() => {});
          await send(phone, reply.text);
          app.log.info({ shop: owner.name, sent: reply.sentToSupplier ?? false }, 'evolution: owner turn');
          return;
        }

        const supplier = await supplierByPhone(phone);
        if (supplier) {
          const convo = await prisma.conversation.upsert({
            where: { channel_peerPhone: { channel: 'evolution', peerPhone: phone } },
            create: {
              channel: 'evolution', peerPhone: phone,
              partyRole: 'SUPPLIER', kiranaId: supplier.kiranaId,
              lastInboundAt: new Date(),
            },
            update: { partyRole: 'SUPPLIER', lastInboundAt: new Date() },
          });
          await prisma.message.create({
            data: {
              conversationId: convo.id,
              direction: 'IN',
              externalId: d.key?.id ?? null,
              body: text || '[media]',
              intent: 'INFORM',
              goal: 'RESTOCKING',
            },
          }).catch(() => {});
          /**
           * A SUPPLIER REPLY IS USUALLY A BILL, and a bill is the thing
           * the procurement loop has been waiting for. Photograph or
           * typed breakdown, both go to the same reader, which compares
           * it against what was actually ordered and tells the owner
           * what disagrees. Nothing here pays anything -- see
           * procurement/pay.ts for why that refusal is a file.
           */
          const media: InboundMedia[] = [];
          if (wantsMedia) {
            const item = await fetchMedia(d);
            if (item) media.push(item);
          }

          const bill = await ingestSupplierBill({
            kiranaId: supplier.kiranaId,
            supplierName: supplier.name,
            imagePath: media[0]?.localPath,
            mime: media[0]?.mime,
            text,
          }).catch((err) => {
            app.log.error({ err }, 'supplier bill ingest failed');
            return { handled: false as const };
          });

          if (bill.handled && bill.ownerText) {
            const ownerPhone = env.OWNER_WHATSAPP || supplier.kirana.phone;
            await notifyOwner(supplier.kiranaId, ownerPhone, bill.ownerText);
            app.log.info({ supplier: supplier.name, total: bill.totalPaise }, 'evolution: bill ingested');
          } else {
            app.log.info({ supplier: supplier.name }, 'evolution: supplier reply recorded');
          }
          return;
        }

        const media: InboundMedia[] = [];
        if (wantsMedia) {
          const item = await fetchMedia(d);
          if (item) media.push(item);
          else if (!text.trim()) {
            app.log.warn({ id: d.key?.id }, 'evolution: media message but bytes unfetchable');
            await send(phone, 'Photo mili par khul nahi payi. Ek baar phir bhej dijiye?');
            return;
          }
        }
        const replies = await handle({
          channel: 'evolution',
          senderId: phone,
          recipientId: env.EVOLUTION_SHOP_PHONE || phone,
          text: text.trim() || undefined,
          media,
          externalId: `evo_${d.key?.id ?? randomUUID()}`,
          receivedAt: new Date(),
        });
        for (const r of replies) await send(phone, r.text);
      } catch (err) {
        app.log.error({ err, phone }, 'evolution turn failed');
      }
    });

    return { ok: true };
  });
}
