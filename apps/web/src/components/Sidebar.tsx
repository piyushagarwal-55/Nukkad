'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { post } from '@/lib/api';
import { VoiceMark } from './VoiceMark';

/* ---------------------------------------------------------------------
   Collapsed rail that widens on hover, pinned open or shut by a toggle.

   The rail keeps its 76px of layout width while the <aside> inside it
   grows to 236px absolutely. That way hovering does not reflow the page
   under the cursor -- the panel floats over the content instead of
   shoving it sideways.
   --------------------------------------------------------------------- */

const PINNED_KEY = 'nukkad.rail.pinned';

interface RailCtx {
  pinned: boolean;
  toggle: () => void;
}
const Ctx = createContext<RailCtx>({ pinned: false, toggle: () => {} });
export const useRail = () => useContext(Ctx);

export function RailProvider({ children }: { children: React.ReactNode }) {
  const [pinned, setPinned] = useState(false);

  /* Read on mount rather than in useState's initialiser: this component
     is server-rendered first, localStorage does not exist there, and
     seeding state from it would mismatch on hydration. */
  useEffect(() => {
    try {
      setPinned(localStorage.getItem(PINNED_KEY) === '1');
    } catch {
      /* private mode, or site data blocked. The default is fine. */
    }
  }, []);

  function toggle() {
    setPinned((p) => {
      const next = !p;
      try {
        localStorage.setItem(PINNED_KEY, next ? '1' : '0');
      } catch {
        /* nothing to do; it just will not persist */
      }
      return next;
    });
  }

  return <Ctx.Provider value={{ pinned, toggle }}>{children}</Ctx.Provider>;
}

/* ---- icons. Drawn here rather than pulled from a font so the rail has
   no network dependency and the stroke weight matches the site. ---- */
const ICON = {
  overview: 'M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm9 0h7v-9h-7v9Zm0-16v5h7V4h-7Z',
  catalogue: 'M4 6h16M4 12h16M4 18h10',
  bill: 'M7 3h10a1 1 0 0 1 1 1v17l-3-2-3 2-3-2-3 2V4a1 1 0 0 1 1-1Zm2 5h6M9 12h6',
  orders: 'M6 2h9l4 4v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm8 0v5h5M9 13h6M9 17h4',
  whatsapp: 'M12 3a9 9 0 0 0-7.7 13.7L3 21l4.4-1.2A9 9 0 1 0 12 3Z',
  voice: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Zm7 9a7 7 0 0 1-14 0m7 7v3',
  insights: 'M4 20V11m5.5 9V4m5.5 16v-6m5 6V8',
  customers: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-6 9a6 6 0 0 1 12 0M17 8a3 3 0 1 0-2-5.2M15 14a5 5 0 0 1 6 5',
  inventory: 'M4 8l8-4 8 4v9l-8 4-8-4V8Zm8 4 8-4M12 12 4 8m8 4v9',
  procurement: 'M6 7h12l2 5v6h-2a2 2 0 0 1-4 0h-4a2 2 0 0 1-4 0H4V9a2 2 0 0 1 2-2Zm12 0v5h2M7 18a2 2 0 1 0 0 .1M16 18a2 2 0 1 0 0 .1M8 4h7',
  workforce: 'M12 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 0v3m-6 3a3 3 0 1 0 0 6m0-6a3 3 0 0 1 0 6m0-6h12m0 0a3 3 0 1 1 0 6m0-6a3 3 0 0 0 0 6',
  evidence: 'M12 3 5 6v5c0 4.5 2.7 8.2 7 10 4.3-1.8 7-5.5 7-10V6l-7-3Zm-3 9 2 2 4-5',
} as const;

const NAV = [
  { href: '/dashboard', label: 'Overview', icon: ICON.overview, fill: true },
  { href: '/dashboard/catalogue', label: 'Catalogue', icon: ICON.catalogue, fill: false },
  { href: '/dashboard/bills', label: 'Bill upload', icon: ICON.bill, fill: false },
  { href: '/dashboard/orders', label: 'Orders', icon: ICON.orders, fill: false },
  { href: '/dashboard/connect', label: 'WhatsApp', icon: ICON.whatsapp, fill: false },
  { href: '/dashboard/voice', label: 'Voice', icon: ICON.voice, fill: false },
  { href: '/dashboard/insights', label: 'Insights', icon: ICON.insights, fill: false },
  { href: '/dashboard/customers', label: 'Customers', icon: ICON.customers, fill: false },
  { href: '/dashboard/inventory', label: 'Inventory', icon: ICON.inventory, fill: false },
  { href: '/dashboard/procurement', label: 'Procurement', icon: ICON.procurement, fill: false },
  { href: '/dashboard/workforce', label: 'AI Workforce', icon: ICON.workforce, fill: false },
  { href: '/dashboard/evidence', label: 'Evidence', icon: ICON.evidence, fill: false },
];

