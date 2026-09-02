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

// suppress unused — kept for symmetry with future native support
void NATIVE_ETH;

// ─── Small data-pair component: eyebrow + mono value ─────────────────────────
function DataPair({
  label,
  value,
  valueColor,
  sub,
}: {
  label: string;
  value: string;
  valueColor?: string;
  sub?: string;
}) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <p
        className="mono-val text-sm font-medium leading-tight"
        style={{ color: valueColor ?? "var(--color-text)" }}
      >
        {value}
      </p>
      {sub && (
        <p className="mono-val text-[10px] mt-0.5" style={{ color: "var(--color-eyebrow)" }}>
          {sub}
        </p>
      )}
    </div>
  );
}

// ─── How It Works step ────────────────────────────────────────────────────────
function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3">
      <span
        className="mono-val shrink-0 text-[10px] font-bold mt-0.5"
        style={{ color: "var(--color-eyebrow)" }}
      >
        {String(n).padStart(2, "0")}
      </span>
      <div>
        <p className="text-xs font-medium" style={{ color: "var(--color-text)" }}>
          {title}
        </p>
        <p className="text-xs leading-relaxed mt-0.5" style={{ color: "var(--color-subtext)" }}>
          {body}
        </p>
      </div>
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

  // ─── Contract reads (no wallet required) ─────────────────────────────────

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

  // ─── ERC20 balances (require connected address) ───────────────────────────

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

  // ─── Write ────────────────────────────────────────────────────────────────

  const { writeContractAsync, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  // ─── Derived ──────────────────────────────────────────────────────────────

  const parsedAmount = (() => {
    try {
      return fromIsNative ? parseEther(amount || "0") : parseUnits(amount || "0", 18);
    } catch {
      return 0n;
    }
  })();

  const isSmall =
    smallThreshold !== undefined && parsedAmount < smallThreshold && parsedAmount > 0n;

  const fmtBal = (v: bigint | undefined) =>
    v !== undefined ? (Number(v) / 1e18).toFixed(4) : null;

  const bal0Str = fmtBal(bal0);
  const bal1Str = fmtBal(bal1);

  const fromBal = address
    ? (zeroForOne ? bal0Str : bal1Str) ?? "—"
    : "—";
  const toBal = address
    ? (zeroForOne ? bal1Str : bal0Str) ?? "—"
    : "—";

  const windowBlocks = auctionWindow !== undefined ? Number(auctionWindow) : null;
  const windowLabel = windowBlocks !== null ? `${windowBlocks} blocks (~${windowBlocks}s)` : "…";

  const thresholdLabel =
    smallThreshold !== undefined
      ? `${(Number(smallThreshold) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${TOKEN0_SYMBOL}`
      : "…";

  const swapType =
    parsedAmount > 0n
      ? isSmall
        ? { label: "Express Lane", color: "var(--color-success)" }
        : { label: "Full Auction", color: "var(--color-amber)" }
      : null;

  // ─── Handler ──────────────────────────────────────────────────────────────

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
      setError(
        msg.includes("User rejected") ? "Transaction rejected." : msg.slice(0, 140)
      );
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-xl px-4 py-8">

      {/* ── HOW IT WORKS ─────────────────────────────────── */}
      <section className="mb-8">
        <p className="eyebrow mb-4">How It Works</p>
        <div className="flex flex-col gap-3.5">
          <Step
            n={1}
            title="Request a swap"
            body={`Submit your swap — tokens are held by the hook contract. Swaps under ${thresholdLabel} skip the auction entirely (Express Lane, instant execution).`}
          />
          <Step
            n={2}
            title="Auction or Express Lane"
            body={`Larger swaps open a ${windowLabel} bidding window. Arbitrageurs compete by calling submitBid() with increasing bids. No bids? The swap still executes at zero cost.`}
          />
          <Step
            n={3}
            title="Winning bid → LPs, swap output → you"
            body="The highest bid is donated to the pool's liquidity providers via poolManager.donate(). You receive your swap output. MEV is recaptured, not extracted."
          />
        </div>
      </section>

      {/* ── SWAP FORM ─────────────────────────────────────── */}
      <section>
        <p className="eyebrow mb-4">Protected Swap</p>

        <div
          className="border rounded-sm"
          style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
        >
          {/* FROM row */}
          <div
            className="border-b px-4 py-3"
            style={{ borderColor: "var(--color-border)" }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div
                  className="size-6 rounded-sm flex items-center justify-center text-[10px] font-bold"
                  style={{
                    backgroundColor: "var(--color-surface-alt)",
                    color: "var(--color-primary)",
                  }}
                >
                  {fromSymbol.slice(0, 1)}
                </div>
                <span className="text-sm font-medium" style={{ color: "var(--color-text)" }}>
                  {fromSymbol}
                </span>
                <svg viewBox="0 0 12 12" fill="none" className="w-2.5 h-2.5" style={{ color: "var(--color-eyebrow)" }}>
                  <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
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
              <span className="mono-val text-[11px]" style={{ color: "var(--color-subtext)" }}>
                {fromBal}
              </span>
            </div>
          </div>

          {/* FLIP */}
          <div className="flex justify-center py-0 relative">
            <button
              onClick={() => setZeroForOne((v) => !v)}
              className="size-7 flex items-center justify-center -my-3.5 relative z-10 rounded-sm border transition-colors"
              style={{
                borderColor: "var(--color-border)",
                backgroundColor: "var(--color-surface-alt)",
                color: "var(--color-subtext)",
              }}
              title="Flip direction"
            >
              <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3">
                <path d="M8 2v12M4 10l4 4 4-4M4 6l4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          {/* TO row */}
          <div
            className="border-t px-4 py-3"
            style={{ borderColor: "var(--color-border)" }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div
                  className="size-6 rounded-sm flex items-center justify-center text-[10px] font-bold"
                  style={{
                    backgroundColor: "var(--color-surface-alt)",
                    color: "var(--color-info)",
                  }}
                >
                  {toSymbol.slice(0, 1)}
                </div>
                <span className="text-sm font-medium" style={{ color: "var(--color-text)" }}>
                  {toSymbol}
                </span>
              </div>
              <span className="mono-val text-xl font-medium" style={{ color: "var(--color-eyebrow)" }}>
                —
              </span>
            </div>
            <div className="flex items-center justify-between mt-1.5">
              <span className="eyebrow" style={{ marginBottom: 0 }}>Balance</span>
              <span className="mono-val text-[11px]" style={{ color: "var(--color-subtext)" }}>
                {toBal}
              </span>
            </div>
          </div>

          {/* MECHANISM INFO */}
          <div
            className="border-t px-4 py-3 grid grid-cols-2 gap-x-4 gap-y-3"
            style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface-alt)" }}
          >
            <DataPair
              label="Swap Type"
              value={swapType ? swapType.label : "—"}
              valueColor={swapType ? swapType.color : "var(--color-eyebrow)"}
            />
            <DataPair label="Bidding Window" value={windowLabel} />
            <DataPair
              label="Express Lane Threshold"
              value={`< ${thresholdLabel}`}
            />
            <DataPair
              label="Bid Donated To"
              value="Liquidity Providers"
              valueColor="var(--color-subtext)"
            />
          </div>

          {/* FEEDBACK */}
          {error && (
            <div
              className="border-t px-4 py-2.5 text-xs mono-val"
              style={{ borderColor: "var(--color-border)", color: "var(--color-error)" }}
            >
              {error}
            </div>
          )}
          {isSuccess && isSmall && (
            <div
              className="border-t px-4 py-2.5 text-xs"
              style={{ borderColor: "var(--color-border)", color: "var(--color-success)" }}
            >
              <span className="eyebrow" style={{ color: "var(--color-success)", marginBottom: "2px" }}>Status</span>
              <p>Swap executed via Express Lane.</p>
            </div>
          )}
          {isSuccess && !isSmall && (
            <div
              className="border-t px-4 py-2.5 text-xs"
              style={{ borderColor: "var(--color-border)", color: "var(--color-subtext)" }}
            >
              <span className="eyebrow d-block" style={{ marginBottom: "2px" }}>Status</span>
              <p>
                Auction open —{" "}
                <a href="/auctions" className="underline" style={{ color: "var(--color-primary)" }}>
                  track in Auctions
                </a>
              </p>
            </div>
          )}

          {/* CTA */}
          <div className="border-t px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
            <button
              id="swap-submit-btn"
              onClick={handleSwap}
              disabled={!isConnected || !amount || parsedAmount === 0n || isPending || isConfirming}
              className="w-full py-2.5 text-xs font-semibold rounded-sm border transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              style={{
                borderColor: "var(--color-primary)",
                color: "var(--color-primary)",
                backgroundColor: "transparent",
              }}
            >
              {!isConnected
                ? "Connect Wallet to Swap"
                : isPending
                ? "Confirm in wallet…"
                : isConfirming
                ? "Confirming…"
                : isSmall
                ? "Request Express Swap"
                : "Request Swap (Full Auction)"}
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
