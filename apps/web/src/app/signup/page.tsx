'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { post } from '@/lib/api';
import { AuthSplit } from '@/components/AuthSplit';

const FIELDS = [
  {
    key: 'shopName' as const,
    label: 'Dukaan ka naam',
    placeholder: 'Sunita Kirana Store',
    inputMode: undefined,
  },
  {
    key: 'ownerName' as const,
    label: 'Aapka naam',
    placeholder: 'Sunita Devi',
    inputMode: undefined,
  },
  {
    key: 'phone' as const,
    label: 'Mobile number',
    placeholder: '98765 43210',
    inputMode: 'numeric' as const,
  },
];

export default function Signup() {
  const [form, setForm] = useState({ shopName: '', ownerName: '', phone: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const ready =
    form.shopName.length > 1 &&
    form.ownerName.length > 1 &&
    form.phone.replace(/\D/g, '').length >= 10;

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await post('/auth/signup', form);
      router.push(`/login?phone=${encodeURIComponent(form.phone)}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthSplit>
      <h1 className="display text-[clamp(2rem,4vw,2.6rem)]">
        Dukaan register kijiye
      </h1>
      <p className="muted mt-3 text-[15px] leading-relaxed">
        Do minute lagenge. Koi password nahi, koi app download nahi.
      </p>

      <div className="mt-9 space-y-5">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <label
              htmlFor={f.key}
              className="mb-2 block text-[13px] font-medium text-[var(--muted)]"
            >
              {f.label}
            </label>
            <input
              id={f.key}
              value={form[f.key]}
              inputMode={f.inputMode}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && ready && !busy) void submit();
              }}
              placeholder={f.placeholder}
              className="auth-field px-4 py-3.5 text-[15px]"
            />
          </div>
        ))}
      </div>

      {err && (
        <p className="mt-5 rounded-lg border border-[var(--hot)]/30 bg-[var(--hot)]/8 px-3 py-2.5 text-sm text-[var(--hot)]">
          {err}
        </p>
      )}

      <button
        onClick={submit}
        disabled={!ready || busy}
        className="auth-cta mt-7 w-full py-3.5 text-[15px] font-semibold"
      >
        {busy ? 'Rukiye...' : 'Register karein'}
      </button>

      <p className="muted mt-6 text-sm">
        Pehle se account hai?{' '}
        <Link href="/login" className="font-medium text-[var(--ink)] underline underline-offset-4 hover:text-[var(--hot)]">
          Login
        </Link>
      </p>
    </AuthSplit>
  );
}
