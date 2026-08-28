import { env } from '../../config/env.js';
import type { Desk } from '../policy/desks.js';

/**
 * WHO SOUNDS LIKE WHOM. Presentation only.
 *
 * A desk is authority -- what it may do, what it may see -- and none of
 * that lives here. This file exists because a handoff the customer
 * cannot HEAR is a handoff that did not happen for them: the line "ek
 * second, billing counter pe lagata hoon" followed by the same voice
 * answering is one person doing a funny bit, while the same line
 * followed by a DIFFERENT voice is an organisation.
 *
 * Same shop, different counters: all bulbul:v3 speakers, so the accent
 * and register stay coherent and only the person changes. Configurable
 * per deployment through env, because a shopkeeper may well have
 * opinions about who answers their phone.
 *
 * The internal services -- offers, payment verification, inventory --
 * have no voice on purpose. The customer never talks to them; the desk
 * that consulted them stays the speaker, which is also how a real shop
 * works: the cashier checks with the back office and then tells you.
 */
export const DESK_VOICES: Record<Desk, string> = {
  RECEPTION: env.SARVAM_VOICE_RECEPTION,
  SELLER: env.SARVAM_VOICE_SELLER,
  CHECKOUT: env.SARVAM_VOICE_CHECKOUT,
  ENQUIRY: env.SARVAM_VOICE_ENQUIRY,
};

export const voiceFor = (desk: Desk): string => DESK_VOICES[desk];
