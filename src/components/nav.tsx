'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const ITEMS = [
  { href: '/', label: 'Overview', icon: OverviewIcon },
  { href: '/recovery', label: 'Failed Payment Agent', icon: RecoveryIcon },
  { href: '/cases', label: 'Cases', icon: CasesIcon },
  { href: '/agents/discount-caller', label: 'Discount Caller', icon: PhoneIcon },
];

export function Nav({ switcher }: { switcher?: React.ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState<boolean | null>(null);

  useEffect(() => {
    setCollapsed(document.documentElement.dataset.sidebar === 'collapsed');
  }, []);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    document.documentElement.dataset.sidebar = next ? 'collapsed' : '';
    try {
      localStorage.setItem('vyavas-sidebar', next ? 'collapsed' : 'open');
    } catch {
      /* a viewer who blocks storage still gets the toggle for this session */
    }
  }

  // Render the uncollapsed shape until the real state is known, so nothing
  // jumps on hydration — the boot script already set the width for paint.
  const isCollapsed = collapsed === true;

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <div className="brand-mark">V</div>
          <div className="brand-name">Vyavas</div>
        </div>
        <button
          className="collapse-btn"
          onClick={toggle}
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!isCollapsed}
        >
          <HamburgerIcon />
        </button>
      </div>

      {switcher && <div className="sidebar-switcher">{switcher}</div>}

      <nav className="nav">
        {ITEMS.map((item) => {
          // usePathname() can render null on the first pass of a cold, dynamic
          // page — guard rather than crash the whole shell over an active-tab
          // highlight.
          const active = item.href === '/' ? pathname === '/' : (pathname ?? '').startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="nav-item"
              aria-current={active ? 'page' : undefined}
              title={isCollapsed ? item.label : undefined}
            >
              <span className="nav-item-icon">
                <Icon />
              </span>
              <span className="nav-item-label">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-foot">
        <ThemeToggle collapsed={isCollapsed} />
        <div className="sidebar-note">
          Every send is gated, logged and reversible.
        </div>
      </div>
    </aside>
  );
}

function ThemeToggle({ collapsed }: { collapsed: boolean }) {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('vyavas-theme');
      if (stored === 'dark' || stored === 'light') {
        setTheme(stored);
        return;
      }
    } catch {
      /* storage can throw outright, not just return null */
    }
    setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }, []);

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('vyavas-theme', next);
    } catch {
      /* a viewer who blocks storage still gets the toggle for this session */
    }
  }

  // Render nothing until the real theme is known, so the label never flips
  // after hydration.
  if (theme === null) return <div style={{ height: 18 }} />;

  return (
    <button
      onClick={toggle}
      className="theme-toggle"
      title={collapsed ? `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme` : undefined}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      <span className="nav-item-label">{theme === 'dark' ? 'Light' : 'Dark'}</span>
    </button>
  );
}

/* Icons: 1.5px strokes, currentColor, so they sit in the ink scale like text. */

function HamburgerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function OverviewIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 11.5 6 7l3 2.6 5-5.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RecoveryIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.7-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M12.2 1.9v2.4H9.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 2.5h2l1 3-1.5 1.2a8 8 0 0 0 4.3 4.3L10.5 9.5l3 1v2a1 1 0 0 1-1.1 1C7.3 13 3 8.7 2.5 3.6a1 1 0 0 1 1-1.1Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CasesIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.25" y="3.25" width="11.5" height="9.5" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.5 6.5h11" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1v1.5M8 13.5V15M15 8h-1.5M2.5 8H1M12.9 3.1l-1 1M4.1 11.9l-1 1M12.9 12.9l-1-1M4.1 4.1l-1-1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
