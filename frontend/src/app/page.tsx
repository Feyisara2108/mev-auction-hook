"use client";

import { useState } from "react";
import { parseEther, parseUnits, zeroAddress, maxUint256, formatEther } from "viem";
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { MEV_AUCTION_HOOK_ABI } from "@/lib/abi";
import {
  HOOK_ADDRESS,
  POOL_KEY,
  TOKEN0_SYMBOL,
  TOKEN1_SYMBOL,
} from "@/lib/constants";

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const isNativeAddress = (a: string) => a.toLowerCase() === zeroAddress.toLowerCase();

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

// ─── Data pair ──────────────────────────────────────────────────────────────
function DataPair({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <p className="mono-val text-sm font-medium leading-tight" style={{ color: valueColor ?? "var(--color-text)" }}>
        {value}
      </p>
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────
export default function SwapPage() {
  const { address, isConnected } = useAccount();
  const [amount, setAmount] = useState("");
  const [zeroForOne, setZeroForOne] = useState(true);
  const [swapTxHash, setSwapTxHash] = useState<`0x${string}` | undefined>();
  const [approveTxHash, setApproveTxHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string | undefined>();

  const fromCurrency = zeroForOne ? POOL_KEY.currency0 : POOL_KEY.currency1;
  const fromSymbol = zeroForOne ? TOKEN0_SYMBOL : TOKEN1_SYMBOL;
  const toSymbol = zeroForOne ? TOKEN1_SYMBOL : TOKEN0_SYMBOL;
  const fromIsNative = isNativeAddress(fromCurrency);

  // ── On-chain reads ──────────────────────────────────────────────────────
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

  const { data: bal0, refetch: refetchBal0 } = useReadContract({
    address: POOL_KEY.currency0,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !isNativeAddress(POOL_KEY.currency0) },
  });

  const { data: bal1, refetch: refetchBal1 } = useReadContract({
    address: POOL_KEY.currency1,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !isNativeAddress(POOL_KEY.currency1) },
  });

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: fromCurrency,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, HOOK_ADDRESS] : undefined,
    query: { enabled: !!address && !fromIsNative },
  });

  // ── Write + receipt hooks ───────────────────────────────────────────────
  const { writeContractAsync, isPending } = useWriteContract();

  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } =
    useWaitForTransactionReceipt({ hash: approveTxHash });

  const { isLoading: isSwapConfirming, isSuccess: isSwapSuccess } =
    useWaitForTransactionReceipt({ hash: swapTxHash });

  // Refresh allowance after approval confirms
  if (isApproveSuccess && approveTxHash) {
    void refetchAllowance();
    void refetchBal0();
    void refetchBal1();
  }

  // ── Derived values ──────────────────────────────────────────────────────
  const parsedAmount = (() => {
    try { return fromIsNative ? parseEther(amount || "0") : parseUnits(amount || "0", 18); }
    catch { return 0n; }
  })();

  const windowBlocks = auctionWindow !== undefined ? Number(auctionWindow) : 3;
  const thresholdWei = smallThreshold !== undefined ? smallThreshold : BigInt("1000000000000000000");
  const swapsExecuted = nextRequestId !== undefined ? Number(nextRequestId) : 0;

  // Compute live LP donations by reading all auction results
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

  const isSmall = parsedAmount < thresholdWei && parsedAmount > 0n;
  const needsApproval = !fromIsNative && parsedAmount > 0n && (allowance ?? 0n) < parsedAmount;

  const fmtBal = (v: bigint | undefined) =>
    v !== undefined ? (Number(v) / 1e18).toFixed(4) : "—";
  const fromBal = address ? (zeroForOne ? fmtBal(bal0) : fmtBal(bal1)) : "—";
  const toBal = address ? (zeroForOne ? fmtBal(bal1) : fmtBal(bal0)) : "—";

  const windowLabel = `${windowBlocks} blocks (~${windowBlocks}s)`;
  const thresholdLabel = `${(Number(thresholdWei) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${TOKEN0_SYMBOL}`;

  const swapType = parsedAmount > 0n
    ? isSmall
      ? { label: "Express Lane", color: "var(--color-success)" }
      : { label: "Full Auction", color: "var(--color-amber)" }
    : null;

  const accentBorder = swapType?.color ?? "var(--color-border)";
  const hookShort = `${HOOK_ADDRESS.slice(0, 6)}…${HOOK_ADDRESS.slice(-4)}`;

  // ── Handlers ────────────────────────────────────────────────────────────
  async function handleApprove() {
    setError(undefined);
    setApproveTxHash(undefined);
    try {
      const hash = await writeContractAsync({
        address: fromCurrency,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [HOOK_ADDRESS, maxUint256],
      });
      setApproveTxHash(hash);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.includes("User rejected") ? "Approval rejected." : msg.slice(0, 160));
    }
  }

  async function handleSwap() {
    if (!amount || parsedAmount === 0n) return;
    setError(undefined);
    setSwapTxHash(undefined);
    try {
      const hash = await writeContractAsync({
        address: HOOK_ADDRESS,
        abi: MEV_AUCTION_HOOK_ABI,
        functionName: "requestSwap",
        args: [
          POOL_KEY,
          { zeroForOne, amountSpecified: -parsedAmount, sqrtPriceLimitX96: 0n },
        ],
        value: fromIsNative ? parsedAmount : 0n,
      });
      setSwapTxHash(hash);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.includes("User rejected") ? "Transaction rejected." : msg.slice(0, 160));
    }
  }

  const isLoading = isPending || isApproveConfirming || isSwapConfirming;

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-xl px-4 py-8">

      {/* ── HERO ──────────────────────────────────────────── */}
      <section className="mb-10 text-center">
        {/* Live badge */}
        <div className="inline-flex items-center gap-1.5 mb-4 px-3 py-1 rounded-full border text-[10px] font-medium uppercase tracking-wider"
          style={{ borderColor: "var(--color-success)", color: "var(--color-success)", backgroundColor: "var(--color-success)" + "10" }}>
          <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
          Live · Unichain Sepolia
        </div>

        <h1
          className="text-2xl sm:text-3xl font-bold leading-tight mb-3"
          style={{
            background: "linear-gradient(135deg, var(--color-primary) 0%, var(--color-info) 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}
        >
          MEV Auction Hook
        </h1>

        <p className="text-sm leading-relaxed mb-2" style={{ color: "var(--color-text)" }}>
          A Uniswap v4 hook that intercepts every large swap, runs a short on-chain auction,
          and donates the winning bid directly to in-range liquidity providers.
        </p>
        <p className="text-xs leading-relaxed mb-4" style={{ color: "var(--color-subtext)" }}>
          MEV doesn&apos;t leave the pool. It stays inside as LP revenue.
        </p>

        {/* Contract address */}
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-sm border text-[10px] mono-val mb-6"
          style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface-alt)", color: "var(--color-subtext)" }}>
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

        {/* Live stats */}
        <div className="flex flex-wrap justify-center gap-2">
          <StatChip label="Swaps processed" value={String(swapsExecuted)} />
          <StatChip label="Auction window" value={windowLabel} />
          <StatChip label="Express lane" value={`< ${thresholdLabel}`} />
          <StatChip label="Off-chain infra" value="None" />
        </div>
      </section>

      {/* ── LIVE IMPACT ───────────────────────────────────── */}
      <section className="mb-8">
        <p className="eyebrow mb-2">Live On-Chain Impact</p>
        <div
          className="grid grid-cols-3 divide-x rounded-sm border"
          style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
        >
          <div className="px-4 py-3">
            <p className="eyebrow" style={{ marginBottom: "0.25rem" }}>Swaps Processed</p>
            <p className="mono-val text-2xl font-bold" style={{ color: "var(--color-primary)" }}>
              {swapsExecuted}
            </p>
            <p className="mono-val text-[10px]" style={{ color: "var(--color-eyebrow)" }}>total requests</p>
          </div>
          <div className="px-4 py-3">
            <p className="eyebrow" style={{ marginBottom: "0.25rem" }}>Donated to LPs</p>
            <p className="mono-val text-2xl font-bold" style={{ color: "var(--color-success)" }}>
              {totalLpDonated > 0n
                ? parseFloat(formatEther(totalLpDonated)).toFixed(4)
                : "0.0000"}
            </p>
            <p className="mono-val text-[10px]" style={{ color: "var(--color-eyebrow)" }}>{TOKEN0_SYMBOL} from auctions</p>
          </div>
          <div className="px-4 py-3">
            <p className="eyebrow" style={{ marginBottom: "0.25rem" }}>Competitive Auctions</p>
            <p className="mono-val text-2xl font-bold" style={{ color: "var(--color-amber)" }}>
              {competitiveAuctions}
            </p>
            <p className="mono-val text-[10px]" style={{ color: "var(--color-eyebrow)" }}>with winning bids</p>
          </div>
        </div>
      </section>

      {/* ── THE PROBLEM ───────────────────────────────────── */}
      <section className="mb-8">
        <p className="eyebrow mb-2">The Problem</p>
        <div
          className="rounded-sm border p-4"
          style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
        >
          <p className="text-xs leading-relaxed mb-2" style={{ color: "var(--color-text)" }}>
            Every pool has one fee, charged blindly to every trader. But some traders —
            arbitrageurs and MEV bots — extract value that ordinary traders never create.
            A single fee rate cannot separate them.
          </p>
          <p className="text-xs leading-relaxed" style={{ color: "var(--color-subtext)" }}>
            The value bots extract does not disappear — it leaves the pool entirely.
            Liquidity providers absorb the loss as impermanent loss while the bots pocket
            the profit. The swap fee is supposed to compensate, but research shows it does not.
          </p>
        </div>
      </section>

      {/* ── THE SOLUTION ──────────────────────────────────── */}
      <section className="mb-8">
        <p className="eyebrow mb-2">The Solution</p>
        <div
          className="rounded-sm border p-4"
          style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
        >
          <p className="text-xs leading-relaxed mb-2" style={{ color: "var(--color-text)" }}>
            If MEV is going to be extracted anyway, charge for the right to do it.
            This hook turns every large swap into a micro-auction — MEV searchers compete
            to execute the trade, and the winning bid goes to the liquidity providers
            who are bearing the risk.
          </p>
          <p className="text-xs leading-relaxed" style={{ color: "var(--color-subtext)" }}>
            The entire auction — intent submission, bidding, winner determination, and execution —
            happens through direct on-chain calls. No relayer. No off-chain service. No keeper.
            Just the hook contract.
          </p>
        </div>
      </section>

      {/* ── HOW IT WORKS ──────────────────────────────────── */}
      <section className="mb-8">
        <p className="eyebrow mb-3">How It Works</p>
        <div className="flex flex-col sm:flex-row gap-2">
          <Step
            n={1}
            title="Request a swap"
            body={`Submit your trade. Input tokens move into hook custody. Swaps under ${thresholdLabel} skip the auction and execute instantly via the express lane.`}
            accent="var(--color-primary)"
          />
          <Step
            n={2}
            title="Searchers bid"
            body={`A ${windowLabel} bidding window opens. MEV searchers outbid each other for execution rights. No bids? The swap still executes at no extra cost.`}
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

      {/* ── SWAP FORM ─────────────────────────────────────── */}
      <section>
        <p className="eyebrow mb-3">Protected Swap</p>

        <div
          className="rounded-sm border transition-colors duration-200"
          style={{ borderColor: accentBorder, backgroundColor: "var(--color-surface)" }}
        >
          {/* FROM */}
          <div className="border-b px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div
                  className="size-7 rounded-sm flex items-center justify-center text-[11px] font-bold"
                  style={{ backgroundColor: "var(--color-primary)" + "20", color: "var(--color-primary)" }}
                >
                  {fromSymbol.slice(0, 1)}
                </div>
                <span className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>{fromSymbol}</span>
              </div>
              <input
                type="number"
                min="0"
                step="any"
                placeholder="0.00"
                value={amount}
                onChange={(e) => { setAmount(e.target.value); setError(undefined); }}
                className="mono-val w-28 sm:w-40 text-right text-xl font-medium bg-transparent outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                style={{ color: "var(--color-text)" }}
              />
            </div>
            <div className="flex items-center justify-between mt-1.5">
              <span className="eyebrow" style={{ marginBottom: 0 }}>Balance</span>
              <span className="mono-val text-[11px]" style={{ color: "var(--color-subtext)" }}>{fromBal}</span>
            </div>
          </div>

          {/* FLIP */}
          <div className="flex justify-center py-0 relative">
            <button
              onClick={() => { setZeroForOne((v) => !v); setError(undefined); }}
              className="size-7 flex items-center justify-center -my-3.5 relative z-10 rounded-sm border transition-colors"
              style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface-alt)", color: "var(--color-subtext)" }}
              title="Flip direction"
            >
              <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3">
                <path d="M8 2v12M4 10l4 4 4-4M4 6l4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          {/* TO */}
          <div className="border-t px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div
                  className="size-7 rounded-sm flex items-center justify-center text-[11px] font-bold"
                  style={{ backgroundColor: "var(--color-info)" + "20", color: "var(--color-info)" }}
                >
                  {toSymbol.slice(0, 1)}
                </div>
                <span className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>{toSymbol}</span>
              </div>
              <span className="mono-val text-xl font-medium" style={{ color: "var(--color-eyebrow)" }}>—</span>
            </div>
            <div className="flex items-center justify-between mt-1.5">
              <span className="eyebrow" style={{ marginBottom: 0 }}>Balance</span>
              <span className="mono-val text-[11px]" style={{ color: "var(--color-subtext)" }}>{toBal}</span>
            </div>
          </div>

          {/* MECHANISM INFO */}
          <div
            className="border-t px-4 py-3 grid grid-cols-2 gap-x-4 gap-y-3"
            style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface-alt)" }}
          >
            <DataPair
              label="Swap Type"
              value={swapType ? swapType.label : "Enter amount"}
              valueColor={swapType ? swapType.color : "var(--color-eyebrow)"}
            />
            <DataPair label="Auction Window" value={windowLabel} />
            <DataPair label="Express Lane Below" value={`< ${thresholdLabel}`} />
            <DataPair label="Bid Donated To" value="Liquidity Providers" valueColor="var(--color-subtext)" />
          </div>

          {/* ERROR */}
          {error && (
            <div className="border-t px-4 py-2.5 text-xs mono-val" style={{ borderColor: "var(--color-border)", color: "var(--color-error)" }}>
              {error}
            </div>
          )}

          {/* APPROVE SUCCESS */}
          {isApproveSuccess && (
            <div className="border-t px-4 py-2.5 text-xs" style={{ borderColor: "var(--color-border)", color: "var(--color-success)" }}>
              {fromSymbol} approved. You can now request your swap.
            </div>
          )}

          {/* SWAP SUCCESS */}
          {isSwapSuccess && (
            <div className="border-t px-4 py-2.5 text-xs" style={{ borderColor: "var(--color-border)", color: isSmall ? "var(--color-success)" : "var(--color-subtext)" }}>
              {isSmall ? "Swap executed via Express Lane." : (
                <>Auction open — <a href="/auctions" className="underline" style={{ color: "var(--color-primary)" }}>track in Auctions</a></>
              )}
            </div>
          )}

          {/* CTA */}
          <div className="border-t px-4 py-3 flex flex-col gap-2" style={{ borderColor: "var(--color-border)" }}>
            {!isConnected ? (
              <button
                disabled
                className="w-full py-2.5 text-xs font-semibold rounded-sm opacity-40 cursor-not-allowed"
                style={{ background: "var(--color-surface-alt)", color: "var(--color-subtext)", border: "none" }}
              >
                Connect Wallet to Swap
              </button>
            ) : needsApproval ? (
              <button
                onClick={handleApprove}
                disabled={isLoading || parsedAmount === 0n}
                className="w-full py-2.5 text-xs font-semibold rounded-sm transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
                style={{
                  background: isLoading ? "var(--color-surface-alt)" : "linear-gradient(135deg, var(--color-amber) 0%, var(--color-primary) 100%)",
                  color: isLoading ? "var(--color-subtext)" : "#ffffff",
                  border: "none",
                }}
              >
                {isPending ? "Confirm approval in wallet…"
                  : isApproveConfirming ? "Waiting for approval…"
                  : `Approve ${fromSymbol}`}
              </button>
            ) : (
              <button
                onClick={handleSwap}
                disabled={isLoading || !amount || parsedAmount === 0n}
                className="w-full py-2.5 text-xs font-semibold rounded-sm transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
                style={{
                  background: (isLoading || !amount || parsedAmount === 0n)
                    ? "var(--color-surface-alt)"
                    : "linear-gradient(135deg, var(--color-primary) 0%, var(--color-info) 100%)",
                  color: (isLoading || !amount || parsedAmount === 0n) ? "var(--color-subtext)" : "#ffffff",
                  border: "none",
                }}
              >
                {isPending ? "Confirm in wallet…"
                  : isSwapConfirming ? "Confirming…"
                  : isSmall ? "Request Express Swap"
                  : "Request Swap — Open Auction"}
              </button>
            )}
            <p className="text-center text-[10px]" style={{ color: "var(--color-eyebrow)" }}>
              Tokens held by the hook until execution. Searcher bids go to your LPs.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
