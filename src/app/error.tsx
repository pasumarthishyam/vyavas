'use client';

import { useEffect, useState } from 'react';

/**
 * The last line of defence for a server-side exception.
 *
 * Without this file, a throw anywhere in a server component reaches the user as
 * Next's default: a bare white page reading "Application error: a server-side
 * exception has occurred" and a digest number. That message is technically
 * accurate and completely useless — it does not say what broke, whether it will
 * recover, or what to do, and it replaces the entire UI rather than the part
 * that failed.
 *
 * It mattered here because the most likely cause is transient. A pooled
 * connection that stops answering throws, the throw takes the page down, and the
 * next request would have worked fine. So the important thing this boundary
 * does is not the styling — it is offering a retry, and auto-retrying once,
 * because for the failure this app actually has, trying again IS the fix.
 */
export default function RecoveryError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [retrying, setRetrying] = useState(false);

  // One automatic retry, shortly after mount. A wedged connection is discarded
  // the moment it times out, so the next attempt builds a fresh one — the
  // overwhelmingly common case is that this simply works and the person never
  // has to read any of this.
  useEffect(() => {
    const id = setTimeout(() => {
      setRetrying(true);
      reset();
    }, 1500);
    return () => clearTimeout(id);
  }, [reset]);

  return (
    <div className="boundary">
      <div className="boundary-card">
        <div className="boundary-icon" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
            <path d="M8 5.2v3.4M8 11.2h.01" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </div>

        <h1>This page could not load</h1>
        <p>
          Most often this is the database connection going stale between requests. The stale one
          is dropped automatically, so trying again usually works.
        </p>

        <div className="boundary-actions">
          <button type="button" className="btn-primary" onClick={() => { setRetrying(true); reset(); }}>
            {retrying ? 'Retrying…' : 'Try again'}
          </button>
          <a className="btn-ghost" href="/recovery">
            Reload the page
          </a>
        </div>

        {error.digest ? (
          <p className="boundary-meta">
            Reference <span className="mono">{error.digest}</span> — quote this when checking the
            server logs.
          </p>
        ) : null}
      </div>
    </div>
  );
}
