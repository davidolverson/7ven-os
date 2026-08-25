import Link from "next/link";

const primaryNav = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/applications", label: "Talent" },
  { href: "/competition", label: "Competition" },
  { href: "/studio", label: "Studio" },
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
          <Link key={item.href} href={item.href}>
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
