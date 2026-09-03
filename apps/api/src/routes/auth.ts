import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '@nukkad/db';
import { env } from '../config/env.js';
import { toE164, maskPhone } from '../lib/phone.js';
import { COOKIE, issue, verify, newOtp, hashOtp, OTP_TTL_MS, type Session } from '../lib/session.js';

const signupSchema = z.object({
  shopName: z.string().min(2),
  ownerName: z.string().min(2),
  phone: z.string().min(10),
  address: z.string().optional(),
});

const phoneSchema = z.object({ phone: z.string().min(10) });
const verifySchema = z.object({ phone: z.string().min(10), otp: z.string().length(6) });
const secureCookies = env.NODE_ENV === 'production' || env.PUBLIC_BASE_URL?.startsWith('https://');

/** Throws a 401-shaped error if there is no valid session. */
export function requireSession(req: FastifyRequest): Session {
  const s = verify(req.cookies?.[COOKIE]);
  if (!s) {
    const err = new Error('not signed in') as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }
  return s;
}

export async function authRoutes(app: FastifyInstance) {
  /**
   * Signup creates the shop and its first user together. One shop per phone.
   */
  app.post('/auth/signup', async (req, reply) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    const phone = toE164(parsed.data.phone);
    if (await prisma.shopUser.findUnique({ where: { phone } })) {
      return reply.code(409).send({ error: 'A shop is already registered on this number. Log in instead.' });
    }

    const kirana = await prisma.kirana.create({
      data: {
        name: parsed.data.shopName,
        ownerName: parsed.data.ownerName,
        phone,
        address: parsed.data.address ?? null,
        users: { create: { phone, name: parsed.data.ownerName } },
      },
    });

    app.log.info({ shop: kirana.name, phone: maskPhone(phone) }, 'shop registered');
    return { ok: true, kiranaId: kirana.id };
  });

  /**
   * Send an OTP.
   *
   * DEV ONLY: the code is returned in the response so a demo never waits on
   * SMS delivery. Hard-gated on NODE_ENV. In production this goes out over
   * SMS or WhatsApp and the field is absent.
   */
  app.post('/auth/otp', async (req, reply) => {
    const parsed = phoneSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'phone required' });

    const phone = toE164(parsed.data.phone);
    const user = await prisma.shopUser.findUnique({ where: { phone } });
    if (!user) return reply.code(404).send({ error: 'That number is not registered. Create a shop first.' });

    const otp = newOtp();
    await prisma.shopUser.update({
      where: { id: user.id },
      data: { otpHash: hashOtp(otp), otpSentAt: new Date() },
    });

    app.log.info({ phone: maskPhone(phone), otp }, 'OTP issued');

    return env.NODE_ENV === 'development'
      ? { sent: true, devOtp: otp }
      : { sent: true };
  });

  app.post('/auth/verify', async (req, reply) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'phone and 6-digit otp required' });

    const phone = toE164(parsed.data.phone);
    const user = await prisma.shopUser.findUnique({ where: { phone }, include: { kirana: true } });

    if (!user?.otpHash || !user.otpSentAt) {
      return reply.code(400).send({ error: 'Request a code first.' });
    }
    if (Date.now() - user.otpSentAt.getTime() > OTP_TTL_MS) {
      return reply.code(400).send({ error: 'That code has expired. Request a new one.' });
    }
    if (hashOtp(parsed.data.otp) !== user.otpHash) {
      return reply.code(401).send({ error: 'That code is not right.' });
    }

    // single use
    await prisma.shopUser.update({
      where: { id: user.id },
      data: { otpHash: null, otpSentAt: null, lastLogin: new Date() },
    });

    reply.setCookie(COOKIE, issue(user.id, user.kiranaId), {
      path: '/',
      httpOnly: true,
      sameSite: secureCookies ? 'none' : 'lax',
      secure: secureCookies,
      maxAge: 30 * 86_400,
    });

    return { ok: true, kiranaId: user.kiranaId, shopName: user.kirana.name };
  });

  app.get('/auth/me', async (req, reply) => {
    const s = verify(req.cookies?.[COOKIE]);
    if (!s) return reply.code(401).send({ error: 'not signed in' });

    const kirana = await prisma.kirana.findUnique({
      where: { id: s.kiranaId },
      include: { _count: { select: { skus: true, households: true, orders: true } } },
    });
    if (!kirana) return reply.code(401).send({ error: 'shop gone' });

    return {
      kiranaId: kirana.id,
      shopName: kirana.name,
      ownerName: kirana.ownerName,
      whatsappNumber: kirana.whatsappNumber,
      wabaStatus: kirana.wabaStatus,
      counts: kirana._count,
    };
  });

  app.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, {
      path: '/',
      sameSite: secureCookies ? 'none' : 'lax',
      secure: secureCookies,
    });
    return { ok: true };
  });
}
