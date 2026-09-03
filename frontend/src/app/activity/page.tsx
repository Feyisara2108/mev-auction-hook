"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatEther } from "viem";
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

// Flat status word only — no badge
function SwapStatus({ info }: { info: RequestInfo }) {
  if (info.isCompleted)
    return <span className="mono-val text-xs" style={{ color: "var(--color-subtext)" }}>Completed</span>;
  if (info.auctionOpen)
    return <span className="mono-val text-xs" style={{ color: "var(--color-amber)" }}>Auction Open</span>;
  return <span className="mono-val text-xs" style={{ color: "var(--color-info)" }}>Awaiting Execution</span>;
}

function BidStatus({ info, address }: { info: RequestInfo; address: `0x${string}` }) {
  const isWinner = info.highestBidder.toLowerCase() === address.toLowerCase();
  if (isWinner && info.isCompleted)
    return <span className="mono-val text-xs" style={{ color: "var(--color-subtext)" }}>Settled</span>;
  if (isWinner)
    return <span className="mono-val text-xs" style={{ color: "var(--color-success)" }}>Winning</span>;
  return <span className="mono-val text-xs" style={{ color: "var(--color-eyebrow)" }}>Outbid</span>;
}

function WithdrawButton({
  currencyAddress,
  amount,
  symbol,
}: {
  currencyAddress: `0x${string}`;
  amount: bigint;
  symbol: string;
}) {
  const queryClient = useQueryClient();
  const { writeContractAsync, isPending } = useWriteContract();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const { isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (isSuccess) queryClient.invalidateQueries();
  }, [isSuccess, queryClient]);

  if (isSuccess)
    return <span className="text-xs" style={{ color: "var(--color-success)" }}>Withdrawn</span>;

  async function handleWithdraw() {
    try {
      const hash = await writeContractAsync({
        address: HOOK_ADDRESS,
        abi: MEV_AUCTION_HOOK_ABI,
        functionName: "withdrawRefund",
        args: [currencyAddress],
      });
      setTxHash(hash);
    } catch {}
  }

  return (
    <button
      onClick={handleWithdraw}
      disabled={isPending}
      className="rounded-sm border px-2.5 py-1 text-[10px] font-medium transition-colors disabled:opacity-40"
      style={{
        borderColor: "var(--color-amber)",
        color: "var(--color-amber)",
        backgroundColor: "transparent",
      }}
    >
      {isPending ? "…" : `Withdraw ${formatEther(amount)} ${symbol}`}
    </button>
  );
}

