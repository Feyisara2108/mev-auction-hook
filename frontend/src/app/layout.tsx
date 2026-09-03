import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/providers";
import { Nav } from "@/components/Nav";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: "Governed MEV Auction Hook — Uniswap v4",
  description:
    "A Uniswap v4 hook that auctions execution rights for large swaps on-chain and lets each pool's LPs vote, weighted by their liquidity, on how the winning bid is split between an LP donation and a trader rebate.",
};

// Runs before React hydrates — prevents theme flash on load
const themeScript = `
  try {
    var saved = localStorage.getItem('mev-theme');
    var preferred = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', saved || preferred);
  } catch (e) {}
`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: themeScript stamps data-theme on <html> before
    // React hydrates, so the client attribute intentionally differs from the SSR output.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrains.variable} h-full`}
    >
      <head>
        <script id="theme-init" dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="flex min-h-full flex-col bg-(--color-bg)">
        <Providers>
          <Nav />
          <main className="flex-1 w-full overflow-x-hidden">{children}</main>
          <footer className="border-t border-(--color-border) py-4 px-4 mt-8">
            <div className="mx-auto max-w-5xl flex flex-wrap items-center justify-between gap-2 text-xs text-(--color-muted)">
              <span>
                Governed MEV Auction Hook · built for the Atrium Academy UHI10
                Hookathon · unaudited, testnet only
              </span>
              <nav className="flex items-center gap-4">
                <a
                  href="https://github.com/Feyisara2108/mev-auction-hook"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-(--color-subtext) transition-colors"
                >
                  GitHub
                </a>
                <a
                  href="https://docs.uniswap.org/contracts/v4/overview"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-(--color-subtext) transition-colors"
                >
                  Uniswap v4
                </a>
              </nav>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
