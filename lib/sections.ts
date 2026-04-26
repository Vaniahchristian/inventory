import type { Product } from '@/lib/types'

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

export function isRepackagedSectionHeader(raw: string): boolean {
  const u = raw.toUpperCase()
  return u.includes('GOODS STUFFED INTO THIS CONTAINER') || u.includes('REPACKAGED GOODS')
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
  const compact = raw.toUpperCase().replace(/\s+/g, '')
  return compact.includes('GOODSLEFTINSANCARGO')
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
