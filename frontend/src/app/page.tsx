"use client";

import Link from "next/link";
import { formatEther } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { MEV_AUCTION_HOOK_ABI } from "@/lib/abi";
import { HOOK_ADDRESS, TOKEN0_SYMBOL } from "@/lib/constants";

// ─── Stat chip ──────────────────────────────────────────────────────────────
function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs"
      style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface-alt)" }}
    >
      <span style={{ color: "var(--color-eyebrow)" }}>{label}</span>
      <span className="mono-val font-semibold" style={{ color: "var(--color-primary)" }}>{value}</span>
    </div>
  );
}

// ─── How It Works step ──────────────────────────────────────────────────────
function Step({ n, title, body, accent }: { n: number; title: string; body: string; accent: string }) {
  return (
    <div
      className="flex-1 rounded-sm border p-4"
      style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
    >
      <div
        className="mono-val text-xs font-bold mb-3 w-6 h-6 rounded-sm flex items-center justify-center"
        style={{ backgroundColor: accent + "20", color: accent }}
      >
        {String(n).padStart(2, "0")}
      </div>
      <p className="text-xs font-semibold mb-1.5" style={{ color: "var(--color-text)" }}>{title}</p>
      <p className="text-xs leading-relaxed" style={{ color: "var(--color-subtext)" }}>{body}</p>
    </div>
  );
}

