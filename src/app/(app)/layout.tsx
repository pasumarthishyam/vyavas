import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

import { Nav } from '../../components/nav';
import { MerchantSwitcher } from '../../components/merchant-switcher';
import { getDb } from '../../db/client';
import { currentUser } from '../../lib/auth';
import { selectMerchant } from '../../lib/merchant-context';

/**
 * Everything behind the sign-in, and the only place the shell is drawn.
 *
 * `(app)` is a route group: it groups these pages under one layout without
 * appearing in any URL. `/`, `/cases`, `/recovery` and `/agents/*` are exactly
 * where they were. What it buys is a boundary — the login page lives OUTSIDE
 * this group, so navigating to it unmounts this layout entirely rather than
 * leaving signed-in chrome around a sign-in form. See `app/layout.tsx`.
 *
 * ── this redirect is a real gate, not a formality ──
 *
 * The middleware checks the cookie's signature on the Edge, where there is no
 * database. It cannot know that the user was deleted, disabled, or that their
 * password changed and every token issued before it is void. `currentUser` does
 * know — it re-reads the row and compares the session epoch — and a page must
 * not render for someone it returns null for. Before this, a null user fell
 * through to `children` with no shell around it, which rendered the page's own
 * "No merchant connected" empty state: a signed-out visitor seeing an app
 * screen that merely looked broken, rather than a login form.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let user = null;
  let selection = null;

  try {
    const db = getDb();
    user = await currentUser(db);
    if (user) selection = await selectMerchant(db);
  } catch {
    // A database that cannot be reached cannot confirm anyone. Failing closed
    // sends them to the login page, which needs no database to render.
    user = null;
    selection = null;
  }

  if (!user) {
    // Come back to where they were headed once they sign in. The path arrives
    // in a header the middleware sets; it is re-validated as a same-site path
    // by the login page before it is ever used, so a hostile value cannot turn
    // this into an open redirect.
    const path = (await headers()).get('x-vyavas-pathname');
    redirect(path && path !== '/' ? `/login?next=${encodeURIComponent(path)}` : '/login');
  }

  return (
    <div className="shell">
      <Nav
        user={{ email: user.email, name: user.name }}
        switcher={
          selection ? <MerchantSwitcher current={selection.current} all={selection.all} /> : null
        }
      />
      <main className="main">{children}</main>
    </div>
  );
}
