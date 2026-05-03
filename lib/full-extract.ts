import type { ExtractedProduct } from '@/lib/claude-extractor'

/** Synthetic line items used when parse mode is `full` (headings, section banners). */
export const FULL_EXTRACT_ITEM_CODE = '__FULL_EXTRACT__'

/** Marks a yellow section-subtotal bar (CTN+CBM+KGS+¥ rolled-up row, not a real product). */
export const SECTION_SUBTOTAL_ITEM_CODE = '__SECTION_SUBTOTAL__'

export function isFullExtractBanner(p: Pick<ExtractedProduct, 'item_code'>): boolean {
  return p.item_code === FULL_EXTRACT_ITEM_CODE
}

export function isSubtotalBanner(p: Pick<ExtractedProduct, 'item_code'>): boolean {
  return p.item_code === SECTION_SUBTOTAL_ITEM_CODE
}
