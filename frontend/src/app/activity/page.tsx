"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatEther, zeroAddress } from "viem";
import {
  useAccount,
  useBlockNumber,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { MEV_AUCTION_HOOK_ABI } from "@/lib/abi";
import { HOOK_ADDRESS, TOKEN0_SYMBOL, TOKEN1_SYMBOL } from "@/lib/constants";

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
}: {
  requestId: bigint;
  currencyAddress: `0x${string}`;
  amount: bigint;
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

  const symbol = currencyAddress === zeroAddress ? TOKEN0_SYMBOL : TOKEN1_SYMBOL;

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

  const { data: ethRefund } = useReadContract({
    address: HOOK_ADDRESS,
    abi: MEV_AUCTION_HOOK_ABI,
    functionName: "pendingRefunds",
    args: address ? [address, zeroAddress] : undefined,
    query: { enabled: !!address, refetchInterval: 5000 },
  });

  if (!isConnected || !address) {
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

  const myBids = allInfos
    .filter(
      (a) =>
        a.info !== undefined &&
        a.info.highestBidder.toLowerCase() === address.toLowerCase() &&
        a.info.sender.toLowerCase() !== address.toLowerCase()
    )
    .reverse();

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

          {/* ── My Bids ─────────────────────────────────────── */}
          <section>
            <p className="eyebrow mb-3">My Bids</p>
            <div
              className="border rounded-sm overflow-hidden"
              style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
            >
              {myBids.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-xs" style={{ color: "var(--color-subtext)" }}>No bids placed yet.</p>
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
                        <th style={thStyle}>Refund Available</th>
                        <th style={thStyle}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {myBids.map(({ id, info }) => {
                        if (!info) return null;
                        const isNotWinner =
                          info.highestBidder.toLowerCase() !== address.toLowerCase();
                        const refund = isNotWinner && ethRefund ? ethRefund : 0n;
                        const hasRefund = refund > 0n;
                        const isWinner =
                          info.highestBidder.toLowerCase() === address.toLowerCase();

                        return (
                          <tr key={id.toString()}>
                            <td style={tdFirstStyle}>
                              <span className="mono-val font-medium" style={{ color: "var(--color-subtext)" }}>
                                #A-{id.toString().padStart(4, "0")}
                              </span>
                            </td>
                            <td style={tdStyle}>
                              <span className="mono-val" style={{ color: "var(--color-text)" }}>
                                {info.highestBid > 0n
                                  ? `${formatEther(info.highestBid)} ${TOKEN0_SYMBOL}`
                                  : "—"}
                              </span>
                            </td>
                            <td style={tdStyle}>
                              <BidStatus info={info} address={address} />
                            </td>
                            <td style={tdStyle}>
                              {hasRefund ? (
                                <span className="mono-val" style={{ color: "var(--color-amber)" }}>
                                  {formatEther(refund)} {TOKEN0_SYMBOL}
                                </span>
                              ) : (
                                <span style={{ color: "var(--color-eyebrow)" }}>—</span>
                              )}
                            </td>
                            <td style={tdStyle}>
                              {hasRefund ? (
                                <WithdrawButton
                                  requestId={id}
                                  currencyAddress={zeroAddress}
                                  amount={refund}
                                />
                              ) : isWinner && !info.isCompleted ? (
                                <a
                                  href="/auctions"
                                  className="text-xs underline"
                                  style={{ color: "var(--color-primary)" }}
                                >
                                  Increase Bid
                                </a>
                              ) : null}
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
