'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { post } from '@/lib/api';

/**
 * Phone plus OTP. No password anywhere in this product, because a shop owner
 * does not want another password and their phone is how they log into
 * everything else in their life.
 */
function LoginInner() {
  const params = useSearchParams();
  const [phone, setPhone] = useState(params.get('phone') ?? '');
  const [otp, setOtp] = useState('');
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function sendOtp() {
    setBusy(true); setErr(null);
    try {
      const r = await post<{ sent: boolean; devOtp?: string }>('/auth/otp', { phone });
      setDevOtp(r.devOtp ?? null);
      setStep('otp');
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function verify() {
    setBusy(true); setErr(null);
    try {
      await post('/auth/verify', { phone, otp });
      router.push('/dashboard');
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <p className="muted text-sm tracking-widest uppercase">Nukkad</p>
      <h1 className="mt-3 text-2xl font-semibold">Dukaan login</h1>

      {step === 'phone' ? (
        <>
          <label className="muted mt-8 block text-sm">Mobile number</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="numeric"
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void sendOtp(); }}
            placeholder="98765 43210"
            className="panel mt-2 w-full px-4 py-3 outline-none" />
          {err && <p className="mt-4 text-sm text-[var(--warn)]">{err}</p>}
          <button onClick={sendOtp} disabled={phone.replace(/\D/g, '').length < 10 || busy}
            className="mt-4 rounded-lg bg-[var(--accent)] px-5 py-3 font-medium text-black disabled:opacity-40">
            {busy ? 'Bhej rahe hain...' : 'OTP bhejo'}
          </button>
          <Link href="/signup" className="muted mt-4 text-sm hover:text-[var(--accent)]">
            Nayi dukaan register karein
          </Link>
        </>
      ) : (
        <>
          <label className="muted mt-8 block text-sm">OTP</label>
          <input value={otp} onChange={(e) => setOtp(e.target.value)} inputMode="numeric" maxLength={6}
            onKeyDown={(e) => { if (e.key === 'Enter' && otp.length === 6 && !busy) void verify(); }}
            placeholder="000000"
            className="panel mt-2 w-full px-4 py-3 tracking-[0.4em] outline-none" />

          {devOtp && (
            <p className="muted mt-3 text-xs">
              Dev mode: OTP is <span className="text-[var(--accent)]">{devOtp}</span>.
              In production this arrives by SMS and is never shown here.
            </p>
          )}
          {err && <p className="mt-4 text-sm text-[var(--warn)]">{err}</p>}

          <button onClick={verify} disabled={otp.length !== 6 || busy}
            className="mt-4 rounded-lg bg-[var(--accent)] px-5 py-3 font-medium text-black disabled:opacity-40">
            {busy ? 'Check kar rahe hain...' : 'Login'}
          </button>
          <button onClick={() => { setStep('phone'); setErr(null); }} className="muted mt-3 text-sm">
            Number badlein
          </button>
        </>
      )}
    </main>
  );
}

export default function Login() {
  return <Suspense fallback={null}><LoginInner /></Suspense>;
}
