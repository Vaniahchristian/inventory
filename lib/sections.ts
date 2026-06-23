import type { ExtractedProduct } from '@/lib/claude-extractor'
import type { Product } from '@/lib/types'

/** Ship-to-inventory rows only: exclude GOODS LEFT IN SANCARGO and REPACKED GOODS sections. */
export function shouldPublishExtractedProduct(section: ExtractedProduct['section'] | undefined): boolean {
  const s = (section ?? 'shipped').toLowerCase()
  return s !== 'left_in_warehouse' && s !== 'repacked'
}

export function filterToInventoryProducts(products: ExtractedProduct[]): ExtractedProduct[] {
  return products.filter(p => shouldPublishExtractedProduct(p.section))
}

export type ManifestSectionBucket = 'shipped' | 'left_in_warehouse' | 'repacked' | 'other'

/**
 * Same rule as Products page `groupedSections`: DB enum is shipped | left_in_warehouse |
 * repacked | other. `other` is the bucket for a section heading the import classifier
 * couldn't recognize — kept separate rather than guessed into one of the 3 known buckets.
 * Anything else unrecognized (including null) still folds into **shipped**.
 */
export function canonicalSectionForGrouping(section: string | null | undefined): ManifestSectionBucket {
  const s = section ?? 'shipped'
  if (s === 'left_in_warehouse') return 'left_in_warehouse'
  if (s === 'repacked') return 'repacked'
  if (s === 'other') return 'other'
  if (s === 'shipped') return 'shipped'
  return 'shipped'
}

/** Rows that contribute to Products “shipped” yellow subtotal rows (excludes only left + repacked). */
export function isProductsShippedSubtotalBucket(section: string | null | undefined): boolean {
  return canonicalSectionForGrouping(section) === 'shipped'
}

/** Compiled Products: include shipped, repacked, and legacy/unknown sections — exclude only goods left in warehouse. */
export function isCompiledProductsInclusionSection(section: string | null | undefined): boolean {
  const s = (section ?? '').trim().toLowerCase()
  if (!s) return true
  return s !== 'left_in_warehouse'
}

/** Rows in the “goods left in warehouse” block (Products sky section). */
export function isWarehouseLeftSection(section: string | null | undefined): boolean {
  return (section ?? '').trim().toLowerCase() === 'left_in_warehouse'
}

/**
 * Remove rows that are section subtotals or grand totals mistakenly returned as products.
 * A row with no description, no item_code, and no marks has no product identity —
 * it is a bare total row and should be excluded.
 * Value-based heuristics are intentionally avoided: the PDF is the source of truth,
 * and a row with an item code is always a product regardless of its numeric values.
 */
export function dropTotalRows(products: ExtractedProduct[]): ExtractedProduct[] {
  return products.filter(p => {
    const hasNoIdentifier = !p.description?.trim() && !p.item_code?.trim() && !p.marks?.trim()
    if (hasNoIdentifier && (p.total_cartons ?? 0) > 0) return false
    return true
  })
}

export const REPACKAGED_SECTION_MARKER_SKU = '__SECTION_REPACKAGED__'
export const REPACKAGED_SECTION_TITLE = 'GOODS STUFFED INTO THIS CONTAINER (REPACKAGED GOODS)'
export const STAGE_SECTION_MARKER_PREFIX = '__SECTION_STAGE__:'
export const STAGE_TOTAL_MARKER_PREFIX = '__SECTION_STAGE_TOTAL__:'

export function isSectionDividerProduct(product: Pick<Product, 'sku'>): boolean {
  const sku = product.sku ?? ''
  return (
    sku === REPACKAGED_SECTION_MARKER_SKU ||
    sku.startsWith(STAGE_SECTION_MARKER_PREFIX) ||
    sku.startsWith(STAGE_TOTAL_MARKER_PREFIX)
  )
}

