/**
 * Fix 4: Single source of truth for validation tolerances and gate logic.
 * Used by validator.ts (extraction-time flags) and products.ts (review-queue gate).
 */

/** Loose tolerances used when flagging rows during extraction. */
export const EXTRACT_TOLERANCE = {
  cartons: 2,
  cbm: 0.5,
  weight_kg: 5,
  amount_rmb: 100,
} as const

/** Tight tolerances used in the review-queue gate before publishing. */
export const GATE_TOLERANCE = {
  cartons: 0.5,
  qty: 0.5,
  cbm: 0.05,
  weight_kg: 1,
  amount_rmb: 5,
} as const

/** Row-level validation flags that block publishing. */
export const BLOCKING_FLAGS = new Set([
  'missing_name',
  'missing_packing',
  'amount_mismatch',
  'price_missing_but_amount_present',
])