export default function HomePage() {
  // ── On-chain reads ────────────────────────────────────────────────────────
  const { data: auctionWindow } = useReadContract({
    address: HOOK_ADDRESS,
    abi: MEV_AUCTION_HOOK_ABI,
    functionName: "auctionWindowBlocks",
  });

  const { data: smallThreshold } = useReadContract({
    address: HOOK_ADDRESS,
    abi: MEV_AUCTION_HOOK_ABI,
    functionName: "smallSwapThreshold",
  });

  const { data: nextRequestId } = useReadContract({
    address: HOOK_ADDRESS,
    abi: MEV_AUCTION_HOOK_ABI,
    functionName: "nextRequestId",
  });

  const swapsExecuted = nextRequestId !== undefined ? Number(nextRequestId) : 0;
  const windowBlocks = auctionWindow !== undefined ? Number(auctionWindow) : 3;
  const thresholdWei = smallThreshold !== undefined ? smallThreshold : BigInt("1000000000000000000");
  const thresholdLabel = `${(Number(thresholdWei) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${TOKEN0_SYMBOL}`;

  // Live LP donations across all auctions
  const auctionIds = Array.from({ length: swapsExecuted }, (_, i) => BigInt(i));
  const { data: auctionResults } = useReadContracts({
    contracts: auctionIds.map((id) => ({
      address: HOOK_ADDRESS,
      abi: MEV_AUCTION_HOOK_ABI,
      functionName: "getRequestInfo" as const,
      args: [id] as const,
    })),
    query: { enabled: swapsExecuted > 0 },
  });

  const totalLpDonated = auctionResults
    ? auctionResults.reduce((sum, r) => {
        const info = r.result as { highestBid: bigint; isCompleted: boolean } | undefined;
        return sum + (info?.isCompleted && info.highestBid > 0n ? info.highestBid : 0n);
      }, 0n)
    : 0n;

  const competitiveAuctions = auctionResults
    ? auctionResults.filter((r) => {
        const info = r.result as { highestBid: bigint; isCompleted: boolean } | undefined;
        return info?.isCompleted && info.highestBid > 0n;
      }).length
    : 0;

  const hookShort = `${HOOK_ADDRESS.slice(0, 6)}…${HOOK_ADDRESS.slice(-4)}`;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">

      {/* ── HERO ─────────────────────────────────────────── */}
      <section className="mb-10 text-center">
        <div
          className="inline-flex items-center gap-1.5 mb-4 px-3 py-1 rounded-full border text-[10px] font-medium uppercase tracking-wider"
          style={{ borderColor: "var(--color-success)", color: "var(--color-success)", backgroundColor: "var(--color-success)" + "10" }}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
          Live · Unichain Sepolia
        </div>

        <h1
          className="text-3xl sm:text-4xl font-bold leading-tight mb-4"
          style={{
            background: "linear-gradient(135deg, var(--color-primary) 0%, var(--color-info) 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}
        >
          MEV Auction Hook
        </h1>

        <p className="text-sm leading-relaxed mb-2 max-w-lg mx-auto" style={{ color: "var(--color-text)" }}>
          A Uniswap v4 hook that turns every large swap into an on-chain auction.
          MEV searchers bid for execution rights. The winning bid goes directly
          to in-range liquidity providers.
        </p>
        <p className="text-xs leading-relaxed mb-6" style={{ color: "var(--color-subtext)" }}>
          When searchers bid for execution rights, that value stays inside the pool as LP revenue instead of leaving it.
        </p>

        {/* Contract address */}
        <div
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-sm border text-[10px] mono-val mb-6"
          style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface-alt)", color: "var(--color-subtext)" }}
        >
          Hook
          <span style={{ color: "var(--color-text)" }}>{hookShort}</span>
          <a
            href={`https://unichain-sepolia.blockscout.com/address/${HOOK_ADDRESS}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--color-primary)" }}
          >
            ↗
          </a>
        </div>

        {/* Live stat chips */}
        <div className="flex flex-wrap justify-center gap-2 mb-8">
          <StatChip label="Swaps processed" value={String(swapsExecuted)} />
          <StatChip label="Auction window" value={`${windowBlocks} blocks (~${windowBlocks}s)`} />
          <StatChip label="Express lane" value={`< ${thresholdLabel}`} />
          <StatChip label="Off-chain infra" value="None" />
        </div>

        {/* CTA */}
        <Link
          href="/swap"
          className="inline-flex items-center gap-2 px-6 py-2.5 rounded-sm text-xs font-semibold text-white transition-opacity hover:opacity-90"
          style={{ background: "linear-gradient(135deg, var(--color-primary) 0%, var(--color-info) 100%)" }}
        >
          Try the Protected Swap →
        </Link>
      </section>

      {/* ── LIVE IMPACT ──────────────────────────────────── */}
      <section className="mb-10">
        <p className="eyebrow mb-2">Live On-Chain Impact</p>
        <div
          className="grid grid-cols-3 divide-x rounded-sm border"
          style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
        >
          <div className="px-4 py-4">
            <p className="eyebrow" style={{ marginBottom: "0.25rem" }}>Swaps Processed</p>
            <p className="mono-val text-2xl font-bold" style={{ color: "var(--color-primary)" }}>
              {swapsExecuted}
            </p>
            <p className="mono-val text-[10px]" style={{ color: "var(--color-eyebrow)" }}>total requests</p>
          </div>
          <div className="px-4 py-4">
            <p className="eyebrow" style={{ marginBottom: "0.25rem" }}>Donated to LPs</p>
            <p className="mono-val text-2xl font-bold" style={{ color: "var(--color-success)" }}>
              {totalLpDonated > 0n ? parseFloat(formatEther(totalLpDonated)).toFixed(4) : "0.0000"}
            </p>
            <p className="mono-val text-[10px]" style={{ color: "var(--color-eyebrow)" }}>{TOKEN0_SYMBOL} from auctions</p>
          </div>
          <div className="px-4 py-4">
            <p className="eyebrow" style={{ marginBottom: "0.25rem" }}>Competitive Auctions</p>
            <p className="mono-val text-2xl font-bold" style={{ color: "var(--color-amber)" }}>
              {competitiveAuctions}
            </p>
            <p className="mono-val text-[10px]" style={{ color: "var(--color-eyebrow)" }}>with winning bids</p>
          </div>
        </div>
      </section>

      {/* ── THE PROBLEM ──────────────────────────────────── */}
      <section className="mb-6">
        <p className="eyebrow mb-2">The Problem</p>
        <div
          className="rounded-sm border p-5"
          style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
        >
          <p className="text-xs leading-relaxed mb-3" style={{ color: "var(--color-text)" }}>
            Every pool has one fee, charged blindly to every trader. But some traders —
            arbitrageurs and MEV bots — extract value that ordinary traders never create.
            A single fee rate cannot separate them.
          </p>
          <p className="text-xs leading-relaxed mb-3" style={{ color: "var(--color-subtext)" }}>
            The value MEV bots extract does not stay in the pool — it leaves entirely.
            Liquidity providers absorb the loss as impermanent loss while bots pocket
            the profit. Empirical data shows the swap fee does not compensate for this
            across most major pools (Milionis et al. 2022; Canidio and Fritsch 2024).
          </p>
          <p className="text-xs leading-relaxed" style={{ color: "var(--color-subtext)" }}>
            A pool has one fee and no way to tell an arbitrageur from a retail trader.
            This hook creates a market for execution rights — MEV that would have been
            extracted is instead auctioned, with the proceeds staying in the pool.
          </p>
        </div>
      </section>

      {/* ── THE SOLUTION ─────────────────────────────────── */}
      <section className="mb-8">
        <p className="eyebrow mb-2">The Solution</p>
        <div
          className="rounded-sm border p-5"
          style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
        >
          <p className="text-xs leading-relaxed mb-3" style={{ color: "var(--color-text)" }}>
            If MEV is going to be extracted anyway, charge for the right to do it.
            Every large swap opens a short auction. MEV searchers compete on-chain
            to execute the trade. The winner executes the swap. The bid goes to
            the liquidity providers bearing the risk.
          </p>
          <p className="text-xs leading-relaxed" style={{ color: "var(--color-subtext)" }}>
            The entire auction — intent submission, bidding, winner determination,
            execution — happens through direct on-chain calls to a single deployed
            contract. No relayer. No oracle. No off-chain service of any kind.
          </p>
        </div>
      </section>

      {/* ── HOW IT WORKS ─────────────────────────────────── */}
      <section className="mb-10">
        <p className="eyebrow mb-3">How It Works</p>
        <div className="flex flex-col sm:flex-row gap-2">
          <Step
            n={1}
            title="Request a swap"
            body={`Submit your trade. Input tokens move into hook custody immediately. Swaps under ${thresholdLabel} skip the auction and execute instantly via the express lane.`}
            accent="var(--color-primary)"
          />
          <Step
            n={2}
            title="Searchers bid"
            body={`A ${windowBlocks}-block bidding window opens. MEV searchers outbid each other for execution rights. No bids? The swap still executes at no extra cost.`}
            accent="var(--color-amber)"
          />
          <Step
            n={3}
            title="Bid donated to LPs"
            body="The winning bid is donated to in-range liquidity providers via poolManager.donate(). You receive your output. MEV recaptured — not extracted."
            accent="var(--color-success)"
          />
        </div>
      </section>

      {/* ── COMPARISON ───────────────────────────────────── */}
      <section className="mb-10">
        <p className="eyebrow mb-3">What Makes This Different</p>
        <div
          className="rounded-sm border overflow-hidden"
          style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
        >
          <table className="w-full text-xs">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border)", backgroundColor: "var(--color-surface-alt)" }}>
                <th className="text-left px-4 py-2.5 eyebrow" style={{ marginBottom: 0 }}>Project</th>
                <th className="text-left px-4 py-2.5 eyebrow" style={{ marginBottom: 0 }}>Mechanism</th>
                <th className="text-left px-4 py-2.5 eyebrow" style={{ marginBottom: 0 }}>Off-chain infra</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["MEV Blocker", "Off-chain RPC relay", "Yes"],
                ["CoW Protocol", "Off-chain solver network", "Yes"],
                ["Flashbots Protect", "Mempool-level", "Yes"],
                ["EigenLayer AVS hooks", "Off-chain AVS operators", "Yes"],
              ].map(([name, mech, infra]) => (
                <tr key={name} style={{ borderBottom: "1px solid var(--color-border)" }}>
                  <td className="px-4 py-2.5 mono-val" style={{ color: "var(--color-subtext)" }}>{name}</td>
                  <td className="px-4 py-2.5" style={{ color: "var(--color-subtext)" }}>{mech}</td>
                  <td className="px-4 py-2.5 mono-val" style={{ color: "var(--color-error)" }}>{infra}</td>
                </tr>
              ))}
              <tr style={{ backgroundColor: "var(--color-primary)" + "08" }}>
                <td className="px-4 py-2.5 mono-val font-semibold" style={{ color: "var(--color-primary)" }}>This hook</td>
                <td className="px-4 py-2.5 font-semibold" style={{ color: "var(--color-text)" }}>Direct on-chain calls</td>
                <td className="px-4 py-2.5 mono-val font-semibold" style={{ color: "var(--color-success)" }}>None</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ── BOTTOM CTA ───────────────────────────────────── */}
      <section className="text-center">
        <Link
          href="/swap"
          className="inline-flex items-center gap-2 px-6 py-2.5 rounded-sm text-xs font-semibold text-white transition-opacity hover:opacity-90"
          style={{ background: "linear-gradient(135deg, var(--color-primary) 0%, var(--color-info) 100%)" }}
        >
          Try the Protected Swap →
        </Link>
        <p className="mt-3 text-[10px]" style={{ color: "var(--color-eyebrow)" }}>
          Live on Unichain Sepolia · No real funds needed · Mock tokens provided
        </p>
      </section>

    </div>
  );
}
