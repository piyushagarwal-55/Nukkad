import type { Metadata } from 'next';
import { EB_Garamond, Figtree } from 'next/font/google';
import './globals.css';

/**
 * Serif display over sans body. The serif at weight 400, set tight, is the
 * entire premium signal. Loaded through next/font so there is no flash of
 * fallback text on first paint.
 */
const garamond = EB_Garamond({
  subsets: ['latin'],
  weight: ['400', '500'],
  // Real italics, not a synthesized oblique. The roman/italic contrast in
  // the headline is doing a lot of the work, and a faked slant looks it.
  style: ['normal', 'italic'],
  variable: '--font-garamond',
  display: 'swap',
});

const figtree = Figtree({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-figtree',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Nukkad | Your shop’s own ordering agent',
  description:
    'Household staples are the most predictable demand in Indian retail. Nukkad predicts them, takes the order by voice on WhatsApp, and settles it on the ledger.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${garamond.variable} ${figtree.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
