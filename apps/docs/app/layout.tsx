import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'HandStack Documentation',
  description: 'Build, govern, and expose AI capabilities.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="header">
          <Link className="brand" href="/">
            HandStack Docs
          </Link>
          <a href="https://github.com/handstack/handstack">GitHub</a>
        </header>
        {children}
      </body>
    </html>
  );
}
