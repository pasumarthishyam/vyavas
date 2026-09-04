import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Vyavas — Revenue at Risk',
  description: 'Detect revenue at risk, diagnose the cause, recover it.',
};

/**
 * The document, and nothing else.
 *
 * ── why the shell is not here any more ──
 *
 * It used to be: this layout read `currentUser`, and rendered either the app
 * shell or the bare page depending on the answer. That is correct on a full page
 * load and wrong on every client-side navigation, because Next.js does NOT
 * re-render a shared layout when you navigate within it — it keeps the layout
 * mounted and swaps only the segment below. So a session that ended mid-visit
 * (a password change bumps the epoch and invalidates every token) redirected to
 * `/login` and drew the login card INSIDE the signed-in chrome: sidebar, account
 * switcher, the user's own name, and a Sign out button, all rendered for someone
 * the server had just refused. It looked like a broken page; it was really a
 * layout that had cached the answer to "who is here".
 *
 * The fix is structural, not a `refresh()` call at the right moment. The shell
 * now lives in the `(app)` route group's layout and the login page sits outside
 * it, so crossing between them unmounts the chrome — there is no state left to
 * be stale. Route groups do not appear in the URL, so every path is unchanged.
 *
 * Nothing auth-dependent may be added back to this file.
 */

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
