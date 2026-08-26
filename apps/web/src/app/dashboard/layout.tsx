'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { get, type Me } from '@/lib/api';
import { RailProvider, Sidebar, MobileNav } from '@/components/Sidebar';
import { BootSplash } from '@/components/Loading';

/**
 * No page header. The shop name lives at the foot of the rail and the
 * counts are already the three tiles on Overview, so a banner repeating
 * both on every route was chrome for its own sake. Log out moved into the
 * rail with them.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const router = useRouter();

  useEffect(() => {
    get<Me>('/auth/me')
      .then(setMe)
      .catch(() => router.replace('/login'))
      .finally(() => setChecked(true));
  }, [router]);

  if (!checked) return <BootSplash />;
  if (!me) return null;

  return (
    <RailProvider>
      <div className="flex min-h-screen">
        <Sidebar shopName={me.shopName} />

        <div className="min-w-0 flex-1">
          <div className="mx-auto max-w-5xl px-6 py-10">
            <MobileNav />
            {children}
          </div>
        </div>
      </div>
    </RailProvider>
  );
}
