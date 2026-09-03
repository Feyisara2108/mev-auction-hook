"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatEther, parseEther, zeroAddress } from "viem";
import {
  useAccount,
  useBlockNumber,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { GOVERNED_MEV_AUCTION_HOOK_ABI as MEV_AUCTION_HOOK_ABI } from "@/lib/abi";
import { HOOK_ADDRESS, POOL_KEY, TOKEN0_SYMBOL, TOKEN1_SYMBOL } from "@/lib/constants";
import { BPS_DENOMINATOR_BI, bpsToPercent } from "@/lib/governance";
import { useMounted } from "@/lib/useMounted";

type RequestInfo = {
  sender: `0x${string}`;
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  zeroForOne: boolean;
  amountSpecified: bigint;
  deadlineBlock: bigint;
  highestBid: bigint;
  highestBidder: `0x${string}`;
  isCompleted: boolean;
  auctionOpen: boolean;
};

type Filter = "ALL" | "Open" | "Closed";

function fmtBlocksLeft(blocks: bigint): string {
  const n = Number(blocks);
  const m = Math.floor(n / 60);
  const s = n % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Flat colored status word — no badge
function StatusWord({ info }: { info: RequestInfo }) {
  if (info.isCompleted)
    return <span className="mono-val text-xs" style={{ color: "var(--color-eyebrow)" }}>Executed</span>;
  if (info.auctionOpen)
    return <span className="mono-val text-xs" style={{ color: "var(--color-success)" }}>Open</span>;
  return <span className="mono-val text-xs" style={{ color: "var(--color-amber)" }}>Awaiting Execution</span>;
}

function AuctionCard({
  requestId,
  info,
  currentBlock,
  lpShareBps,
}: {
  requestId: bigint;
  info: RequestInfo;
  currentBlock: bigint;
  lpShareBps: bigint;
}) {
  const { address } = useAccount();
  const mounted = useMounted();
  const queryClient = useQueryClient();
  const [bidInput, setBidInput] = useState("");
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string | undefined>();

  const { writeContractAsync, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (isSuccess) queryClient.invalidateQueries();
  }, [isSuccess, queryClient]);

  const absAmount = info.amountSpecified < 0n ? -info.amountSpecified : info.amountSpecified;
  const fromSymbol = info.zeroForOne ? TOKEN0_SYMBOL : TOKEN1_SYMBOL;
  const toSymbol = info.zeroForOne ? TOKEN1_SYMBOL : TOKEN0_SYMBOL;
  const blocksLeft = info.deadlineBlock > currentBlock ? info.deadlineBlock - currentBlock : 0n;
  const isClosed = !info.auctionOpen && !info.isCompleted;
  const isRequester = mounted && address?.toLowerCase() === info.sender.toLowerCase();
  const bidCurrencyIsNative = info.currency0 === zeroAddress;

  async function handleBid() {
    if (!bidInput) return;
    setError(undefined);
    const bidWei = parseEther(bidInput);
    try {
      const hash = await writeContractAsync({
        address: HOOK_ADDRESS,
        abi: MEV_AUCTION_HOOK_ABI,
        functionName: "submitBid",
        args: [requestId, bidCurrencyIsNative ? 0n : bidWei],
        value: bidCurrencyIsNative ? bidWei : 0n,
      });
      setTxHash(hash);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.includes("User rejected") ? "Rejected." : msg.slice(0, 120));
    }
  }

  async function handleExecute() {
    setError(undefined);
    try {
      const hash = await writeContractAsync({
        address: HOOK_ADDRESS,
        abi: MEV_AUCTION_HOOK_ABI,
        functionName: "executeSwap",
        args: [requestId],
      });
      setTxHash(hash);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.includes("User rejected") ? "Rejected." : msg.slice(0, 120));
    }
  }

  async function handleCancel() {
    setError(undefined);
    try {
      const hash = await writeContractAsync({
        address: HOOK_ADDRESS,
        abi: MEV_AUCTION_HOOK_ABI,
        functionName: "cancelSwap",
        args: [requestId],
      });
      setTxHash(hash);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.includes("User rejected") ? "Rejected." : msg.slice(0, 120));
    }
  }

  return (
    <div
      className="border rounded-sm"
      style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2.5 border-b"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="flex items-center gap-3">
          <span className="mono-val text-xs" style={{ color: "var(--color-subtext)" }}>
            #{requestId.toString().padStart(4, "0")}
          </span>
          <span className="text-xs font-medium" style={{ color: "var(--color-text)" }}>
            {fromSymbol} → {toSymbol}
          </span>
          <span className="mono-val text-[10px]" style={{ color: "var(--color-eyebrow)" }}>
            {info.sender.slice(0, 8)}…{info.sender.slice(-4)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isRequester && !info.isCompleted && (
            <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-primary)" }}>
              yours
            </span>
          )}
          <StatusWord info={info} />
        </div>
      </div>

      {/* Data grid */}
      <div className="grid grid-cols-3 divide-x divide-[var(--color-border)]">
        {/* Swap Amount */}
        <div className="px-4 py-3">
          <p className="eyebrow">Swap Amount</p>
          <p className="mono-val text-sm font-medium" style={{ color: "var(--color-text)" }}>
            {formatEther(absAmount)}
          </p>
          <p className="mono-val text-[10px]" style={{ color: "var(--color-eyebrow)" }}>
            {fromSymbol}
          </p>
        </div>

        {/* Highest Bid */}
        <div className="px-4 py-3">
          <p className="eyebrow">{info.isCompleted ? "Winning Bid" : "Highest Bid"}</p>
          <p
            className="mono-val text-sm font-medium"
            style={{
              color:
                info.highestBid > 0n ? "var(--color-amber)" : "var(--color-eyebrow)",
            }}
          >
            {info.highestBid > 0n ? formatEther(info.highestBid) : "—"}
          </p>
          {info.highestBid > 0n && (
            <p className="mono-val text-[10px]" style={{ color: "var(--color-eyebrow)" }}>
              {fromSymbol}
            </p>
          )}
        </div>

        {/* Time Remaining / Status */}
        <div className="px-4 py-3">
          <p className="eyebrow">{info.isCompleted ? "Final Status" : "Time Remaining"}</p>
          <p
            className="mono-val text-sm font-medium"
            style={{
              color: info.isCompleted
                ? "var(--color-eyebrow)"
                : info.auctionOpen
                ? "var(--color-success)"
                : "var(--color-subtext)",
            }}
          >
            {info.isCompleted
              ? "Settled"
              : info.auctionOpen
              ? fmtBlocksLeft(blocksLeft)
              : "Closed"}
          </p>
          {info.auctionOpen && !info.isCompleted && (
            <p className="mono-val text-[10px]" style={{ color: "var(--color-eyebrow)" }}>
              ~{Number(blocksLeft)} blocks
            </p>
          )}
        </div>
      </div>

      {/* Split notice */}
      {info.highestBid > 0n && (
        <div
          className="border-t px-4 py-2.5 text-[11px] flex flex-wrap items-center gap-x-4 gap-y-1"
          style={{ borderColor: "var(--color-border)", color: "var(--color-subtext)" }}
        >
          <span className="eyebrow" style={{ display: "inline", marginBottom: 0 }}>
            {info.isCompleted ? "Split" : "Split if it settles now"}
          </span>
          <span className="mono-val" style={{ color: "var(--color-success)" }}>
            {formatEther((info.highestBid * lpShareBps) / BPS_DENOMINATOR_BI)} {fromSymbol} → LPs
          </span>
          <span className="mono-val" style={{ color: "var(--color-info)" }}>
            {formatEther(info.highestBid - (info.highestBid * lpShareBps) / BPS_DENOMINATOR_BI)}{" "}
            {fromSymbol} → trader
          </span>
          <span style={{ color: "var(--color-eyebrow)" }}>({bpsToPercent(lpShareBps)} LP vote)</span>
        </div>
      )}

      {/* Error / success */}
      {error && (
        <div
          className="border-t px-4 py-2 text-xs mono-val"
          style={{ borderColor: "var(--color-border)", color: "var(--color-error)" }}
        >
          {error}
        </div>
      )}
      {isSuccess && (
        <div
          className="border-t px-4 py-2 text-xs"
          style={{ borderColor: "var(--color-border)", color: "var(--color-success)" }}
        >
          Transaction confirmed.
        </div>
      )}

      {/* Actions — open auction */}
      {info.auctionOpen && !info.isCompleted && (
        <div
          className="border-t px-4 py-3 flex items-center gap-2"
          style={{ borderColor: "var(--color-border)" }}
        >
          <input
            type="number"
            min="0"
            step="any"
            placeholder={`Bid amount (${fromSymbol})`}
            value={bidInput}
            onChange={(e) => setBidInput(e.target.value)}
            className="mono-val flex-1 rounded-sm border bg-transparent px-3 py-1.5 text-xs outline-none"
            style={{
              borderColor: "var(--color-border)",
              color: "var(--color-text)",
            }}
          />
          <button
            onClick={handleBid}
            disabled={!bidInput || isPending || isConfirming}
            className="shrink-0 rounded-sm border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-30"
            style={{
              borderColor: "var(--color-amber)",
              color: "var(--color-amber)",
              backgroundColor: "transparent",
            }}
          >
            {isPending || isConfirming ? "…" : "Place Bid"}
          </button>
          {isRequester && info.highestBid === 0n && (
            <button
              onClick={handleCancel}
              disabled={isPending || isConfirming}
              className="shrink-0 rounded-sm border px-3 py-1.5 text-xs transition-colors disabled:opacity-30"
              style={{
                borderColor: "var(--color-border)",
                color: "var(--color-subtext)",
                backgroundColor: "transparent",
              }}
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {/* Actions — closed, awaiting execution */}
      {isClosed && (
        <div
          className="border-t px-4 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <button
            onClick={handleExecute}
            disabled={isPending || isConfirming}
            className="w-full rounded-sm border py-2 text-xs font-medium transition-colors disabled:opacity-30"
            style={{
              borderColor: "var(--color-primary)",
              color: "var(--color-primary)",
              backgroundColor: "transparent",
            }}
          >
            {isPending || isConfirming ? "Confirming…" : "Execute Swap"}
          </button>
        </div>
      )}
    </div>
  );
}

export default function AuctionsPage() {
  const [filter, setFilter] = useState<Filter>("ALL");
  const { data: blockNumber } = useBlockNumber({ watch: true });

  const { data: nextIdRaw, isLoading: nextIdLoading } = useReadContract({
    address: HOOK_ADDRESS,
    abi: MEV_AUCTION_HOOK_ABI,
    functionName: "nextRequestId",
    query: { refetchInterval: 4000 },
  });

  const { data: govInfo } = useReadContract({
    address: HOOK_ADDRESS,
    abi: MEV_AUCTION_HOOK_ABI,
    functionName: "getGovernanceInfo",
    args: [POOL_KEY],
    query: { refetchInterval: 12_000 },
  });
  const gov = govInfo as
    | { effectiveLpShareBps: bigint; traderRebateBps: bigint; totalLiquidity: bigint; votingWeight: bigint }
    | undefined;
  const lpShareBps = gov?.effectiveLpShareBps ?? BPS_DENOMINATOR_BI;

  const nextId = nextIdRaw ?? 0n;
  const ids = Array.from({ length: Number(nextId) }, (_, i) => BigInt(i));

  const results = useReadContracts({
    contracts: ids.map((id) => ({
      address: HOOK_ADDRESS,
      abi: MEV_AUCTION_HOOK_ABI,
      functionName: "getRequestInfo" as const,
      args: [id] as const,
    })),
    query: { refetchInterval: 4000 },
  });

  const currentBlock = blockNumber ?? 0n;
  const isLoading = nextIdLoading || (nextId > 0n && results.isLoading);

  const allAuctions = ids
    .map((id, i) => ({ id, info: results.data?.[i]?.result as RequestInfo | undefined }))
    .filter((a) => a.info !== undefined)
    .reverse();

  const openAuctions = allAuctions.filter((a) => a.info?.auctionOpen && !a.info?.isCompleted);
  const closedAuctions = allAuctions.filter((a) => a.info?.isCompleted || (!a.info?.auctionOpen && !a.info?.isCompleted));

  const displayed =
    filter === "Open" ? openAuctions : filter === "Closed" ? closedAuctions : allAuctions;

  const totalBidVolume = openAuctions.reduce((sum, a) => sum + (a.info?.highestBid ?? 0n), 0n);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">

      {/* Header */}
      <div className="mb-6">
        <p className="eyebrow mb-1">Live Auctions</p>
        <p className="text-xs" style={{ color: "var(--color-subtext)" }}>
          On-chain auctions for swap execution rights. Outbid the field to win; the
          winning bid is split{" "}
          <span className="mono-val" style={{ color: "var(--color-success)" }}>
            {bpsToPercent(gov?.effectiveLpShareBps)}
          </span>{" "}
          to LPs /{" "}
          <span className="mono-val" style={{ color: "var(--color-info)" }}>
            {bpsToPercent(gov?.traderRebateBps)}
          </span>{" "}
          to the trader, per the pool&apos;s{" "}
          <a href="/governance" className="underline" style={{ color: "var(--color-primary)" }}>
            LP vote
          </a>
          .
        </p>
      </div>

      {/* Stats row */}
      <div
        className="grid grid-cols-3 divide-x border rounded-sm mb-5"
        style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
      >
        <div className="px-4 py-3">
          <p className="eyebrow">Open Auctions</p>
          <p className="mono-val text-xl font-semibold" style={{ color: "var(--color-text)" }}>
            {openAuctions.length}
          </p>
        </div>
        <div className="px-4 py-3">
          <p className="eyebrow">Total Bid Volume</p>
          <p className="mono-val text-xl font-semibold" style={{ color: "var(--color-text)" }}>
            {parseFloat(formatEther(totalBidVolume)).toFixed(4)}
          </p>
          <p className="mono-val text-[10px]" style={{ color: "var(--color-eyebrow)" }}>{TOKEN0_SYMBOL}</p>
        </div>
        <div className="px-4 py-3">
          <p className="eyebrow">Current Block</p>
          <p className="mono-val text-xl font-semibold" style={{ color: "var(--color-text)" }}>
            {blockNumber ? blockNumber.toString() : "—"}
          </p>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-0 mb-5 border-b" style={{ borderColor: "var(--color-border)" }}>
        {(["ALL", "Open", "Closed"] as Filter[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            className="px-4 py-2 text-xs font-medium transition-colors relative"
            style={{ color: filter === tab ? "var(--color-text)" : "var(--color-subtext)" }}
          >
            {tab}
            {filter === tab && (
              <span
                className="absolute bottom-0 left-0 right-0 h-px"
                style={{ backgroundColor: "var(--color-primary)" }}
              />
            )}
          </button>
        ))}
      </div>

      {/* List */}
      {isLoading ? (
        <div className="py-12 text-center">
          <p className="text-xs" style={{ color: "var(--color-subtext)" }}>Loading auctions…</p>
        </div>
      ) : displayed.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-xs" style={{ color: "var(--color-subtext)" }}>
            {nextId === 0n ? "No swap requests yet." : "No auctions in this filter."}
          </p>
          {nextId === 0n && (
            <a
              href="/"
              className="mt-2 inline-block text-xs underline"
              style={{ color: "var(--color-primary)" }}
            >
              Request a swap →
            </a>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {displayed.map(({ id, info }) =>
            info ? (
              <AuctionCard
                key={id.toString()}
                requestId={id}
                info={info}
                currentBlock={currentBlock}
                lpShareBps={lpShareBps}
              />
            ) : null
          )}
        </div>
      )}
    </div>
  );
}
