"""
MEV Auction Hook — Economic Model
==================================
Models the expected LP revenue boost and trader cost from the auction hook,
across a range of pool volumes and parameter settings.

All assumptions are stated explicitly so they can be challenged.
"""

from dataclasses import dataclass


@dataclass
class PoolParams:
    daily_volume_usd: float      # Total swap volume per day (USD)
    base_fee_bps: float          # Pool's base fee in basis points (e.g. 30 = 0.30%)
    avg_swap_usd: float          # Average swap size (USD)
    informed_flow_pct: float     # Fraction of volume from informed/MEV traders (0-1)
    mev_per_informed_bps: float  # MEV value per informed swap (bps of swap size)


@dataclass
class HookParams:
    threshold_usd: float         # Express lane threshold — swaps below skip auction
    window_blocks: int           # Auction window duration in blocks
    searcher_competition: float  # Fraction of MEV that competitive bidding reaches (0-1)
                                 # Nash equilibrium: searchers bid up to MEV value minus their cost


def simulate(pool: PoolParams, hook: HookParams) -> dict:
    # Total swaps per day
    total_swaps = pool.daily_volume_usd / pool.avg_swap_usd

    # Split into small (express lane) and large (auction)
    # Assume swap sizes are log-normal; threshold separates bottom X% from top Y%
    # Simplified model: swaps below threshold are proportional to threshold / avg
    small_pct = min(hook.threshold_usd / (pool.avg_swap_usd * 3), 0.80)
    large_pct = 1 - small_pct

    large_swaps = total_swaps * large_pct
    large_volume_usd = pool.daily_volume_usd * large_pct

    # Baseline LP revenue from base fee alone
    baseline_lp_daily_usd = pool.daily_volume_usd * (pool.base_fee_bps / 10_000)

    # MEV in large swaps: only informed flow generates exploitable MEV
    # Assume informed flow is concentrated in large swaps (where the value is)
    large_informed_swaps = large_swaps * pool.informed_flow_pct
    mev_per_informed_usd = (pool.avg_swap_usd * large_pct / large_pct) * (pool.mev_per_informed_bps / 10_000)

    total_extractable_mev_usd = large_informed_swaps * mev_per_informed_usd

    # Hook captures a fraction via auction competition
    captured_mev_usd = total_extractable_mev_usd * hook.searcher_competition

    # LP revenue boost
    total_lp_daily_usd = baseline_lp_daily_usd + captured_mev_usd
    lp_revenue_boost_pct = (captured_mev_usd / baseline_lp_daily_usd) * 100

    # Cost to uninformed traders
    # Small swaps: express lane, zero extra cost
    # Large uninformed swaps: no extra cost (they pay base fee; hook execution still happens)
    # The only "cost" is the 3-block delay for large swaps — opportunity cost of the window
    # We model this as negligible (price impact from a 3s delay on Unichain ≈ 0)
    uninformed_extra_cost_bps = 0.0

    # Effective capture rate (what % of extractable MEV becomes LP revenue)
    capture_rate_pct = (captured_mev_usd / total_extractable_mev_usd * 100) if total_extractable_mev_usd > 0 else 0

    return {
        "daily_volume_usd": pool.daily_volume_usd,
        "total_swaps_per_day": total_swaps,
        "large_swaps_per_day": large_swaps,
        "large_volume_pct": large_pct * 100,
        "baseline_lp_daily_usd": baseline_lp_daily_usd,
        "captured_mev_daily_usd": captured_mev_usd,
        "total_lp_daily_usd": total_lp_daily_usd,
        "lp_revenue_boost_pct": lp_revenue_boost_pct,
        "uninformed_extra_cost_bps": uninformed_extra_cost_bps,
        "total_extractable_mev_usd": total_extractable_mev_usd,
        "capture_rate_pct": capture_rate_pct,
    }


