'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { get, post, type Me } from '@/lib/api';

const NAV = [
  { href: '/dashboard', label: 'Catalogue' },
  { href: '/dashboard/bills', label: 'Bill upload' },
  { href: '/dashboard/orders', label: 'Orders' },
  { href: '/dashboard/connect', label: 'WhatsApp' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    get<Me>('/auth/me')
      .then(setMe)
      .catch(() => router.replace('/login'))
      .finally(() => setChecked(true));
  }, [router]);

  if (!checked) return <div className="muted p-8 text-sm">Loading...</div>;
  if (!me) return null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--line)] pb-4">
        <div>
          <Link href="/" className="muted text-xs tracking-widest uppercase">Nukkad</Link>
          <p className="font-medium">{me.shopName}</p>
        </div>
        <nav className="flex flex-wrap items-center gap-5 text-sm">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href}
              className={path === n.href ? 'text-[var(--accent)]' : 'hover:text-[var(--accent)]'}>
              {n.label}
            </Link>
          ))}
          <button
            onClick={async () => { await post('/auth/logout'); router.replace('/login'); }}
            className="muted hover:text-[var(--warn)]">
            Logout
          </button>
        </nav>
      </header>

      <div className="muted mt-3 flex gap-5 text-xs">
        <span>{me.counts.skus} items</span>
        <span>{me.counts.households} ghar</span>
        <span>{me.counts.orders} orders</span>
      </div>

      <div className="pt-8">{children}</div>
    </div>
  );
}
