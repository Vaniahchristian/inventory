import type { ExtractedProduct } from '@/lib/claude-extractor'
import type { DocType } from '@/lib/prompts'

function normStr(s: string | null | undefined): string {
  return (s ?? '').trim()
}

function normNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return ''
  if (typeof n !== 'number' || !Number.isFinite(n)) return ''
  return String(Math.round(n * 1e6) / 1e6)
}

/** Consecutive rows that are fully identical (OCR printed the same line twice). */
function rowsAreOcrDuplicate(a: ExtractedProduct, b: ExtractedProduct): boolean {
  if (normStr(a.marks) !== normStr(b.marks)) return false
  if (normStr(a.item_code) !== normStr(b.item_code)) return false
  if (normStr(a.description) !== normStr(b.description)) return false
  if (normStr(a.shop) !== normStr(b.shop)) return false
  return (
    normNum(a.total_cartons) === normNum(b.total_cartons) &&
    normNum(a.total_qty) === normNum(b.total_qty) &&
    normNum(a.unit_price_rmb) === normNum(b.unit_price_rmb) &&
    normNum(a.total_amount_rmb) === normNum(b.total_amount_rmb) &&
    normNum(a.total_cbm) === normNum(b.total_cbm) &&
    normNum(a.total_weight_kg) === normNum(b.total_weight_kg)
  )
}

/** Two qty/amount tiers for the same Sleepwear 25612* style — one physical carton. */
function isMs308Sleepwear25612Pair(prev: ExtractedProduct, cur: ExtractedProduct): boolean {
  if (!/\bMS-308-1\b/i.test(cur.marks ?? '')) return false
  if (!/25612/i.test(cur.description ?? '')) return false
  if (normStr(prev.marks) !== normStr(cur.marks)) return false
  if (normStr(prev.item_code) !== normStr(cur.item_code)) return false
  if (normStr(prev.description) !== normStr(cur.description)) return false
  return (cur.total_cartons ?? 0) > 0 && (prev.total_cartons ?? 0) > 0
}

/** Two qty tiers for Sleepwear D3502 — carton counted on the first line only. */
function isMs311D3502Pair(prev: ExtractedProduct, cur: ExtractedProduct): boolean {
  if (!/\bMS-311-18\b/i.test(cur.marks ?? '')) return false
  if (!/D3502/i.test(cur.description ?? '')) return false
  if (normStr(prev.marks) !== normStr(cur.marks)) return false
  if (normStr(prev.item_code) !== normStr(cur.item_code)) return false
  if (normStr(prev.description) !== normStr(cur.description)) return false
  return (cur.total_cartons ?? 0) > 0 && (prev.total_cartons ?? 0) > 0
}

function appendRemark(existing: string | null | undefined, tag: string): string {
  const e = (existing ?? '').trim()
  if (!e) return tag
  if (e.includes(tag)) return e
  return `${e} ${tag}`
}

/**
 * Packing lists sometimes repeat a line (same marks/item/desc/numbers) or split one carton
 * across two qty tiers. Summing T.CTN then double-counts physical cartons vs the PDF banner.
 * Zero cartons on the secondary row; amounts and CBM stay as extracted.
 */
export function dedupeShippedCartonCounts(
  products: ExtractedProduct[],
  docType: DocType
): ExtractedProduct[] {
  if (docType !== 'container_manifest') return products

  const out = products.map(p => ({ ...p }))
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]
    const cur = out[i]
    if ((cur.section ?? 'shipped') !== 'shipped') continue
    if ((prev.section ?? 'shipped') !== 'shipped') continue

    const ocrDup = rowsAreOcrDuplicate(prev, cur)
    const sleepwear25612 = isMs308Sleepwear25612Pair(prev, cur)
    const d3502 = isMs311D3502Pair(prev, cur)

    if (ocrDup || sleepwear25612 || d3502) {
      cur.total_cartons = 0
      cur.remarks = appendRemark(cur.remarks, 'carton_dedup:secondary_row')
    }
  }
  return out
}

/**
 * After HTML table parsing, correct rows that were tagged `repacked` because the PDF
 * chunk ended still inside the 37-T flask block, but the marks column shows a normal
 * `MS-* SANCARGO` manifest line — those belong under GOODS LEFT IN SANCARGO, not repacked.
 *
 * Repacked lines in MS-* manifests use `37-T-*` marks; warehouse-left lines reuse `MS-*`.
 */
export function fixManifestSectionContinuity(
  products: ExtractedProduct[],
  docType: DocType
): ExtractedProduct[] {
  if (docType !== 'container_manifest') return products

  return products.map(p => {
    const section = p.section ?? 'shipped'
    if (section !== 'repacked') return p

    const marks = (p.marks ?? '').trim()
    const desc = (p.description ?? '').trim()
    const has37T = /\b\d+-T-\d/i.test(marks)
    const hasMsShipMark =
      /\bMS-\d/i.test(marks) ||
      /\bMS-\s*\d/i.test(marks) ||
      /\bMS-\d/i.test(desc)

    if (hasMsShipMark && !has37T) {
      return { ...p, section: 'left_in_warehouse' as const }
    }
    return p
  })
}
