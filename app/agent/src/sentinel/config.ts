/**
 * Configurable screening thresholds (FR-11). Defaults are conservative
 * screens, not investment advice. Override with SENTINEL_THRESHOLDS_JSON.
 */
export interface Thresholds {
  vol_high: number;
  vol_medium: number;
  drawdown_high: number;
  drawdown_medium: number;
  beta_high: number;
  beta_medium: number;
  pe_high: number;
  pe_medium: number;
  ps_high: number;
  net_debt_to_fcf_high: number;
  below_sma200_pct: number;
  /** Beta-implied loss in a −20% market above which the position needs review. */
  stress_loss_review: number;
  price_stale_days: number;
  fundamentals_stale_days: number;
  premium_discount_medium: number;
  premium_discount_high: number;
  premium_discount_critical: number;
  backing_ratio_medium: number;
  backing_ratio_critical: number;
  supply_conflict_pct: number;
  feed_stale_days: number;
  /** Monitoring defaults. */
  monitor_price_down_pct: number;
  monitor_price_up_pct: number;
  monitor_yield_move_pp: number;
  monitor_supply_move_pct: number;
  monitor_premium_move: number;
  /** Drawdown-from-high increase (fraction) that triggers reassessment. */
  monitor_drawdown_pp: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  vol_high: 0.5,
  vol_medium: 0.35,
  drawdown_high: 0.4,
  drawdown_medium: 0.25,
  beta_high: 1.6,
  beta_medium: 1.3,
  pe_high: 60,
  pe_medium: 40,
  ps_high: 20,
  net_debt_to_fcf_high: 4,
  below_sma200_pct: 0.1,
  stress_loss_review: 0.35,
  price_stale_days: 5,
  fundamentals_stale_days: 200,
  premium_discount_medium: 0.02,
  premium_discount_high: 0.05,
  premium_discount_critical: 0.1,
  backing_ratio_medium: 0.995,
  backing_ratio_critical: 0.9,
  supply_conflict_pct: 0.5,
  feed_stale_days: 4,
  monitor_price_down_pct: 10,
  monitor_price_up_pct: 15,
  monitor_yield_move_pp: 0.25,
  monitor_supply_move_pct: 5,
  monitor_premium_move: 0.02,
  monitor_drawdown_pp: 0.1,
};

export function loadThresholds(raw = process.env.SENTINEL_THRESHOLDS_JSON): Thresholds {
  if (!raw) return { ...DEFAULT_THRESHOLDS };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...DEFAULT_THRESHOLDS };
    for (const [k, v] of Object.entries(parsed)) {
      if (k in out && typeof v === "number" && Number.isFinite(v)) (out as unknown as Record<string, number>)[k] = v;
    }
    return out;
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}
