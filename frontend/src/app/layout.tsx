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
  title: "MEV Shield — Protected Swaps on Uniswap v4",
  description:
    "Protect your swaps from MEV with an open auction that returns value to LPs.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrains.variable} h-full`}
    >
      <body className="flex min-h-full flex-col bg-(--color-bg)">
        <Providers>
          <Nav />
          <main className="flex-1">{children}</main>
          <footer className="border-t border-(--color-border) py-4 px-4 mt-8">
            <div className="mx-auto max-w-5xl flex flex-wrap items-center justify-between gap-2 text-xs text-(--color-muted)">
              <span>© 2026 MEV Shield. All rights reserved.</span>
              <nav className="flex items-center gap-4">
                <a href="#" className="hover:text-(--color-subtext) transition-colors">Privacy Policy</a>
                <a href="#" className="hover:text-(--color-subtext) transition-colors">Terms of Service</a>
                <a href="#" className="hover:text-(--color-subtext) transition-colors">Docs</a>
                <a
                  href="https://github.com/Feyisara2108/mev-auction-hook"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-(--color-subtext) transition-colors"
                >
                  Github
                </a>
              </nav>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
