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

/** Same DEL-shape heuristic as reducto-html-parser (avoid importing parser here). */
function looksLikeYiwuDeliveryNoRef(s: string): boolean {
  const t = s.replace(/\s+/g, '').trim()
  if (!t) return false
  return /^\d{2}C\d{3}-\d+[A-Z0-9-]*$/i.test(t) || /^26C\d{3}-[0-9A-Z-]+$/i.test(t)
}

/**
 * Prefer real manufacturer SKU when OCR swaps DEL vs ITEM NO or puts the row序号 in ITEM NO.
 */
export function resolveSalesOrderSkuFields(
  source_item_no: string | null,
  item_code: string | null
): { item_code: string | null; source_item_no: string | null } {
  if (!source_item_no && !item_code) return { item_code: null, source_item_no: null }
  if (
    item_code &&
    source_item_no &&
    looksLikeYiwuDeliveryNoRef(item_code) &&
    !looksLikeYiwuDeliveryNoRef(source_item_no)
  ) {
    return { item_code: source_item_no, source_item_no: source_item_no }
  }
  if (
    item_code &&
    source_item_no &&
    /^\d{1,4}$/.test(source_item_no) &&
    !/^\d{1,4}$/.test(item_code)
  ) {
    return { item_code: item_code, source_item_no: source_item_no }
  }
  const linked = source_item_no ?? item_code
  return { item_code: linked, source_item_no: source_item_no ?? item_code }
}