def print_results(label: str, pool: PoolParams, hook: HookParams):
    r = simulate(pool, hook)
    print(f"\n{'='*60}")
    print(f"  {label}")
    print(f"{'='*60}")
    print(f"  Pool daily volume:        ${r['daily_volume_usd']:>12,.0f}")
    print(f"  Total swaps/day:          {r['total_swaps_per_day']:>12,.0f}")
    print(f"  Large swaps (auctioned):  {r['large_swaps_per_day']:>12,.0f}  ({r['large_volume_pct']:.1f}% of volume)")
    print(f"  Baseline LP revenue/day:  ${r['baseline_lp_daily_usd']:>12,.2f}")
    print(f"  MEV donated to LPs/day:  ${r['captured_mev_daily_usd']:>12,.2f}")
    print(f"  Total LP revenue/day:     ${r['total_lp_daily_usd']:>12,.2f}")
    print(f"  LP revenue boost:         {r['lp_revenue_boost_pct']:>12.1f}%")
    print(f"  Extra cost to traders:    {r['uninformed_extra_cost_bps']:>12.2f} bps  (uninformed traders pay nothing extra)")
    print(f"  MEV capture rate:         {r['capture_rate_pct']:>12.1f}%  of extractable MEV returned to LPs")


# ── Scenarios ────────────────────────────────────────────────────────────────

# Conservative: small community pool
conservative_pool = PoolParams(
    daily_volume_usd=100_000,
    base_fee_bps=30,
    avg_swap_usd=500,
    informed_flow_pct=0.12,
    mev_per_informed_bps=40,
)

# Realistic: mid-size pool
realistic_pool = PoolParams(
    daily_volume_usd=1_000_000,
    base_fee_bps=30,
    avg_swap_usd=2_000,
    informed_flow_pct=0.15,
    mev_per_informed_bps=50,
)

# High-volume: major pair
highvol_pool = PoolParams(
    daily_volume_usd=10_000_000,
    base_fee_bps=5,
    avg_swap_usd=5_000,
    informed_flow_pct=0.20,
    mev_per_informed_bps=60,
)

hook_params = HookParams(
    threshold_usd=2_500,   # ~1 ETH at $2,500 = express lane for retail
    window_blocks=3,        # 3 seconds on Unichain Sepolia
    searcher_competition=0.75,  # searchers bid 75% of MEV value in competitive market
)

print("\n  MEV AUCTION HOOK — ECONOMIC MODEL")
print("  Assumptions: threshold=$2,500 (1 ETH), window=3 blocks, searcher competition=75%")
print("  Uninformed traders pay zero extra cost — they use the express lane or benefit from LP fee growth")

print_results("Conservative: $100K/day community pool", conservative_pool, hook_params)
print_results("Realistic: $1M/day mid-size pool", realistic_pool, hook_params)
print_results("High-volume: $10M/day major pair (5 bps fee)", highvol_pool, hook_params)

# ── Sensitivity: searcher competition ────────────────────────────────────────
print(f"\n{'='*60}")
print("  SENSITIVITY: LP revenue boost vs searcher competition")
print(f"  (Realistic $1M/day pool)")
print(f"{'='*60}")
for comp in [0.30, 0.50, 0.60, 0.75, 0.90]:
    h = HookParams(threshold_usd=2_500, window_blocks=3, searcher_competition=comp)
    r = simulate(realistic_pool, h)
    print(f"  Competition {comp*100:3.0f}%  →  LP boost {r['lp_revenue_boost_pct']:5.1f}%  |  MEV captured ${r['captured_mev_daily_usd']:,.2f}/day")

# ── Sensitivity: auction window ──────────────────────────────────────────────
print(f"\n{'='*60}")
print("  SENSITIVITY: Effect of auction window duration")
print(f"  (Longer window → more searchers can participate → higher competition)")
print(f"{'='*60}")
window_competition = {3: 0.50, 10: 0.65, 30: 0.75, 100: 0.85, 300: 0.90}
for blocks, comp in window_competition.items():
    h = HookParams(threshold_usd=2_500, window_blocks=blocks, searcher_competition=comp)
    r = simulate(realistic_pool, h)
    print(f"  {blocks:>4} blocks (~{blocks:>4}s)  competition {comp*100:.0f}%  →  LP boost {r['lp_revenue_boost_pct']:5.1f}%")

print()
