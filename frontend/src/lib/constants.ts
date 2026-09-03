import { getAddress } from "viem";

// Wrap every address with getAddress() to ensure proper EIP-55 checksum at
// runtime regardless of what capitalisation the env var contains.
const addr = (raw: string): `0x${string}` => getAddress(raw);

export const HOOK_ADDRESS = addr(
  process.env.NEXT_PUBLIC_HOOK_ADDRESS ??
  "0xd73e4a0d49c5144e475a4a8f91c051d5b0a00080"
);

export const POOL_KEY = {
  currency0: addr(
    process.env.NEXT_PUBLIC_POOL_CURRENCY0 ??
    "0xd9776ceae2da210ad271df7316a287938dde6565"
  ),
  currency1: addr(
    process.env.NEXT_PUBLIC_POOL_CURRENCY1 ??
    "0xec5ccc8f8dd84cf4a5156692d037e72b65a09c03"
  ),
  fee: Number(process.env.NEXT_PUBLIC_POOL_FEE ?? "3000"),
  tickSpacing: Number(process.env.NEXT_PUBLIC_POOL_TICK_SPACING ?? "60"),
  hooks: addr(
    process.env.NEXT_PUBLIC_HOOK_ADDRESS ??
    "0xd73e4a0d49c5144e475a4a8f91c051d5b0a00080"
  ),
} as const;

export const TOKEN0_SYMBOL = process.env.NEXT_PUBLIC_TOKEN0_SYMBOL ?? "TKNA";
export const TOKEN1_SYMBOL = process.env.NEXT_PUBLIC_TOKEN1_SYMBOL ?? "TKNB";

export const NATIVE_ETH = "0x0000000000000000000000000000000000000000" as `0x${string}`;
