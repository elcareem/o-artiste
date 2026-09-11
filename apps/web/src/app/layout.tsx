import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Artist Escrow',
  description:
    'Book an artist with your payment held safely until the event has happened.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
