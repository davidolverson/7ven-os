"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const primaryNav = [
  { href: "/dashboard", label: "Dashboard", mobileLabel: "Dashboard" },
  { href: "/applications", label: "Talent", mobileLabel: "Talent" },
  { href: "/competition", label: "Competition", mobileLabel: "Compete" },
  { href: "/studio", label: "Studio", mobileLabel: "Studio" },
  { href: "/security", label: "Security", mobileLabel: "Security" },
] as const;

function routeIsActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <Link className="brand-mark" href="/dashboard">
          <span className="brand-dot" aria-hidden="true" />
          <span>Org OS</span>
        </Link>
        <nav>
          <ul className="nav-list">
            {primaryNav.map((item) => {
              const active = routeIsActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link className="nav-link" href={item.href} aria-current={active ? "page" : undefined}>
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>

      <div className="main-area">
        <main id="main-content" className="page-wrap">
          {children}
        </main>
      </div>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {primaryNav.map((item) => {
          const active = routeIsActive(pathname, item.href);
          return (
            <Link key={item.href} href={item.href} aria-label={item.label} aria-current={active ? "page" : undefined}>
              {item.mobileLabel}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
