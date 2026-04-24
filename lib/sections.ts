import type { Product } from '@/lib/types'

export const REPACKAGED_SECTION_MARKER_SKU = '__SECTION_REPACKAGED__'
export const REPACKAGED_SECTION_TITLE = 'GOODS STUFFED INTO THIS CONTAINER (REPACKAGED GOODS)'

export function isSectionDividerProduct(product: Pick<Product, 'sku'>): boolean {
  return product.sku === REPACKAGED_SECTION_MARKER_SKU
}

export function isRepackagedSectionHeader(raw: string): boolean {
  const u = raw.toUpperCase()
  return u.includes('GOODS STUFFED INTO THIS CONTAINER') || u.includes('REPACKAGED GOODS')
}
