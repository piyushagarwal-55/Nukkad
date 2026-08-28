'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { get, rupees } from '@/lib/api';
import { IntelSkeleton } from '@/components/Loading';

/**
 * EVERY CUSTOMER AS A ROW THAT OPENS INTO A PERSON. The list is ranked
 * by lifetime spend because that is the order a shopkeeper actually
 * cares about; the click-through is where the intelligence lives.
 */

interface Row {
  id: string; name: string; phone: string; since: string;
  orders: number; spendPaise: number; avgBasketPaise: number;
  lastOrder: string | null;
}

const ago = (iso: string | null) => {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return d === 0 ? 'aaj' : d === 1 ? 'kal' : `${d} din pehle`;
};

export default function Customers() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    get<{ customers: Row[] }>('/intel/customers')
      .then((r) => setRows(r.customers))
      .catch(() => setErr('Customers load nahi hue.'));
  }, []);

  if (err) return <p className="muted mt-8 text-sm">{err}</p>;
  if (!rows) return <IntelSkeleton />;

  return (
    <>
      <h1 className="display text-[clamp(2rem,4vw,2.75rem)]">Customers</h1>
      <p className="muted mt-2 max-w-xl text-sm leading-relaxed">
        Har customer ka pura record — kharcha, aadat, baat-cheet. Naam pe
        click karke details dekhein.
      </p>

      <section className="pane card-in mt-7 p-6">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-[var(--ink)] text-left text-xs uppercase tracking-wide opacity-60">
                <th className="py-2 pr-4 font-semibold">Customer</th>
                <th className="py-2 pr-4 font-semibold">Phone</th>
                <th className="py-2 pr-4 font-semibold">Orders</th>
                <th className="py-2 pr-4 font-semibold">Kul kharcha</th>
                <th className="py-2 pr-4 font-semibold">Avg basket</th>
                <th className="py-2 font-semibold">Aakhri order</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-[#1a1a1a12]">
                  <td className="py-2.5 pr-4 font-semibold">
                    <Link
                      href={`/dashboard/customers/detail?householdId=${r.id}`}
                      className="underline decoration-[var(--accent)] decoration-2 underline-offset-2"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="py-2.5 pr-4 tabular-nums">{r.phone}</td>
                  <td className="py-2.5 pr-4 tabular-nums">{r.orders}</td>
                  <td className="py-2.5 pr-4 tabular-nums">{rupees(r.spendPaise)}</td>
                  <td className="py-2.5 pr-4 tabular-nums">{rupees(r.avgBasketPaise)}</td>
                  <td className="py-2.5">{ago(r.lastOrder)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