/** Generic stuffed-container banner line. */
export function isStuffedContainerHeader(raw: string): boolean {
  const u = raw.toUpperCase()
  const normalized = u.replace(/\s+/g, ' ').trim()
  const compact = normalized.replace(/[^A-Z0-9]/g, '')
  return (
    u.includes('GOODS STUFFED INTO THIS CONTAINER') ||
    u.includes('GOODS STUFFED INTO THIS CO') ||
    u.includes('STUFFED INTO THIS CONTAINER') ||
    u.includes('STUFFED INTO THIS CO') ||
    compact.includes('GOODSHASBEENSTUFFEDINTOTHISCO') ||
    compact.includes('GOODSHASBEENSTUFFEDINTOTHISCONTAINER')
  )
}

/** Repacked-only banner, e.g. "... STUFFED INTO THIS CONTAINER(REPACKED GOODS)". */
export function isRepackagedSectionHeader(raw: string): boolean {
  const u = raw.toUpperCase()
  if (!isStuffedContainerHeader(raw)) return false
  return (
    u.includes('REPACKAGED GOODS') ||
    u.includes('REPACKED GOODS') ||
    /\bREPACK(?:ED|AGED)?\b/.test(u)
  )
}

/**
 * Unknown section banner fallback:
 * - looks like a section delimiter row (few non-empty cells, no row-level metrics),
 * - but does not match known section detectors.
 */
export function isUnknownSectionBanner(raw: string): boolean {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return false
  if (isNewOrderSectionHeader(text)) return false
  if (isBeforeGoodsHeader(text)) return false
  if (isGoodsLeftHeader(text)) return false
  if (isStuffedContainerHeader(text)) return false
  if (isRepackagedSectionHeader(text)) return false
  // Collapsed table row / pricing line mistaken for a banner (e.g. MAG-512… ¥ … 295-366).
  if (/¥|￥/.test(text) && (/\bCBM\b|\bKGS\b/i.test(text) || /\d+\s*-\s*\d+\s*$/.test(text))) return false
  if (/MAG-\d{3}-\d+|MS-\d{3}-\d+/i.test(text) && (/¥|￥/.test(text) || /\bCBM\b|\bKGS\b/i.test(text))) return false

  const upper = text.toUpperCase()
  if (/^\d{1,4}\s/.test(upper)) {
    const tokens = upper.split(/\s+/).filter(Boolean)
    let numericTailLen = 0
    for (let i = tokens.length - 1; i >= 0 && numericTailLen < 5; i--) {
      if (/^\d+(?:\.\d+)?$/.test(tokens[i]!)) numericTailLen++
      else break
    }
    if (numericTailLen >= 3) return false
  }

  const wordCount = upper.split(' ').filter(Boolean).length
  const hasMetricTokens = /\b(PCS\/CTN|CTNS?|CBM|KGS?|USD|RMB)\b/.test(upper)
  const alphaHeavy = /[A-Z\u4E00-\u9FFF]/.test(upper)

  if (!alphaHeavy) return false
  if (hasMetricTokens) return false
  return wordCount >= 2 && wordCount <= 18
}

/** Banner row "NEW ORDER" (possibly repeated across merged cells) — labels the main table block, not a product. */
export function isNewOrderSectionHeader(raw: string): boolean {
  const joined = raw.replace(/\s+/g, ' ').trim()
  if (!joined || !/\bNEW\s+ORDERS?\b/i.test(joined)) return false
  const remainder = joined.replace(/\bNEW\s+ORDERS?\b/gi, '').replace(/[\s.:—\-_]/g, '').trim()
  return remainder.length === 0
}

/** Historical carry-over section before current order block (e.g. "BEFORE GOODS MAG-4"). */
export function isBeforeGoodsHeader(raw: string): boolean {
  const u = raw.toUpperCase().replace(/\s+/g, ' ').trim()
  if (!u) return false
  if (/\bBEFORE\s+GOODS\b/.test(u)) return true
  return false
}

