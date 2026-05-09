import type { ExtractedProduct } from './claude-extractor'
import { isFooterBanner, isFullExtractBanner, isSubtotalBanner } from './full-extract'

/** Single-line plausible maximums for wholesale kitchenware PDFs (defense against OCR glue). */
export const SALES_ORDER_MAX_LINE_QTY = 500_000
export const SALES_ORDER_MAX_UNIT_PRICE = 50_000
export const SALES_ORDER_MAX_LINE_AMOUNT = 50_000_000
export const SALES_ORDER_MAX_LINE_CARTONS = 50_000
export const SALES_ORDER_MAX_QTY_PER_CARTON = 20_000

const CAP_REMARK = 'repair:capped_absurd_ocr'

/**
 * Null out physically impossible line metrics before DB insert / after HTML parse.
 * Idempotent; safe for every sales-order row (skips synthetic banners).
 */
export function sanitizeSalesOrderProductPhysicalCaps(p: ExtractedProduct): ExtractedProduct {
  if (isFullExtractBanner(p) || isSubtotalBanner(p) || isFooterBanner(p)) return p

  let q = { ...p }
  let capped = false

  const bad = (v: number | null | undefined, max: number, min = 0) =>
    v != null && (v < min || v > max)

  if (bad(q.total_qty, SALES_ORDER_MAX_LINE_QTY)) {
    q.total_qty = null
    capped = true
  }
  if (bad(q.qty_per_carton, SALES_ORDER_MAX_QTY_PER_CARTON)) {
    q.qty_per_carton = null
    capped = true
  }
  if (bad(q.unit_price_rmb, SALES_ORDER_MAX_UNIT_PRICE)) {
    q.unit_price_rmb = null
    capped = true
  }
  if (bad(q.total_amount_rmb, SALES_ORDER_MAX_LINE_AMOUNT)) {
    q.total_amount_rmb = null
    capped = true
  }
  if (bad(q.total_cartons, SALES_ORDER_MAX_LINE_CARTONS)) {
    q.total_cartons = null
    capped = true
  }

  if (capped) {
    const r = (q.remarks ?? '').trim()
    q.remarks = r.includes(CAP_REMARK) ? q.remarks : r ? `${r};${CAP_REMARK}` : CAP_REMARK
    if (q.total_qty == null && q.total_cartons != null && q.total_cartons > 10_000) {
      q.total_cartons = null
    }
  }

  return q
}

export function sanitizeSalesOrderProductsPhysicalCaps(products: ExtractedProduct[]): ExtractedProduct[] {
  return products.map(sanitizeSalesOrderProductPhysicalCaps)
}
