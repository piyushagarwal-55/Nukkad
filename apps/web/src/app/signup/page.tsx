'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { post } from '@/lib/api';

export default function Signup() {
  const [shopName, setShop] = useState('');
  const [ownerName, setOwner] = useState('');
  const [phone, setPhone] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const ready = shopName.length > 1 && ownerName.length > 1 && phone.replace(/\D/g, '').length >= 10;

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await post('/auth/signup', { shopName, ownerName, phone });
      router.push(`/login?phone=${encodeURIComponent(phone)}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <p className="muted text-sm tracking-widest uppercase">Nukkad</p>
      <h1 className="mt-3 text-2xl font-semibold">Dukaan register kijiye</h1>
      <p className="muted mt-2 text-sm">Do minute. Koi password nahi.</p>

      <label className="muted mt-8 block text-sm">Dukaan ka naam</label>
      <input value={shopName} onChange={(e) => setShop(e.target.value)}
        placeholder="Sunita Kirana Store"
        className="panel mt-2 w-full px-4 py-3 outline-none" />

      <label className="muted mt-4 block text-sm">Aapka naam</label>
      <input value={ownerName} onChange={(e) => setOwner(e.target.value)}
        placeholder="Sunita Devi"
        className="panel mt-2 w-full px-4 py-3 outline-none" />

      <label className="muted mt-4 block text-sm">Mobile number</label>
      <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="numeric"
        placeholder="98765 43210"
        className="panel mt-2 w-full px-4 py-3 outline-none" />

      {err && <p className="mt-4 text-sm text-[var(--warn)]">{err}</p>}

      <button onClick={submit} disabled={!ready || busy}
        className="mt-6 rounded-lg bg-[var(--accent)] px-5 py-3 font-medium text-black disabled:opacity-40">
        {busy ? 'Rukiye...' : 'Register karein'}
      </button>

      <Link href="/login" className="muted mt-4 text-sm hover:text-[var(--accent)]">
        Pehle se account hai? Login
      </Link>
    </main>
  );
}