export function Sidebar({ shopName }: { shopName: string }) {
  const path = usePathname();
  const router = useRouter();
  const { pinned, toggle } = useRail();
  const [hover, setHover] = useState(false);
  const open = pinned || hover;

  async function logout() {
    await post('/auth/logout');
    router.replace('/login');
  }

  return (
    <div
      className={`relative z-40 hidden shrink-0 transition-[width] duration-300 md:block ${
        pinned ? 'w-[236px]' : 'w-[76px]'
      }`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <aside
        className={`rail fixed top-0 bottom-0 left-0 z-40 flex flex-col overflow-hidden transition-[width] duration-300 ${
          open ? 'w-[236px]' : 'w-[76px]'
        } ${hover && !pinned ? 'shadow-[6px_0_28px_-10px_#1a1a1a59]' : ''}`}
      >
        {/* brand */}
        <Link href="/" className="flex h-[72px] shrink-0 items-center gap-3 px-[22px]">
          <VoiceMark className="h-[18px] w-auto shrink-0" />
          <span
            data-shown={open}
            className="rail-label display text-xl whitespace-nowrap"
          >
            Nukkad
          </span>
        </Link>

        <nav className="flex-1 space-y-1.5 px-3">
          {NAV.map((n) => {
            // exact match for the index, prefix match for the rest, so
            // /dashboard does not light up on every child route
            const active =
              n.href === '/dashboard' ? path === n.href : path.startsWith(n.href);

            return (
              <Link
                key={n.href}
                href={n.href}
                data-active={active}
                title={open ? undefined : n.label}
                className="rail-item flex items-center gap-3.5 px-[13px] py-2.5"
              >
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden
                  className="h-[22px] w-[22px] shrink-0"
                  fill={n.fill ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  strokeWidth={n.fill ? 0 : 1.9}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={n.icon} />
                </svg>
                <span
                  data-shown={open}
                  className="rail-label text-sm font-medium whitespace-nowrap"
                >
                  {n.label}
                </span>
              </Link>
            );
          })}
        </nav>

        {/* shop identity and the pin, at the foot */}
        <div className="shrink-0 border-t-2 border-[var(--ink)]/12 px-3 py-3">
          <div className="flex items-center gap-3.5 px-[13px] py-1.5">
            <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-[var(--green)] text-[10px] font-bold text-[var(--panel)]">
              {shopName.slice(0, 1).toUpperCase()}
            </span>
            <span
              data-shown={open}
              className="rail-label truncate text-xs font-medium"
              title={shopName}
            >
              {shopName}
            </span>
          </div>

          {/* Log out lives here rather than in a page header, so no route
              has to carry chrome of its own. */}
          <button
            onClick={logout}
            title={open ? undefined : 'Log out'}
            className="rail-item mt-1 flex w-full items-center gap-3.5 px-[13px] py-2.5 hover:!bg-[var(--hot)] hover:text-[var(--bg)]"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden
              className="h-[22px] w-[22px] shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M15 17v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v2M10 12h10m0 0-3-3m3 3-3 3" />
            </svg>
            <span data-shown={open} className="rail-label text-sm whitespace-nowrap">
              Log out
            </span>
          </button>

          <button
            onClick={toggle}
            title={pinned ? 'Unpin the menu' : 'Keep the menu open'}
            aria-pressed={pinned}
            className="rail-item flex w-full items-center gap-3.5 px-[13px] py-2.5"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden
              className={`h-[22px] w-[22px] shrink-0 transition-transform duration-300 ${
                pinned ? 'rotate-180' : ''
              }`}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M13 6l6 6-6 6M5 6l6 6-6 6" />
            </svg>
            <span data-shown={open} className="rail-label text-sm whitespace-nowrap">
              {pinned ? 'Unpin' : 'Keep open'}
            </span>
          </button>
        </div>
      </aside>
    </div>
  );
}

/**
 * The rail is md-and-up only. Below that it becomes a row of tabs across
 * the top, because a 76px rail on a phone eats a fifth of the screen for
 * five icons.
 */
export function MobileNav() {
  const path = usePathname();
  const router = useRouter();

  return (
    <nav className="-mx-6 mb-8 flex items-center gap-1 overflow-x-auto border-b-2 border-[var(--ink)] px-6 pb-3 md:hidden">
      {NAV.map((n) => {
        const active = n.href === '/dashboard' ? path === n.href : path.startsWith(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            data-active={active}
            className="rail-item shrink-0 px-3 py-2 text-sm font-medium whitespace-nowrap"
          >
            {n.label}
          </Link>
        );
      })}

      {/* the rail is hidden at this width, so logout needs a home here too */}
      <button
        onClick={async () => {
          await post('/auth/logout');
          router.replace('/login');
        }}
        className="rail-item muted ml-auto shrink-0 px-3 py-2 text-sm whitespace-nowrap"
      >
        Log out
      </button>
    </nav>
  );
}
