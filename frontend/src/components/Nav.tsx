"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { WalletButton } from "./WalletButton";

const links = [
  { href: "/", label: "Home" },
  { href: "/swap", label: "Swap" },
  { href: "/auctions", label: "Auctions" },
  { href: "/governance", label: "Governance" },
  { href: "/activity", label: "Activity" },
];

function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("mev-theme");
    } catch {
      /* storage blocked — fall back to the OS preference */
    }
    const preferred = window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";

    // globals.css already follows prefers-color-scheme with no JS, so only an
    // explicit saved choice needs to be stamped onto the document.
    if (saved === "light" || saved === "dark") {
      document.documentElement.setAttribute("data-theme", saved);
      setTheme(saved);
    } else {
      setTheme(preferred);
    }
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("mev-theme", next);
    } catch {
      /* storage blocked — the choice just won't persist */
    }
  }

  return (
    <button
      onClick={toggle}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className="flex items-center justify-center w-7 h-7 rounded-sm border transition-colors"
      style={{
        borderColor: "var(--color-border)",
        backgroundColor: "var(--color-surface-alt)",
        color: "var(--color-subtext)",
      }}
    >
      {theme === "dark" ? (
        /* Sun icon */
        <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M12.95 3.05l-1.06 1.06M4.11 11.89l-1.06 1.06" />
        </svg>
      ) : (
        /* Moon icon */
        <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13.5 9A6 6 0 0 1 7 2.5a6 6 0 1 0 6.5 6.5z" />
        </svg>
      )}
    </button>
  );
}

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
          className="group shrink-0 mr-4 sm:mr-6 flex items-center gap-2"
        >
          <span
            className="inline-block h-4 w-4 rounded-[3px]"
            style={{
              background:
                "linear-gradient(135deg, var(--color-primary) 0%, var(--color-info) 100%)",
            }}
          />
          <span
            className="text-xs font-semibold tracking-wide"
            style={{ color: "var(--color-text)" }}
          >
            Governed MEV Auction
          </span>
        </Link>

        {/* Page tabs */}
        <nav className="flex items-stretch flex-1 h-full">
          {links.map(({ href, label }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className="relative flex items-center px-2 sm:px-3 h-full text-xs font-medium transition-colors"
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

        {/* Right: theme toggle + wallet */}
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
