import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Nukkad | Your shop’s own ordering agent',
  description:
    'Household staples are the most predictable demand in Indian retail. Nukkad predicts them, takes the order by voice on WhatsApp, and settles it on the ledger.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
