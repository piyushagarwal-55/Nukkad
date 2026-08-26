'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { post } from '@/lib/api';
import { AuthSplit } from '@/components/AuthSplit';

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
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ sent: boolean; devOtp?: string }>('/auth/otp', { phone });
      setDevOtp(r.devOtp ?? null);
      setStep('otp');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setErr(null);
    try {
      await post('/auth/verify', { phone, otp });
      router.push('/dashboard');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const error = err && (
    <p className="mt-5 rounded-lg border border-[var(--hot)]/30 bg-[var(--hot)]/8 px-3 py-2.5 text-sm text-[var(--hot)]">
      {err}
    </p>
  );

  return (
    <AuthSplit>
      {step === 'phone' ? (
        <>
          <h1 className="display text-[clamp(2rem,4vw,2.6rem)]">Log in to your shop</h1>
          <p className="muted mt-3 text-[15px] leading-relaxed">
            Enter your number and we will text you a code.
          </p>

          <div className="mt-9">
            <label
              htmlFor="phone"
              className="mb-2 block text-[13px] font-medium text-[var(--muted)]"
            >
              Mobile number
            </label>
            <input
              id="phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="numeric"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void sendOtp();
              }}
              placeholder="98765 43210"
              className="auth-field px-4 py-3.5 text-[15px]"
            />
          </div>

          {error}

          <button
            onClick={sendOtp}
            disabled={phone.replace(/\D/g, '').length < 10 || busy}
            className="auth-cta mt-7 w-full py-3.5 text-[15px] font-semibold"
          >
            {busy ? 'Sending…' : 'Send code'}
          </button>

          <p className="muted mt-6 text-sm">
            New shop?{' '}
            <Link
              href="/signup"
              className="font-medium text-[var(--ink)] underline underline-offset-4 hover:text-[var(--hot)]"
            >
              Register it
            </Link>
          </p>
        </>
      ) : (
        <>
          <h1 className="display text-[clamp(2rem,4vw,2.6rem)]">Enter the code</h1>
          <p className="muted mt-3 text-[15px] leading-relaxed">
            We sent a six digit code to{' '}
            <span className="font-medium text-[var(--ink)]">{phone}</span>.
          </p>

          <div className="mt-9">
            <label
              htmlFor="otp"
              className="mb-2 block text-[13px] font-medium text-[var(--muted)]"
            >
              Code
            </label>
            <input
              id="otp"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              maxLength={6}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && otp.length === 6 && !busy) void verify();
              }}
              placeholder="000000"
              className="auth-field px-4 py-3.5 text-center text-[22px] tracking-[0.5em] tabular-nums"
            />
          </div>

          {devOtp && (
            <p className="muted mt-4 rounded-lg border border-[var(--line)] bg-[var(--sand)]/60 px-3 py-2.5 text-xs leading-relaxed">
              Dev mode: the code is{' '}
              <span className="font-semibold text-[var(--ink)]">{devOtp}</span>. In
              production this arrives by SMS and is never shown here.
            </p>
          )}

          {error}

          <button
            onClick={verify}
            disabled={otp.length !== 6 || busy}
            className="auth-cta mt-7 w-full py-3.5 text-[15px] font-semibold"
          >
            {busy ? 'Checking…' : 'Log in'}
          </button>

          <button
            onClick={() => {
              setStep('phone');
              setOtp('');
              setErr(null);
            }}
            className="muted mt-6 text-sm hover:text-[var(--hot)]"
          >
            &larr; Use a different number
          </button>
        </>
      )}
    </AuthSplit>
  );
}

export default function Login() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
