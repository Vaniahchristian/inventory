/**
 * Shared heuristics for rows that look like PDF footer / financial summary lines
 * but were stored as document_items (older imports). Products page excludes these
 * from main grid subtotals; Compiled Products uses the same filter for parity.
 */

import type { DocumentItem } from '@/lib/types'

export type FooterLikeFields = Pick<DocumentItem, 'marks' | 'description' | 'item_code' | 'shop'>

/** True when the row matches common manifest/PDF footer text patterns. */
export function isFooterLikeItem(p: FooterLikeFields): boolean {
  const combined = [p.marks ?? '', p.description ?? '', p.item_code ?? '', p.shop ?? '']
    .join(' ')
    .toUpperCase()
  if (/\bTOTAL\s+(WEIGHT|CBM|CARTON|COST|BALANCE)\b/.test(combined)) return true
  if (/\b(GOODS\s+BALANCE|CREDIT\s+SUPPORT|PIVOC|EXCHANGE\s+RATE)\b/.test(combined)) return true
  if (/YIWU.{0,10}MOMBASA.{0,10}FREIGHT/i.test(combined)) return true
  if (/\bPAYMENT\b/.test(combined) && /\d{1,2}\/\d{1,2}\/\d{4}/.test(combined)) return true
  if (/\bPAYMENT\b/.test(combined) && /USD/.test(combined) && !/\bPCS\/CTN\b/.test(combined)) return true
  if (/IF\s+OUTSTANDING\s+BALANCE\s+IS\s+NOT\s+PAID/i.test(combined)) return true
  if (/PAYMENT\s+DELAY\s+SURCHARGE/i.test(combined)) return true
  if (/VESSEL\s+ARRIVAL\s+MOMBASA/i.test(combined)) return true
  if (/BALANCE\s+PAYMENT\s+TERMS/i.test(combined)) return true
  if (/REDUCE\s+DETAILS/i.test(combined)) return true
  if (/REDUCE\s+\d+\s*CTN/i.test(combined)) return true
  return false
}
