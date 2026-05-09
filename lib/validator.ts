import { ExtractedDocument, ExtractedProduct } from './claude-extractor'
import { parseFiniteNumber } from './numeric-parse'
import { EXTRACT_TOLERANCE } from './validation-gate'

export interface ValidationResult {
  totals_match: boolean
  totals_diff: Record<string, number>
  validation_flags: string[]
  row_results: RowValidation[]
  pass_count: number
  flag_count: number
}

export interface RowValidation {
  line_no: number | null
  confidence: number
  flags: string[]
  needs_review: boolean
}

export function validateExtraction(
  document: ExtractedDocument,
  products: ExtractedProduct[],
  /** All extracted products including non-shipped sections.
   * If provided: physical totals (cartons/CBM/weight) use shipped+repacked;
   * amount total uses all sections. Matches how PDF footer totals are computed. */
  allProducts?: ExtractedProduct[]
): ValidationResult {
  const flags: string[] = []
  const totals_diff: Record<string, number> = {}

  // Physical totals (cartons/CBM/weight): footer covers shipped + repacked (not goods-left)
  const physicalProducts = allProducts
    ? allProducts.filter(p => (p.section ?? 'shipped') !== 'left_in_warehouse')
    : products
  // Amount total: footer covers all sections including goods-left
  const amountProducts = allProducts ?? products

  // ── Compute row-level aggregates ──────────────────────────────────────────
  const computedCBM = sumNumeric(physicalProducts, p => p.total_cbm)
  const computedWeight = sumNumeric(physicalProducts, p => p.total_weight_kg)
  const computedAmount = sumNumeric(amountProducts, p => p.total_amount_rmb)
  const computedCartons = sumNumeric(physicalProducts, p => p.total_cartons)

  const ft = document.footer_totals
  const footCbm = parseFiniteNumber(ft.total_cbm)
  const footWeight = parseFiniteNumber(ft.total_weight_kg)
  const footAmount = parseFiniteNumber(ft.total_amount_rmb)
  const footCartons = parseFiniteNumber(ft.total_cartons)

  // ── Checksum diffs ────────────────────────────────────────────────────────
  // When every row lacks per-line CBM/weight, computed sums stay 0 — comparing to the PDF
  // footer would always flag; skip until extraction fills those columns.
  if (footCbm !== null && !(computedCBM <= 0 && footCbm > 0)) {
    const diff = Math.abs(computedCBM - footCbm)
    totals_diff['cbm'] = round(diff)
    if (diff > EXTRACT_TOLERANCE.cbm) flags.push(`CBM mismatch: computed ${round(computedCBM)} vs footer ${footCbm}`)
  }

  if (footWeight !== null && !(computedWeight <= 0 && footWeight > 0)) {
    const diff = Math.abs(computedWeight - footWeight)
    totals_diff['weight_kg'] = round(diff)
    if (diff > EXTRACT_TOLERANCE.weight_kg)
      flags.push(`Weight mismatch: computed ${round(computedWeight)} vs footer ${footWeight}`)
  }

  if (footAmount !== null) {
    const diff = Math.abs(computedAmount - footAmount)
    totals_diff['amount_rmb'] = round(diff)
    if (diff > EXTRACT_TOLERANCE.amount_rmb) flags.push(`Amount mismatch: computed ${round(computedAmount)} vs footer ${footAmount}`)
  }

  if (footCartons !== null) {
    const diff = Math.abs(computedCartons - footCartons)
    totals_diff['cartons'] = round(diff)
    if (diff > EXTRACT_TOLERANCE.cartons) flags.push(`Carton count mismatch: computed ${computedCartons} vs footer ${footCartons}`)
  }

  // ── Document-level checks ─────────────────────────────────────────────────
  if (products.length === 0) flags.push('No products extracted')
  if (products.length < 5) flags.push(`Suspiciously few rows: ${products.length}`)

  // ── Row-level validation ──────────────────────────────────────────────────
  const row_results: RowValidation[] = products.map((p, idx) => {
    const rowFlags: string[] = []

    if (!p.description) rowFlags.push('missing description')
    if (!p.item_code && !p.marks) rowFlags.push('missing item code')
    if (p.unit_price_rmb !== null && p.unit_price_rmb < 0) rowFlags.push('negative unit price')
    if (p.total_amount_rmb !== null && p.total_amount_rmb < 0) rowFlags.push('negative total amount')
    if (p.total_cbm !== null && p.total_cbm < 0) rowFlags.push('negative CBM')
    if (p.total_weight_kg !== null && p.total_weight_kg < 0) rowFlags.push('negative weight')

    // Cross-check: qty × unit_price should roughly equal total_amount
    if (
      p.total_qty !== null &&
      p.unit_price_rmb !== null &&
      p.total_amount_rmb !== null &&
      p.total_qty > 0 &&
      p.unit_price_rmb > 0
    ) {
      const expected = p.total_qty * p.unit_price_rmb
      const diff = Math.abs(expected - p.total_amount_rmb)
      const pct = diff / expected
      if (pct > 0.05) {
        rowFlags.push(`Amount cross-check failed: ${p.total_qty} × ${p.unit_price_rmb} ≠ ${p.total_amount_rmb}`)
      }
    }

    // Confidence scoring
    let confidence = 100
    confidence -= rowFlags.length * 15
    if (!p.description) confidence -= 20
    if (!p.item_code && !p.marks) confidence -= 20
    if (p.total_cbm === null) confidence -= 10
    if (p.unit_price_rmb === null) confidence -= 10
    confidence = Math.max(0, confidence)

    return {
      line_no: p.line_no ?? idx + 1,
      confidence,
      flags: rowFlags,
      needs_review: confidence < 80 || rowFlags.length > 0,
    }
  })

  const pass_count = row_results.filter(r => !r.needs_review).length
  const flag_count = row_results.filter(r => r.needs_review).length
  const totals_match = flags.length === 0

  console.log(`[validator] totals_match: ${totals_match}`)
  console.log(`[validator] document_flags: ${flags.length}`)
  console.log(`[validator] rows_pass: ${pass_count} rows_flag: ${flag_count}`)
  if (flags.length > 0) console.warn('[validator] flags:', flags)

  return {
    totals_match,
    totals_diff,
    validation_flags: flags,
    row_results,
    pass_count,
    flag_count,
  }
}

/** Safe sum: JSON/Live View may surface numbers as strings; mixed types otherwise explode reduce (+). */
function sumNumeric(products: ExtractedProduct[], getter: (p: ExtractedProduct) => unknown): number {
  return products.reduce((acc, p) => acc + (parseFiniteNumber(getter(p)) ?? 0), 0)
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
