"use client";

import { useState } from "react";
import { parseEther, parseUnits, zeroAddress, maxUint256 } from "viem";
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { GOVERNED_MEV_AUCTION_HOOK_ABI as MEV_AUCTION_HOOK_ABI } from "@/lib/abi";
import {
  HOOK_ADDRESS,
  POOL_KEY,
  TOKEN0_SYMBOL,
  TOKEN1_SYMBOL,
} from "@/lib/constants";
import { bpsToPercent } from "@/lib/governance";
import { useMounted } from "@/lib/useMounted";

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
  const mounted = useMounted();
  const walletReady = mounted && isConnected;
  const [amount, setAmount] = useState("");
  const [zeroForOne, setZeroForOne] = useState(true);
  const [swapTxHash, setSwapTxHash] = useState<`0x${string}` | undefined>();
  const [approveTxHash, setApproveTxHash] = useState<`0x${string}` | undefined>();
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

  const { data: govInfo } = useReadContract({
    address: HOOK_ADDRESS,
    abi: MEV_AUCTION_HOOK_ABI,
    functionName: "getGovernanceInfo",
    args: [POOL_KEY],
    query: { refetchInterval: 12_000 },
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

  const { writeContractAsync, isPending } = useWriteContract();

  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } =
    useWaitForTransactionReceipt({ hash: approveTxHash });

  const { isLoading: isSwapConfirming, isSuccess: isSwapSuccess } =
    useWaitForTransactionReceipt({ hash: swapTxHash });

  if (isApproveSuccess && approveTxHash) {
    void refetchAllowance();
    void refetchBal0();
    void refetchBal1();
  }

  const parsedAmount = (() => {
    try { return fromIsNative ? parseEther(amount || "0") : parseUnits(amount || "0", 18); }
    catch { return 0n; }
  })();

  const windowBlocks = auctionWindow !== undefined ? Number(auctionWindow) : 3;
  const thresholdWei = smallThreshold !== undefined ? smallThreshold : BigInt("1000000000000000000");
  const isSmall = parsedAmount < thresholdWei && parsedAmount > 0n;
  const needsApproval = !fromIsNative && parsedAmount > 0n && (allowance ?? 0n) < parsedAmount;

  const fmtBal = (v: bigint | undefined) =>
    v !== undefined ? (Number(v) / 1e18).toFixed(4) : "—";
  const fromBal = address ? (zeroForOne ? fmtBal(bal0) : fmtBal(bal1)) : "—";
  const toBal = address ? (zeroForOne ? fmtBal(bal1) : fmtBal(bal0)) : "—";

  const windowLabel = `${windowBlocks} blocks (~${windowBlocks}s)`;
  const thresholdLabel = `${(Number(thresholdWei) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${TOKEN0_SYMBOL}`;

  const gov = govInfo as
    | { effectiveLpShareBps: bigint; traderRebateBps: bigint; totalLiquidity: bigint; votingWeight: bigint }
    | undefined;
  const lpShareLabel = bpsToPercent(gov?.effectiveLpShareBps);
  const rebateLabel = bpsToPercent(gov?.traderRebateBps);
  const noVotesYet = gov !== undefined && gov.votingWeight === 0n;

  const swapType = parsedAmount > 0n
    ? isSmall
      ? { label: "Express Lane", color: "var(--color-success)" }
      : { label: "Full Auction", color: "var(--color-amber)" }
    : null;

  const accentBorder = swapType?.color ?? "var(--color-border)";
  const isLoading = isPending || isApproveConfirming || isSwapConfirming;

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

  return (
    <div className="mx-auto max-w-sm px-4 py-10">

      <div className="mb-5">
        <p className="eyebrow mb-1">Swap</p>
        <p className="text-xs" style={{ color: "var(--color-subtext)" }}>
          Large swaps open an on-chain auction. The winning searcher bid is split
          between this pool&apos;s LPs and you, in the ratio the LPs voted for.
        </p>
      </div>

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
              className="mono-val w-32 text-right text-xl font-medium bg-transparent outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
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

        {/* INFO */}
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
          <DataPair
            label="To LPs / To You"
            value={gov ? `${lpShareLabel} / ${rebateLabel}` : "—"}
            valueColor="var(--color-success)"
          />
        </div>

        {/* GOVERNED SPLIT DETAIL */}
        {swapType && !isSmall && (
          <div
            className="border-t px-4 py-2.5 text-[11px]"
            style={{ borderColor: "var(--color-border)", color: "var(--color-subtext)" }}
          >
            The winning bid on this swap will be split{" "}
            <span className="mono-val" style={{ color: "var(--color-success)" }}>
              {lpShareLabel}
            </span>{" "}
            donated to in-range LPs and{" "}
            <span className="mono-val" style={{ color: "var(--color-info)" }}>
              {rebateLabel}
            </span>{" "}
            rebated to you.
            {noVotesYet && (
              <>
                {" "}
                No LP has voted yet, so the pool default (100% to LPs) applies.
              </>
            )}{" "}
            <a href="/governance" className="underline" style={{ color: "var(--color-primary)" }}>
              LPs set this
            </a>
            .
          </div>
        )}

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
          {!walletReady ? (
            <button disabled className="w-full py-2.5 text-xs font-semibold rounded-sm opacity-40 cursor-not-allowed"
              style={{ background: "var(--color-surface-alt)", color: "var(--color-subtext)", border: "none" }}>
              Connect Wallet to Swap
            </button>
          ) : needsApproval ? (
            <button onClick={handleApprove} disabled={isLoading || parsedAmount === 0n}
              className="w-full py-2.5 text-xs font-semibold rounded-sm transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
              style={{
                background: isLoading ? "var(--color-surface-alt)" : "linear-gradient(135deg, var(--color-amber) 0%, var(--color-primary) 100%)",
                color: isLoading ? "var(--color-subtext)" : "#ffffff",
                border: "none",
              }}>
              {isPending ? "Confirm approval in wallet…" : isApproveConfirming ? "Waiting for approval…" : `Approve ${fromSymbol}`}
            </button>
          ) : (
            <button onClick={handleSwap} disabled={isLoading || !amount || parsedAmount === 0n}
              className="w-full py-2.5 text-xs font-semibold rounded-sm transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
              style={{
                background: (isLoading || !amount || parsedAmount === 0n) ? "var(--color-surface-alt)" : "linear-gradient(135deg, var(--color-primary) 0%, var(--color-info) 100%)",
                color: (isLoading || !amount || parsedAmount === 0n) ? "var(--color-subtext)" : "#ffffff",
                border: "none",
              }}>
              {isPending ? "Confirm in wallet…" : isSwapConfirming ? "Confirming…" : isSmall ? "Request Express Swap" : "Request Swap — Open Auction"}
            </button>
          )}
          <p className="text-center text-[10px]" style={{ color: "var(--color-eyebrow)" }}>
            Tokens held by the hook until execution. The winning bid is split
            between LPs and you per the pool vote.
          </p>
        </div>
      </div>
    </div>
  );
}
