import { getAddress } from "viem";

// Wrap every address with getAddress() to ensure proper EIP-55 checksum at
// runtime regardless of what capitalisation the env var contains.
const addr = (raw: string): `0x${string}` => getAddress(raw);

// Defaults point at the live Unichain Sepolia deployment (chain 1301). Override
// via frontend/.env.local when pointing at your own deployment.
const DEFAULT_HOOK = "0x503c79ce11bc76e7aeeafcbe1db9a19d8d148580";

// The pool's currencies must be in sorted order (currency0 < currency1).
// TKNB (0xC0Da…) sorts below TKNA (0xD490…), so TKNB is currency0.
const DEFAULT_CURRENCY0 = "0xc0dac1ca4ac03140733850e39b0dbd115ec0e5f3"; // TKNB
const DEFAULT_CURRENCY1 = "0xd490dc2cd0b58f6a1c31c3b491eb515a720c93d7"; // TKNA

export const HOOK_ADDRESS = addr(
  process.env.NEXT_PUBLIC_HOOK_ADDRESS ?? DEFAULT_HOOK
);

export const POOL_KEY = {
  currency0: addr(process.env.NEXT_PUBLIC_POOL_CURRENCY0 ?? DEFAULT_CURRENCY0),
  currency1: addr(process.env.NEXT_PUBLIC_POOL_CURRENCY1 ?? DEFAULT_CURRENCY1),
  fee: Number(process.env.NEXT_PUBLIC_POOL_FEE ?? "3000"),
  tickSpacing: Number(process.env.NEXT_PUBLIC_POOL_TICK_SPACING ?? "60"),
  hooks: addr(process.env.NEXT_PUBLIC_HOOK_ADDRESS ?? DEFAULT_HOOK),
} as const;

export const TOKEN0_SYMBOL = process.env.NEXT_PUBLIC_TOKEN0_SYMBOL ?? "TKNB";
export const TOKEN1_SYMBOL = process.env.NEXT_PUBLIC_TOKEN1_SYMBOL ?? "TKNA";

/** Block explorer that has the hook's verified source. */
export const EXPLORER_BASE = "https://sepolia.uniscan.xyz";

export const NATIVE_ETH = "0x0000000000000000000000000000000000000000" as `0x${string}`;