export default function ActivityPage() {
  const { address, isConnected } = useAccount();
  const mounted = useMounted();
  const { data: blockNumber } = useBlockNumber({ watch: true });
  const currentBlock = blockNumber ?? 0n;

  const { data: nextIdRaw, isLoading: nextIdLoading } = useReadContract({
    address: HOOK_ADDRESS,
    abi: MEV_AUCTION_HOOK_ABI,
    functionName: "nextRequestId",
    query: { refetchInterval: 5000 },
  });

  const nextId = nextIdRaw ?? 0n;
  const ids = Array.from({ length: Number(nextId) }, (_, i) => BigInt(i));

  const results = useReadContracts({
    contracts: ids.map((id) => ({
      address: HOOK_ADDRESS,
      abi: MEV_AUCTION_HOOK_ABI,
      functionName: "getRequestInfo" as const,
      args: [id] as const,
    })),
    query: { refetchInterval: 5000 },
  });

  // Outbid funds are refundable in whichever currency the bid was placed in
  // (currency0 for zeroForOne swaps, currency1 otherwise).
  const { data: refundData } = useReadContracts({
    contracts: [
      {
        address: HOOK_ADDRESS,
        abi: MEV_AUCTION_HOOK_ABI,
        functionName: "pendingRefunds" as const,
        args: address ? [address, POOL_KEY.currency0] : undefined,
      },
      {
        address: HOOK_ADDRESS,
        abi: MEV_AUCTION_HOOK_ABI,
        functionName: "pendingRefunds" as const,
        args: address ? [address, POOL_KEY.currency1] : undefined,
      },
    ],
    query: { enabled: !!address, refetchInterval: 5000 },
  });
  const refund0 = (refundData?.[0]?.result as bigint | undefined) ?? 0n;
  const refund1 = (refundData?.[1]?.result as bigint | undefined) ?? 0n;

  if (!mounted || !isConnected || !address) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-20 text-center">
        <p className="text-xs" style={{ color: "var(--color-subtext)" }}>
          Connect your wallet to view your activity.
        </p>
      </div>
    );
  }

  const allInfos = ids.map((id, i) => ({
    id,
    info: results.data?.[i]?.result as RequestInfo | undefined,
  }));

  const myRequests = allInfos
    .filter((a) => a.info?.sender.toLowerCase() === address.toLowerCase())
    .reverse();

  // Auctions where this wallet is currently the leading bidder. (getRequestInfo
  // only exposes the current high bid, so auctions where the wallet has since
  // been outbid show up under Pending Refunds instead.)
  const myLeadingBids = allInfos
    .filter(
      (a) =>
        a.info !== undefined &&
        a.info.highestBid > 0n &&
        a.info.highestBidder.toLowerCase() === address.toLowerCase() &&
        a.info.sender.toLowerCase() !== address.toLowerCase()
    )
    .reverse();

  const refunds = [
    { currency: POOL_KEY.currency0, symbol: TOKEN0_SYMBOL, amount: refund0 },
    { currency: POOL_KEY.currency1, symbol: TOKEN1_SYMBOL, amount: refund1 },
  ].filter((r) => r.amount > 0n);

  // ─── Shared table styles ──────────────────────────────────────────────────
  const thStyle: React.CSSProperties = {
    color: "var(--color-eyebrow)",
    fontWeight: 600,
    fontSize: "0.6rem",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    padding: "10px 16px 10px 0",
    textAlign: "left",
    borderBottom: "1px solid var(--color-border)",
  };
  const tdStyle: React.CSSProperties = {
    padding: "10px 16px 10px 0",
    borderBottom: "1px solid var(--color-border)",
    verticalAlign: "middle",
  };
  const tdFirstStyle: React.CSSProperties = { ...tdStyle, paddingLeft: "16px" };
  const thFirstStyle: React.CSSProperties = { ...thStyle, paddingLeft: "16px" };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6">
        <p className="eyebrow mb-1">My Activity</p>
        <p className="text-xs" style={{ color: "var(--color-subtext)" }}>
          Your swap requests and active bids.
        </p>
      </div>

      {nextIdLoading ? (
        <p className="text-xs py-8" style={{ color: "var(--color-subtext)" }}>Loading…</p>
      ) : (
        <>
          {/* ── My Swap Requests ─────────────────────────────── */}
          <section className="mb-8">
            <p className="eyebrow mb-3">My Swap Requests</p>
            <div
              className="border rounded-sm overflow-hidden"
              style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
            >
              {myRequests.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-xs" style={{ color: "var(--color-subtext)" }}>No swap requests yet.</p>
                  <a
                    href="/"
                    className="mt-2 inline-block text-xs underline"
                    style={{ color: "var(--color-primary)" }}
                  >
                    Request a swap →
                  </a>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr>
                        <th style={thFirstStyle}>Swap</th>
                        <th style={thStyle}>Amount</th>
                        <th style={thStyle}>Status</th>
                        <th style={thStyle}>Auction Closes</th>
                        <th style={thStyle}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {myRequests.map(({ id, info }) =>
                        info ? (
                          <tr key={id.toString()}>
                            <td style={tdFirstStyle}>
                              <span className="mono-val font-medium" style={{ color: "var(--color-text)" }}>
                                {info.zeroForOne ? TOKEN0_SYMBOL : TOKEN1_SYMBOL}
                                {" → "}
                                {info.zeroForOne ? TOKEN1_SYMBOL : TOKEN0_SYMBOL}
                              </span>
                            </td>
                            <td style={tdStyle}>
                              <span className="mono-val" style={{ color: "var(--color-text)" }}>
                                {formatEther(
                                  info.amountSpecified < 0n ? -info.amountSpecified : info.amountSpecified
                                )}{" "}
                                {info.zeroForOne ? TOKEN0_SYMBOL : TOKEN1_SYMBOL}
                              </span>
                            </td>
                            <td style={tdStyle}>
                              <SwapStatus info={info} />
                            </td>
                            <td style={tdStyle}>
                              <span className="mono-val" style={{ color: "var(--color-subtext)" }}>
                                {info.isCompleted
                                  ? "—"
                                  : info.auctionOpen
                                  ? `~${Math.max(0, Number(info.deadlineBlock - currentBlock))} blocks`
                                  : "—"}
                              </span>
                            </td>
                            <td style={tdStyle}>
                              {!info.isCompleted ? (
                                <a
                                  href="/auctions"
                                  className="text-xs underline"
                                  style={{ color: "var(--color-primary)" }}
                                >
                                  {info.auctionOpen ? "Cancel / Track" : "Execute →"}
                                </a>
                              ) : (
                                <span style={{ color: "var(--color-eyebrow)" }}>Done</span>
                              )}
                            </td>
                          </tr>
                        ) : null
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          {/* ── Pending Refunds ─────────────────────────────── */}
          {refunds.length > 0 && (
            <section className="mb-8">
              <p className="eyebrow mb-3">Pending Refunds</p>
              <div
                className="border rounded-sm"
                style={{ borderColor: "var(--color-amber)", backgroundColor: "var(--color-surface)" }}
              >
                {refunds.map((r) => (
                  <div
                    key={r.currency}
                    className="flex items-center justify-between px-4 py-3 border-b last:border-b-0"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    <div>
                      <p className="mono-val text-sm font-medium" style={{ color: "var(--color-amber)" }}>
                        {formatEther(r.amount)} {r.symbol}
                      </p>
                      <p className="text-[11px]" style={{ color: "var(--color-subtext)" }}>
                        Outbid funds — pull them back any time.
                      </p>
                    </div>
                    <WithdrawButton currencyAddress={r.currency} amount={r.amount} symbol={r.symbol} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── My Leading Bids ─────────────────────────────── */}
          <section>
            <p className="eyebrow mb-3">My Leading Bids</p>
            <div
              className="border rounded-sm overflow-hidden"
              style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
            >
              {myLeadingBids.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-xs" style={{ color: "var(--color-subtext)" }}>
                    You are not the leading bidder on any open auction.
                  </p>
                  <a
                    href="/auctions"
                    className="mt-2 inline-block text-xs underline"
                    style={{ color: "var(--color-primary)" }}
                  >
                    Browse auctions →
                  </a>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr>
                        <th style={thFirstStyle}>Auction</th>
                        <th style={thStyle}>My Bid</th>
                        <th style={thStyle}>Status</th>
                        <th style={thStyle}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {myLeadingBids.map(({ id, info }) => {
                        if (!info) return null;
                        const bidSymbol = info.zeroForOne ? TOKEN0_SYMBOL : TOKEN1_SYMBOL;
                        return (
                          <tr key={id.toString()}>
                            <td style={tdFirstStyle}>
                              <span className="mono-val font-medium" style={{ color: "var(--color-subtext)" }}>
                                #{id.toString().padStart(4, "0")}
                              </span>
                            </td>
                            <td style={tdStyle}>
                              <span className="mono-val" style={{ color: "var(--color-text)" }}>
                                {formatEther(info.highestBid)} {bidSymbol}
                              </span>
                            </td>
                            <td style={tdStyle}>
                              <BidStatus info={info} address={address} />
                            </td>
                            <td style={tdStyle}>
                              {!info.isCompleted ? (
                                <a
                                  href="/auctions"
                                  className="text-xs underline"
                                  style={{ color: "var(--color-primary)" }}
                                >
                                  {info.auctionOpen ? "Track / raise" : "Execute →"}
                                </a>
                              ) : (
                                <span style={{ color: "var(--color-eyebrow)" }}>Won</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
