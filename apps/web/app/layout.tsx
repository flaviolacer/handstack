import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { HelpOfflineRegistration } from './help/help-offline-registration';

export const metadata: Metadata = { title: 'HandStack', description: 'Governed AI capabilities' };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <HelpOfflineRegistration />
        {children}
      </body>
    </html>
  );
}
