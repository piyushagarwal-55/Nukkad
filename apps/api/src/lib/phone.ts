/**
 * Transports disagree about phone formatting. Twilio prefixes WhatsApp
 * numbers with 'whatsapp:'. Everything inside the app uses bare E.164 so
 * one household is one row no matter which channel it arrives on.
 */
export function toE164(raw: string): string {
  const s = raw.trim().replace(/^whatsapp:/i, '').replace(/[\s()-]/g, '');
  if (s.startsWith('+')) return s;
  if (s.length === 10) return '+91' + s;         // bare Indian mobile
  if (s.startsWith('91') && s.length === 12) return '+' + s;
  return '+' + s;
}

export const toWhatsApp = (e164: string): string => 'whatsapp:' + toE164(e164);

/** Last 4 digits, for log lines that should not carry a full number. */
export const maskPhone = (e164: string): string => '...' + e164.slice(-4);
