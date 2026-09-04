'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The sign-in form.
 *
 * `router.refresh()` before `router.push` is not optional. The root layout is a
 * server component that decides whether to render the app shell or the bare
 * login page, and it was rendered for a signed-OUT user. Navigating without
 * refreshing reuses that cached render and lands the newly signed-in user on a
 * page with no sidebar, which reads as a broken app rather than a successful
 * login.
 */
export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string };

      if (!res.ok || !body.ok) {
        setError(body.reason ?? 'Email or password is incorrect.');
        setBusy(false);
        return;
      }

      router.refresh();
      router.push(next);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setBusy(false);
    }
  }

  return (
    <form className="login-form" onSubmit={submit}>
      <label className="login-label" htmlFor="email">
        Email
      </label>
      <input
        id="email"
        className="login-input"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="username"
        autoFocus
        required
      />

      <label className="login-label" htmlFor="password">
        Password
      </label>
      <input
        id="password"
        className="login-input"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        required
      />

      {/* role=alert so a screen reader announces the failure rather than
          leaving someone waiting on a form that silently did nothing. */}
      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}

      <button className="login-submit" type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
