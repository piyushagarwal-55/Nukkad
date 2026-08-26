'use client';

import { useEffect, useState } from 'react';
import { API, get } from '@/lib/api';

interface Connect {
  counterQrUrl: string;
  joinLink: string;
  joinCode: string;
  sandboxNumber: string;
  whatsappNumber: string | null;
  wabaStatus: string;
}

/**
 * Two blocks, deliberately separated, because they are two different QRs for
 * two different people and conflating them is the easiest mistake to make
 * here.
 *
 * TOP: the counter QR. Customers scan it to reach this shop's ordering line.
 * Live today, and unchanged in production except for the number behind it.
 *
 * BOTTOM: connecting the shop's OWN number. That is Meta Coexistence, which
 * needs a Meta Business Account and Meta-side eligibility. Not a ten-day
 * item, so it reads PENDING and says why.
 */
export default function Connect() {
  const [c, setC] = useState<Connect | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    get<Connect>('/shop/connect').then(setC).catch((e) => setErr(e.message));
  }, []);

  if (err) return <p className="text-[var(--warn)]">{err}</p>;
  if (!c) return <p className="muted text-sm">Loading...</p>;

  return (
    <>
      <h1 className="text-2xl font-semibold">WhatsApp</h1>
      <p className="muted mt-1 text-sm">
        Aapki dukaan ka ordering line. Do cheezein, dono alag.
      </p>

      {/* ---------------- customer side, live ---------------- */}
      <div className="panel mt-6 p-6">
        <div className="flex flex-wrap items-start gap-8">
          <div className="rounded-lg bg-white p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${API}${c.counterQrUrl}`} alt="counter QR" width={190} height={190} />
          </div>

          <div className="min-w-[260px] flex-1">
            <h2 className="font-medium">Counter ka QR</h2>
            <p className="muted mt-2 text-sm leading-relaxed">
              Ise print karke counter par laga dijiye. Customer scan karega,
              ek baar jud jayega, aur uske baad seedha WhatsApp par order kar
              sakega.
            </p>
            <p className="muted mt-3 text-sm leading-relaxed">
              UPI ka QR to already laga hai. Ye doosra hai. Wo paisa leta hai,
              ye order leta hai.
            </p>

            <div className="mt-4 flex flex-wrap gap-3">
              <a href={`${API}${c.counterQrUrl}`} target="_blank" rel="noreferrer"
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-black">
                QR kholein
              </a>
              <button onClick={() => window.print()}
                className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm">
                Print
              </button>
            </div>

            <p className="muted mt-4 text-xs">
              Ya customer <b className="text-[var(--ink)]">{c.joinCode}</b> likhkar{' '}
              <b className="text-[var(--ink)]">{c.sandboxNumber}</b> par bhej de.
            </p>
          </div>
        </div>
      </div>

      {/* ---------------- shop side, pending ---------------- */}
      <div className="panel mt-5 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">Aapka apna WhatsApp number</h2>
          <span className={
            'rounded px-2 py-0.5 text-xs ' +
            (c.wabaStatus === 'CONNECTED'
              ? 'bg-[var(--accent)] text-black'
              : 'border border-[var(--line)] text-[var(--muted)]')
          }>
            {c.wabaStatus}
          </span>
        </div>

        <p className="muted mt-3 text-sm leading-relaxed">
          Abhi orders ek shared demo number par aate hain. Apna number jodne ke
          liye Meta Coexistence lagta hai: aap apne WhatsApp Business app se ek
          QR scan karte hain, aur number app mein chalta rehta hai.
        </p>
        <p className="muted mt-2 text-sm leading-relaxed">
          Iske liye Meta Business Account chahiye, aur Meta khud account ki
          purani aur message quality dekhkar permission deta hai.
        </p>

        <button disabled
          className="mt-4 cursor-not-allowed rounded-lg border border-[var(--line)] px-4 py-2 text-sm opacity-50">
          Apna number jodein
        </button>
      </div>
    </>
  );
}
