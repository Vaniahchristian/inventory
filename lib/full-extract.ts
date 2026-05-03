import type { ExtractedProduct } from '@/lib/claude-extractor'

/** Synthetic line items used when parse mode is `full` (headings, section banners, subtotal bars). */
export const FULL_EXTRACT_ITEM_CODE = '__FULL_EXTRACT__'

export function isFullExtractBanner(p: Pick<ExtractedProduct, 'item_code'>): boolean {
  return p.item_code === FULL_EXTRACT_ITEM_CODE
}
