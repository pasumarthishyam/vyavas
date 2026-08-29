import type { Metadata } from 'next';
import './globals.css';
import { Nav } from '../components/nav';
import { MerchantSwitcher } from '../components/merchant-switcher';
import { getDb } from '../db/client';
import { selectMerchant } from '../lib/merchant-context';

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

/**
 * Same reasoning as THEME_BOOT: applied before first paint so a viewer who
 * collapsed the sidebar last time never sees it flash open-then-shut.
 */
const SIDEBAR_BOOT = `
try {
  if (localStorage.getItem('vyavas-sidebar') === 'collapsed') {
    document.documentElement.dataset.sidebar = 'collapsed';
  }
} catch (e) {}
`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolved here rather than per page: the switcher is part of the shell, and
  // every page under it must agree about which account is being looked at.
  // Tolerant of a database that is not reachable yet — the shell still renders
  // so a misconfigured deployment shows its own error page rather than a blank.
  let selection = null;
  try {
    selection = await selectMerchant(getDb());
  } catch {
    selection = null;
  }

  return (
    <html lang="en-IN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_BOOT }} />
      </head>
      <body>
        <div className="shell">
          <Nav
            switcher={
              selection ? (
                <MerchantSwitcher current={selection.current} all={selection.all} />
              ) : null
            }
          />
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
