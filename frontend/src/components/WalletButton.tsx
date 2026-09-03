"use client";

import { useEffect, useState } from "react";
import { useAccount, useChainId, useConnect, useDisconnect } from "wagmi";
import { unichainSepolia, anvil } from "wagmi/chains";

const CHAIN_LABELS: Record<number, string> = {
  [unichainSepolia.id]: "Unichain Sepolia",
  [anvil.id]: "Local",
};

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();

  // wagmi restores a previous connection on the client only, so rendering the
  // connected view during SSR/first paint produces a hydration mismatch. Hold the
  // disconnected view until after mount, then swap.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const chainLabel = CHAIN_LABELS[chainId] ?? `Chain ${chainId}`;
  const isWrongNetwork = isConnected && !CHAIN_LABELS[chainId];

  if (mounted && isConnected && address) {
    return (
      <div className="flex items-center gap-1.5">
        {/* Network pill */}
        <span
          className="mono-val inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] border"
          style={{
            borderColor: isWrongNetwork
              ? "color-mix(in srgb, var(--color-error) 30%, transparent)"
              : "var(--color-border)",
            color: isWrongNetwork ? "var(--color-error)" : "var(--color-subtext)",
            backgroundColor: "var(--color-surface)",
          }}
        >
          <span
            className="size-1 rounded-full"
            style={{
              backgroundColor: isWrongNetwork
                ? "var(--color-error)"
                : "var(--color-success)",
            }}
          />
          {isWrongNetwork ? "Wrong Network" : chainLabel}
        </span>

        {/* Address pill */}
        <button
          onClick={() => disconnect()}
          className="mono-val inline-flex items-center rounded px-2 py-0.5 text-[10px] border transition-colors"
          title="Disconnect"
          style={{
            borderColor: "var(--color-border)",
            color: "var(--color-subtext)",
            backgroundColor: "var(--color-surface)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "var(--color-text)";
            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--color-border-hi)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "var(--color-subtext)";
            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--color-border)";
          }}
        >
          {address.slice(0, 6)}…{address.slice(-4)}
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => connect({ connector: connectors[0] })}
      disabled={isPending}
      className="rounded px-3 py-1.5 text-xs font-medium transition-colors border"
      style={{
        borderColor: "var(--color-primary)",
        color: "var(--color-primary)",
        backgroundColor: "transparent",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.backgroundColor =
          "color-mix(in srgb, var(--color-primary) 10%, transparent)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
      }}
    >
      {isPending ? "Connecting…" : "Connect Wallet"}
    </button>
  );
}
