import {
  encodeAbiParameters,
  keccak256,
  type Hex,
} from "viem";
import { POOL_KEY } from "./constants";

export const BPS_DENOMINATOR = 10_000;
export const BPS_DENOMINATOR_BI = 10_000n;

/** Basis points (0..10000) -> percent string, e.g. 6000 -> "60%". */
export function bpsToPercent(bps: bigint | number | undefined, digits = 0): string {
  if (bps === undefined) return "—";
  return `${(Number(bps) / 100).toFixed(digits)}%`;
}

const POOL_KEY_TUPLE = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

/**
 * Mirrors v4 `PoolId.toId()` — keccak256 of the ABI-encoded PoolKey struct
 * (5 words, non-packed).
 */
export function computePoolId(): Hex {
  return keccak256(encodeAbiParameters([POOL_KEY_TUPLE], [POOL_KEY]));
}

/**
 * The inner hash an LP signs for `GovernedMevAuctionHook`. The contract wraps
 * this with the EIP-191 personal-sign prefix (`MessageHashUtils.toEthSignedMessageHash`),
 * so signing it with `signMessage({ message: { raw } })` produces a signature the
 * hook accepts.
 *
 * digest = keccak256(abi.encode(chainId, hookAddress, poolId, lp))
 */
export function attributionInnerHash(params: {
  chainId: number | bigint;
  hook: Hex;
  lp: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "chainId", type: "uint256" },
        { name: "hook", type: "address" },
        { name: "poolId", type: "bytes32" },
        { name: "lp", type: "address" },
      ],
      [BigInt(params.chainId), params.hook, computePoolId(), params.lp],
    ),
  );
}

/** `hookData` blob to pass on an add-liquidity call: abi.encode(lp, signature). */
export function encodeAttributionHookData(lp: Hex, signature: Hex): Hex {
  return encodeAbiParameters(
    [
      { name: "lp", type: "address" },
      { name: "signature", type: "bytes" },
    ],
    [lp, signature],
  );
}
