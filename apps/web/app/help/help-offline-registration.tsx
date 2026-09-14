'use client';

import { useEffect } from 'react';

export function HelpOfflineRegistration() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/handstack-help-sw.js', { scope: '/help' });
    }
  }, []);
  return null;
}
