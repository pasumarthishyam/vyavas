import { LoginForm } from '../../components/login-form';

/**
 * The sign-in page.
 *
 * Deliberately OUTSIDE the `(app)` route group, which is what makes it a
 * full-screen page rather than a card inside the console. The app shell used to
 * live in the root layout, and a root layout is not re-rendered on client-side
 * navigation — so arriving here from a session that had just ended drew this
 * form inside the signed-in sidebar, complete with the account switcher and a
 * Sign out button. Nothing above this file may reintroduce that: see the note
 * in `app/layout.tsx`.
 *
 * Deliberately says nothing about the deployment: no merchant name, no counts,
 * no "no account yet?" link. Accounts are created from a trusted machine with
 * `npx tsx scripts/user.ts create`, never from a browser, so there is nothing
 * here to sign up for and nothing to enumerate.
 */
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  /*
   * Only a same-site path is ever handed back to the client.
   *
   * `next` arrives in the URL, so it is attacker-supplied. Without this check a
   * crafted link would send someone to a real login form and then bounce them
   * to another host that looks like it — the classic open-redirect phish. A
   * value must start with exactly one slash: `//evil.example` is a
   * protocol-relative URL to another origin and is rejected by the second test.
   */
  const safeNext = typeof next === 'string' && /^\/(?!\/)/.test(next) ? next : '/';

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <div className="brand-mark">V</div>
          <div className="login-brand-name">Vyavas</div>
        </div>
        <h1 className="login-title">Sign in</h1>
        <p className="login-sub">This console can message real customers.</p>
        <LoginForm next={safeNext} />
      </div>
      <p className="login-foot">Accounts are issued by an operator. There is no sign-up.</p>
    </div>
  );
}
