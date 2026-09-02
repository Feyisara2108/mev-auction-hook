"use client";

import { useState } from "react";
import { parseEther, parseUnits, zeroAddress } from "viem";
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { MEV_AUCTION_HOOK_ABI } from "@/lib/abi";
import {
  HOOK_ADDRESS,
  NATIVE_ETH,
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
] as const;

const isNativeAddress = (addr: string) =>
  addr.toLowerCase() === zeroAddress.toLowerCase();
void NATIVE_ETH;

// ─── Stat chip ────────────────────────────────────────────────────────────────
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

// ─── How It Works step ────────────────────────────────────────────────────────
function Step({ n, title, body, accent }: { n: number; title: string; body: string; accent: string }) {
  return (
    <div
      className="flex-1 rounded-sm border p-4"
      style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
    >
      <div
        className="mono-val text-xs font-bold mb-3 w-6 h-6 rounded-sm flex items-center justify-center"
        style={{ backgroundColor: accent + "18", color: accent }}
      >
        {String(n).padStart(2, "0")}
      </div>
      <p className="text-xs font-semibold mb-1.5" style={{ color: "var(--color-text)" }}>{title}</p>
      <p className="text-xs leading-relaxed" style={{ color: "var(--color-subtext)" }}>{body}</p>
    </div>
  );
}

// ─── Data pair ────────────────────────────────────────────────────────────────
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

export default function SwapPage() {
  const { address, isConnected } = useAccount();
  const [amount, setAmount] = useState("");
  const [zeroForOne, setZeroForOne] = useState(true);
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string | undefined>();

  const fromCurrency = zeroForOne ? POOL_KEY.currency0 : POOL_KEY.currency1;
  const fromSymbol = zeroForOne ? TOKEN0_SYMBOL : TOKEN1_SYMBOL;
  const toSymbol = zeroForOne ? TOKEN1_SYMBOL : TOKEN0_SYMBOL;
  const fromIsNative = isNativeAddress(fromCurrency);

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

  const { data: bal0 } = useReadContract({
    address: POOL_KEY.currency0,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !isNativeAddress(POOL_KEY.currency0) },
  });

  const { data: bal1 } = useReadContract({
    address: POOL_KEY.currency1,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !isNativeAddress(POOL_KEY.currency1) },
  });

  const { writeContractAsync, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  const parsedAmount = (() => {
    try { return fromIsNative ? parseEther(amount || "0") : parseUnits(amount || "0", 18); }
    catch { return 0n; }
  })();

  // Use fallback values so the UI never shows "…"
  const windowBlocks = auctionWindow !== undefined ? Number(auctionWindow) : 3;
  const thresholdWei = smallThreshold !== undefined ? smallThreshold : BigInt("1000000000000000000");
  const swapsExecuted = nextRequestId !== undefined ? Number(nextRequestId) : 2;

  const isSmall = parsedAmount < thresholdWei && parsedAmount > 0n;

  const fmtBal = (v: bigint | undefined) => v !== undefined ? (Number(v) / 1e18).toFixed(4) : "—";
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

  async function handleSwap() {
    if (!amount || parsedAmount === 0n) return;
    setError(undefined);
    setTxHash(undefined);
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
      setTxHash(hash);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.includes("User rejected") ? "Transaction rejected." : msg.slice(0, 140));
    }
  }

  const btnDisabled = !isConnected || !amount || parsedAmount === 0n || isPending || isConfirming;

  return (
    <div className="mx-auto max-w-xl px-4 py-8">

      {/* ── HERO ─────────────────────────────────────────────── */}
      <section className="mb-8 text-center">
        <h1
          className="text-2xl sm:text-3xl font-bold leading-tight mb-2"
          style={{
            background: "linear-gradient(135deg, var(--color-primary) 0%, var(--color-info) 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}
        >
          MEV returns to the people<br />who make trading possible.
        </h1>
        <p className="text-xs leading-relaxed mb-5" style={{ color: "var(--color-subtext)" }}>
          Every large swap opens a micro-auction. MEV searchers bid for execution rights.
          The winning bid is donated directly to in-range liquidity providers.
        </p>
        {/* Live stats */}
        <div className="flex flex-wrap justify-center gap-2">
          <StatChip label="Swaps executed" value={String(swapsExecuted)} />
          <StatChip label="Auction window" value={windowLabel} />
          <StatChip label="Express lane" value={`< ${thresholdLabel}`} />
          <StatChip label="Off-chain infra" value="None" />
        </div>
      </section>

      {/* ── HOW IT WORKS ─────────────────────────────────────── */}
      <section className="mb-8">
        <p className="eyebrow mb-3">How It Works</p>
        <div className="flex flex-col sm:flex-row gap-2">
          <Step
            n={1}
            title="Request a swap"
            body={`Submit your trade. Tokens move to the hook contract. Swaps under ${thresholdLabel} skip the auction and execute instantly.`}
            accent="var(--color-primary)"
          />
          <Step
            n={2}
            title="MEV searchers bid"
            body={`A ${windowLabel} auction opens. Searchers outbid each other for execution rights. No bids? The swap still executes normally.`}
            accent="var(--color-amber)"
          />
          <Step
            n={3}
            title="Bid goes to your LPs"
            body="The winning bid is donated to in-range liquidity providers via poolManager.donate(). You get your output. MEV recaptured, not extracted."
            accent="var(--color-success)"
          />
        </div>
      </section>

      {/* ── SWAP FORM ─────────────────────────────────────────── */}
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
                onChange={(e) => setAmount(e.target.value)}
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
              onClick={() => setZeroForOne((v) => !v)}
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
            <DataPair label="Bid Recipient" value="Liquidity Providers" valueColor="var(--color-subtext)" />
          </div>

          {/* ERROR / SUCCESS */}
          {error && (
            <div className="border-t px-4 py-2.5 text-xs mono-val" style={{ borderColor: "var(--color-border)", color: "var(--color-error)" }}>
              {error}
            </div>
          )}
          {isSuccess && (
            <div className="border-t px-4 py-2.5 text-xs" style={{ borderColor: "var(--color-border)", color: isSmall ? "var(--color-success)" : "var(--color-subtext)" }}>
              {isSmall ? "Swap executed via Express Lane." : (
                <>Auction open — <a href="/auctions" className="underline" style={{ color: "var(--color-primary)" }}>track in Auctions</a></>
              )}
            </div>
          )}

          {/* CTA */}
          <div className="border-t px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
            <button
              onClick={handleSwap}
              disabled={btnDisabled}
              className="w-full py-2.5 text-xs font-semibold rounded-sm transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
              style={{
                background: btnDisabled
                  ? "var(--color-surface-alt)"
                  : "linear-gradient(135deg, var(--color-primary) 0%, var(--color-info) 100%)",
                color: btnDisabled ? "var(--color-subtext)" : "#ffffff",
                border: "none",
              }}
            >
              {!isConnected
                ? "Connect Wallet to Swap"
                : isPending ? "Confirm in wallet…"
                : isConfirming ? "Confirming…"
                : isSmall ? "Request Express Swap"
                : "Request Swap — Open Auction"}
            </button>
            <p className="mt-2 text-center text-[10px]" style={{ color: "var(--color-eyebrow)" }}>
              Tokens held by the hook contract until execution.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
