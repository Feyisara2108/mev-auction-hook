"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatEther, type Hex } from "viem";
import {
  useAccount,
  useChainId,
  useReadContracts,
  useSignMessage,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { GOVERNED_MEV_AUCTION_HOOK_ABI } from "@/lib/abi";
import { HOOK_ADDRESS, POOL_KEY } from "@/lib/constants";
import { useMounted } from "@/lib/useMounted";
import {
  attributionInnerHash,
  bpsToPercent,
  computePoolId,
  encodeAttributionHookData,
} from "@/lib/governance";

function Card({
  title,
  children,
  accent,
}: {
  title: string;
  children: React.ReactNode;
  accent?: string;
}) {
  return (
    <div
      className="rounded-sm border"
      style={{
        borderColor: accent ?? "var(--color-border)",
        backgroundColor: "var(--color-surface)",
      }}
    >
      <div
        className="border-b px-4 py-2.5"
        style={{ borderColor: "var(--color-border)" }}
      >
        <p className="eyebrow" style={{ marginBottom: 0 }}>
          {title}
        </p>
      </div>
      <div className="px-4 py-4">{children}</div>
    </div>
  );
}

function Stat({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <p
        className="mono-val text-lg font-medium leading-tight"
        style={{ color: valueColor ?? "var(--color-text)" }}
      >
        {value}
      </p>
    </div>
  );
}

// Liquidity is a uint128 far beyond Number.MAX_SAFE_INTEGER, so it must be scaled
// as a bigint via formatEther — Number(v) silently corrupts the low digits.
const fmtWeight = (v: bigint | undefined) => {
  if (v === undefined) return "—";
  if (v === 0n) return "0";
  const scaled = parseFloat(formatEther(v));
  return scaled.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

export default function GovernancePage() {
  const { address, isConnected } = useAccount();
  const mounted = useMounted();
  const walletReady = mounted && isConnected;
  const chainId = useChainId();
  const queryClient = useQueryClient();
  const poolId = useMemo(() => computePoolId(), []);

  const { data, refetch } = useReadContracts({
    contracts: [
      {
        address: HOOK_ADDRESS,
        abi: GOVERNED_MEV_AUCTION_HOOK_ABI,
        functionName: "getGovernanceInfo",
        args: [POOL_KEY],
      },
      {
        address: HOOK_ADDRESS,
        abi: GOVERNED_MEV_AUCTION_HOOK_ABI,
        functionName: "lpLiquidity",
        args: address ? [poolId, address] : undefined,
      },
      {
        address: HOOK_ADDRESS,
        abi: GOVERNED_MEV_AUCTION_HOOK_ABI,
        functionName: "hasVoted",
        args: address ? [poolId, address] : undefined,
      },
      {
        address: HOOK_ADDRESS,
        abi: GOVERNED_MEV_AUCTION_HOOK_ABI,
        functionName: "lpVoteBps",
        args: address ? [poolId, address] : undefined,
      },
    ],
    query: { refetchInterval: 12_000 },
  });

  const govInfo = data?.[0]?.result as
    | {
        effectiveLpShareBps: bigint;
        traderRebateBps: bigint;
        totalLiquidity: bigint;
        votingWeight: bigint;
      }
    | undefined;
  const myWeight = data?.[1]?.result as bigint | undefined;
  const iVoted = data?.[2]?.result as boolean | undefined;
  const myVoteBps = data?.[3]?.result as bigint | undefined;

  // ─── Voting ────────────────────────────────────────────────────────────────
  const [pct, setPct] = useState(100);
  const [voteTx, setVoteTx] = useState<Hex | undefined>();
  const [voteErr, setVoteErr] = useState<string | undefined>();
  const { writeContractAsync, isPending: isVotePending } = useWriteContract();
  const { isLoading: isVoteConfirming, isSuccess: isVoteSuccess } =
    useWaitForTransactionReceipt({ hash: voteTx });

  useEffect(() => {
    if (isVoteSuccess) {
      queryClient.invalidateQueries();
      void refetch();
    }
  }, [isVoteSuccess, queryClient, refetch]);

  useEffect(() => {
    if (iVoted && myVoteBps !== undefined) setPct(Number(myVoteBps) / 100);
  }, [iVoted, myVoteBps]);

  async function handleVote() {
    setVoteErr(undefined);
    setVoteTx(undefined);
    const bps = Math.round(pct * 100);
    try {
      const hash = await writeContractAsync({
        address: HOOK_ADDRESS,
        abi: GOVERNED_MEV_AUCTION_HOOK_ABI,
        functionName: "vote",
        args: [POOL_KEY, BigInt(bps)],
      });
      setVoteTx(hash);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setVoteErr(msg.includes("User rejected") ? "Vote rejected." : msg.slice(0, 160));
    }
  }

  // ─── Attribution signature ─────────────────────────────────────────────────
  const { signMessageAsync, isPending: isSigning } = useSignMessage();
  const [attestation, setAttestation] = useState<
    { signature: Hex; hookData: Hex } | undefined
  >();
  const [sigErr, setSigErr] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  async function handleSign() {
    if (!address) return;
    setSigErr(undefined);
    setAttestation(undefined);
    try {
      const raw = attributionInnerHash({ chainId, hook: HOOK_ADDRESS, lp: address });
      const signature = (await signMessageAsync({ message: { raw } })) as Hex;
      setAttestation({
        signature,
        hookData: encodeAttributionHookData(address, signature),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setSigErr(msg.includes("User rejected") ? "Signature rejected." : msg.slice(0, 160));
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  const lpShare = govInfo?.effectiveLpShareBps;
  const rebate = govInfo?.traderRebateBps;
  const noVotesYet = govInfo !== undefined && govInfo.votingWeight === 0n;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <div className="mb-6">
        <p className="eyebrow mb-1">Pool Governance</p>
        <h1 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>
          LPs vote on the MEV revenue split
        </h1>
        <p className="mt-1 text-xs" style={{ color: "var(--color-subtext)" }}>
          Every winning auction bid on this pool is split between a donation to
          in-range LPs and a rebate to the trader. The split is the
          liquidity-weighted average of all LP votes.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {/* Current split */}
        <Card title="Current split" accent="var(--color-primary)">
          <div className="grid grid-cols-2 gap-4">
            <Stat
              label="To liquidity providers"
              value={bpsToPercent(lpShare)}
              valueColor="var(--color-success)"
            />
            <Stat
              label="Rebated to trader"
              value={bpsToPercent(rebate)}
              valueColor="var(--color-info)"
            />
            <Stat label="Tracked liquidity" value={fmtWeight(govInfo?.totalLiquidity)} />
            <Stat label="Voting weight cast" value={fmtWeight(govInfo?.votingWeight)} />
          </div>
          {noVotesYet && (
            <p
              className="mt-3 text-[11px]"
              style={{ color: "var(--color-eyebrow)" }}
            >
              No LP has voted yet — the pool is using the default 100% - to - LP
              split.
            </p>
          )}
        </Card>

        {/* Your position */}
        <Card title="Your position">
          {!walletReady ? (
            <p className="text-xs" style={{ color: "var(--color-subtext)" }}>
              Connect a wallet to see your voting weight.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Your tracked weight" value={fmtWeight(myWeight)} />
              <Stat
                label="Your vote"
                value={iVoted && myVoteBps !== undefined ? bpsToPercent(myVoteBps) : "Not cast"}
                valueColor={iVoted ? "var(--color-text)" : "var(--color-eyebrow)"}
              />
              {myWeight === 0n && (
                <p
                  className="col-span-2 text-[11px]"
                  style={{ color: "var(--color-eyebrow)" }}
                >
                  You have no tracked liquidity in this pool. Add liquidity with a
                  signed attribution (below) for your vote to carry weight. A vote
                  cast now is stored and takes effect the moment weight arrives.
                </p>
              )}
            </div>
          )}
        </Card>

        {/* Cast vote */}
        <Card title="Cast your vote">
          <p className="eyebrow">LP share of each bid</p>
          <div className="mt-2 flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={pct}
              onChange={(e) => setPct(Number(e.target.value))}
              className="flex-1"
              style={{ accentColor: "var(--color-primary)" }}
            />
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                max={100}
                value={pct}
                onChange={(e) =>
                  setPct(Math.max(0, Math.min(100, Number(e.target.value))))
                }
                className="mono-val w-14 text-right text-sm bg-transparent outline-none border rounded-sm px-1.5 py-1"
                style={{ borderColor: "var(--color-border)", color: "var(--color-text)" }}
              />
              <span className="mono-val text-sm" style={{ color: "var(--color-subtext)" }}>
                %
              </span>
            </div>
          </div>
          <p className="mt-2 text-[11px]" style={{ color: "var(--color-eyebrow)" }}>
            {pct}% to LPs · {100 - pct}% rebated to the trader. Your vote is
            weighted by your tracked liquidity.
          </p>

          {voteErr && (
            <p className="mt-2 text-xs mono-val" style={{ color: "var(--color-error)" }}>
              {voteErr}
            </p>
          )}
          {isVoteSuccess && (
            <p className="mt-2 text-xs" style={{ color: "var(--color-success)" }}>
              Vote recorded.
            </p>
          )}

          <button
            onClick={handleVote}
            disabled={!walletReady || isVotePending || isVoteConfirming}
            className="mt-3 w-full py-2.5 text-xs font-semibold rounded-sm transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
            style={{
              background:
                !walletReady || isVotePending || isVoteConfirming
                  ? "var(--color-surface-alt)"
                  : "linear-gradient(135deg, var(--color-primary) 0%, var(--color-info) 100%)",
              color:
                !walletReady || isVotePending || isVoteConfirming
                  ? "var(--color-subtext)"
                  : "#ffffff",
              border: "none",
            }}
          >
            {!walletReady
              ? "Connect wallet to vote"
              : isVotePending
                ? "Confirm in wallet…"
                : isVoteConfirming
                  ? "Confirming…"
                  : iVoted
                    ? "Update vote"
                    : "Submit vote"}
          </button>
        </Card>

        {/* Attribution signature */}
        <Card title="Attribution signature">
          <p className="text-xs" style={{ color: "var(--color-subtext)" }}>
            v4 liquidity is added through the PositionManager, so the hook cannot
            see who the LP is. Sign this one-time attestation and pass the
            resulting <span className="mono-val">hookData</span> when you add
            liquidity — the hook verifies it and credits the voting weight to you.
            The signature is bound to this chain, hook and pool; it is safe to
            reuse for every deposit.
          </p>

          {sigErr && (
            <p className="mt-2 text-xs mono-val" style={{ color: "var(--color-error)" }}>
              {sigErr}
            </p>
          )}

          <button
            onClick={handleSign}
            disabled={!walletReady || isSigning}
            className="mt-3 w-full py-2.5 text-xs font-semibold rounded-sm transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
            style={{
              background: "var(--color-surface-alt)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          >
            {!walletReady
              ? "Connect wallet to sign"
              : isSigning
                ? "Sign in wallet…"
                : "Sign attribution"}
          </button>

          {attestation && (
            <div className="mt-3 flex flex-col gap-2">
              <div>
                <p className="eyebrow">hookData</p>
                <p
                  className="mono-val text-[10px] break-all leading-relaxed"
                  style={{ color: "var(--color-subtext)" }}
                >
                  {attestation.hookData}
                </p>
              </div>
              <button
                onClick={() => copy(attestation.hookData)}
                className="self-start text-[11px] mono-val px-2 py-1 rounded-sm border"
                style={{
                  borderColor: "var(--color-border)",
                  color: "var(--color-primary)",
                }}
              >
                {copied ? "Copied" : "Copy hookData"}
              </button>
              <p className="text-[11px]" style={{ color: "var(--color-eyebrow)" }}>
                Use this as the <span className="mono-val">hookData</span> argument
                of your add-liquidity call, or export{" "}
                <span className="mono-val">PRIVATE_KEY</span> and run{" "}
                <span className="mono-val">script/14_AddLiquidityGoverned.s.sol</span>
                , which produces the same signature.
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
