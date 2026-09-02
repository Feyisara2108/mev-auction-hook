"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletButton } from "./WalletButton";

const links = [
  { href: "/", label: "Swap" },
  { href: "/auctions", label: "Auctions" },
  { href: "/activity", label: "Activity" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header
      className="sticky top-0 z-40 border-b"
      style={{
        backgroundColor: "var(--color-bg)",
        borderColor: "var(--color-border)",
      }}
    >
      <div className="mx-auto flex max-w-5xl items-center px-4 h-11 gap-0">
        {/* Wordmark */}
        <Link
          href="/"
          className="shrink-0 mr-6 text-xs font-semibold tracking-widest uppercase"
          style={{ color: "var(--color-subtext)" }}
        >
          MEV Shield
        </Link>

        {/* Page tabs */}
        <nav className="flex items-stretch flex-1 h-full">
          {links.map(({ href, label }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className="relative flex items-center px-3 h-full text-xs font-medium transition-colors"
                style={{
                  color: active ? "var(--color-text)" : "var(--color-subtext)",
                }}
                onMouseEnter={(e) => {
                  if (!active)
                    (e.currentTarget as HTMLAnchorElement).style.color =
                      "var(--color-text)";
                }}
                onMouseLeave={(e) => {
                  if (!active)
                    (e.currentTarget as HTMLAnchorElement).style.color =
                      "var(--color-subtext)";
                }}
              >
                {label}
                {active && (
                  <span
                    className="absolute bottom-0 left-0 right-0 h-px"
                    style={{ backgroundColor: "var(--color-primary)" }}
                  />
                )}
              </Link>
            );
          })}
        </nav>

        {/* Right: wallet pills */}
        <div className="ml-auto">
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
