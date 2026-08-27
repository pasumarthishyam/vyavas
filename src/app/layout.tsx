import type { Metadata } from 'next';
import './globals.css';
import { Nav } from '../components/nav';

export const metadata: Metadata = {
  title: 'Vyavas — Revenue at Risk',
  description: 'Detect revenue at risk, diagnose the cause, recover it.',
};

/**
 * Applied before first paint so a dark-mode viewer never sees a white flash.
 * Wrapped in try/catch because localStorage throws outright in some contexts
 * (private windows, blocked site data) rather than merely returning null.
 */
const THEME_BOOT = `
try {
  var t = localStorage.getItem('vyavas-theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <div className="shell">
          <Nav />
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
