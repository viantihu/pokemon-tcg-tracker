"use client";

/**
 * The app-shell top bar: brand + primary nav (design/prototype.html · `.topbar`). One tab per
 * route group in the `(ui)` shell (dev-spec §2). Only HAUL PLAN is built in M6; the rest are stubs
 * that later phases fill (M5 backfill, M7 lines, M8 lookup/collections/binders/settings, M9 sync).
 * The active tab is derived from the pathname.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/plan", label: "Haul Plan", n: "1" },
  { href: "/look", label: "Lookup", n: "2" },
  { href: "/line", label: "Lines", n: "3" },
  { href: "/coll", label: "Collections", n: "4" },
  { href: "/backfill", label: "Backfill", n: "5" },
  { href: "/sync", label: "Sync", n: "6" },
  { href: "/binders", label: "Binders", n: "7" },
  { href: "/settings", label: "Settings", n: "8" },
] as const;

export function TopBar() {
  const pathname = usePathname();
  return (
    <div className="topbar">
      <div className="brand">
        <span className="mark" />
        <div>
          <b>BINDER OPS</b>
          <br />
          <span>SORT · ROUTE · HUNT</span>
        </div>
      </div>
      <nav className="menu" aria-label="Primary">
        {TABS.map((t) => {
          const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={"tab u" + (active ? " on" : "")}
              aria-current={active ? "page" : undefined}
            >
              <span className="n">{t.n}</span> {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