export function extractStageSectionHeader(raw: string): string | null {
  const line = raw.replace(/\s+/g, ' ').trim()
  // Keep only concrete stage headers like:
  // "37-T-1 18 CTN GOODS STUFFED INTO THIS CONTAINER(REPACKED GOODS)"
  const m = line.match(
    /\b([A-Z0-9-]+)\s+(\d+)\s*CTN\S*\s+GOODS\s+STUFFED\s+INTO\s+THIS\s+CONTAINER(?:\s*\((?:REPACKED|REPACKAGED)\s+GOODS\))?/i
  )
  if (!m) return null
  return `${m[1]} ${m[2]} CTN GOODS STUFFED INTO THIS CONTAINER(REPACKED GOODS)`
}

export function isGoodsLeftHeader(raw: string): boolean {
  const u = raw.toUpperCase()
  const compact = u.replace(/\s+/g, '')
  if (compact.includes('GOODSLEFTINSANCARGO')) return true
  if (/\bGOODS\s+LEFT\b/.test(raw) && /\bSANCARGO\b/i.test(raw)) return true
  if (/\bLEFT\s+IN\s+WAREHOUSE\b/i.test(u)) return true
  if (/\bGOODS\s+LEFT\s+IN\s+WAREHOUSE\b/i.test(u)) return true
  return false
}

export function makeStageSectionSku(title: string): string {
  return `${STAGE_SECTION_MARKER_PREFIX}${title.trim()}`
}

export function makeStageTotalSku(totalLine: string): string {
  return `${STAGE_TOTAL_MARKER_PREFIX}${totalLine.trim()}`
}

export function parseSectionMarkerTitle(sku: string | null): string | null {
  if (!sku) return null
  if (sku.startsWith(STAGE_SECTION_MARKER_PREFIX)) return sku.slice(STAGE_SECTION_MARKER_PREFIX.length)
  if (sku.startsWith(STAGE_TOTAL_MARKER_PREFIX)) return sku.slice(STAGE_TOTAL_MARKER_PREFIX.length)
  if (sku === REPACKAGED_SECTION_MARKER_SKU) return REPACKAGED_SECTION_TITLE
  return null
}

export function isValidStageSectionTitle(title: string): boolean {
  const t = title.replace(/\s+/g, ' ').trim().toUpperCase()
  if (t.length < 12 || t.length > 180) return false
  return t.includes('GOODS STUFFED INTO THIS CONTAINER')
}

function parseSectionLabelFromRemarks(remarks: string | null | undefined): string | null {
  const raw = (remarks ?? '').split(';').map(s => s.trim()).find(s => s.startsWith('section_label:'))
  if (!raw) return null
  const encoded = raw.slice('section_label:'.length)
  try {
    const decoded = decodeURIComponent(encoded).trim()
    return decoded || null
  } catch {
    return encoded || null
  }
}

/**
 * Database constraint on document_items.section currently allows only:
 * shipped | left_in_warehouse | repacked | other.
 * Keep dynamic labels in remarks, but normalize stored section to one
 * of the allowed values to avoid insert failures.
 */
export function normalizeSectionForStorage(
  section: string | null | undefined,
  remarks?: string | null
): 'shipped' | 'left_in_warehouse' | 'repacked' | 'other' {
  const s = (section ?? '').trim().toLowerCase()
  if (s === 'shipped' || s === 'left_in_warehouse' || s === 'repacked' || s === 'other') return s

  const label = ((parseSectionLabelFromRemarks(remarks) ?? '') + ' ' + (remarks ?? '')).toLowerCase()
  if (label.includes('before goods') || label.includes('goods left') || label.includes('warehouse')) {
    return 'left_in_warehouse'
  }
  if (label.includes('repacked') || label.includes('stuffed into this container')) {
    return 'repacked'
  }
  return 'shipped'
}
