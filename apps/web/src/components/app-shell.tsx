import Link from "next/link";

const primaryNav = [
  { href: "/dashboard", label: "Dashboard", mobileLabel: "Dashboard" },
  { href: "/applications", label: "Talent", mobileLabel: "Talent" },
  { href: "/competition", label: "Competition", mobileLabel: "Compete" },
  { href: "/studio", label: "Studio", mobileLabel: "Studio" },
  { href: "/security", label: "Security", mobileLabel: "Security" },
] as const;

export function AppShell({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <Link className="brand-mark" href="/dashboard">
          <span className="brand-dot" aria-hidden="true" />
          <span>Org OS</span>
        </Link>
        <nav>
          <ul className="nav-list">
            {primaryNav.map((item) => (
              <li key={item.href}>
                <Link className="nav-link" href={item.href}>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      <div className="main-area">
        <main id="main-content" className="page-wrap">
          {children}
        </main>
      </div>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {primaryNav.map((item) => (
          <Link key={item.href} href={item.href} aria-label={item.label}>
            {item.mobileLabel}
          </Link>
        ))}
      </nav>
    </div>
  );
}
