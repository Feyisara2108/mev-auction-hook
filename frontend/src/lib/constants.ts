// Deployed on Unichain Sepolia (chain ID 1301)
// Override any value via NEXT_PUBLIC_* env vars in .env.local

export const HOOK_ADDRESS = (
  process.env.NEXT_PUBLIC_HOOK_ADDRESS ??
  "0xd73e4A0D49c5144e475a4a8f91c051d5b0a00080"
) as `0x${string}`;

// Pool key — currency0 must be < currency1 (address-sorted)
// TKNA: 0xd9776ceae2da210ad271df7316a287938dde6565
// TKNB: 0xec5ccc8f8dd84cf4a5156692d037e72b65a09c03
export const POOL_KEY = {
  currency0: (
    process.env.NEXT_PUBLIC_POOL_CURRENCY0 ??
    "0xd9776ceae2da210ad271df7316a287938dde6565"
  ) as `0x${string}`,
  currency1: (
    process.env.NEXT_PUBLIC_POOL_CURRENCY1 ??
    "0xec5ccc8f8dd84cf4a5156692d037e72b65a09c03"
  ) as `0x${string}`,
  fee: Number(process.env.NEXT_PUBLIC_POOL_FEE ?? "3000"),
  tickSpacing: Number(process.env.NEXT_PUBLIC_POOL_TICK_SPACING ?? "60"),
  hooks: (
    process.env.NEXT_PUBLIC_HOOK_ADDRESS ??
    "0xd73e4A0D49c5144e475a4a8f91c051d5b0a00080"
  ) as `0x${string}`,
} as const;

// Display symbols for currency0 and currency1
export const TOKEN0_SYMBOL = process.env.NEXT_PUBLIC_TOKEN0_SYMBOL ?? "TKNA";
export const TOKEN1_SYMBOL = process.env.NEXT_PUBLIC_TOKEN1_SYMBOL ?? "TKNB";

// Native ETH sentinel
export const NATIVE_ETH = "0x0000000000000000000000000000000000000000" as `0x${string}`;
