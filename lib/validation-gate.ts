/**
 * Single source of truth for extraction validation tolerances.
 * Used by validator.ts when comparing computed line totals to PDF footer totals.
 */

/** Loose tolerances used when flagging rows during extraction. */
export const EXTRACT_TOLERANCE = {
  cartons: 2,
  cbm: 0.5,
  weight_kg: 5,
  amount_rmb: 100,
} as const
