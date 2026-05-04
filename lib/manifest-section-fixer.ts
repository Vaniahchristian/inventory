import type { ExtractedProduct } from '@/lib/claude-extractor'
import type { DocType } from '@/lib/prompts'

/** Two lines that share one physical carton usually have T.CBM within this band. */
const SPLIT_TIER_CBM_MAX_DIFF = 0.06

/**
 * When HTML rowspan drops MARKS on the 2nd line, parsers sometimes put T.QTY "100pcs"
 * into T.CTN — high carton count with no loaded volume/weight on that row.
 */
const PHANTOM_CTN_MIN = 20
const VOLUME_EPS = 1e-4

function normStr(s: string | null | undefined): string {
  return (s ?? '').trim()
}

function normNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return ''
  if (typeof n !== 'number' || !Number.isFinite(n)) return ''
  return String(Math.round(n * 1e6) / 1e6)
}

function isNearZeroVolume(n: number | null | undefined): boolean {
  if (n === null || n === undefined) return true
  if (typeof n !== 'number' || !Number.isFinite(n)) return true
  return Math.abs(n) < VOLUME_EPS
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

/**
 * HTML `rowspan` on MARKS/ITEM: the next table row often repeats QTY/amount for the same
 * carton (second tier). Detect by missing marks or repeated marks with blank description.
 */
function isRowspanContinuationSplit(prev: ExtractedProduct, cur: ExtractedProduct): boolean {
  if (normStr(prev.marks) === '') return false
  const prevShop = normStr(prev.shop)
  const curShop = normStr(cur.shop)
  // Rowspan continuations often leave SHOP blank on the second line.
  if (prevShop !== '' && curShop !== '' && prevShop !== curShop) return false
  if ((cur.total_cartons ?? 0) <= 0 || (prev.total_cartons ?? 0) <= 0) return false

  const curMarks = normStr(cur.marks)
  const prevMarks = normStr(prev.marks)
  const curDesc = normStr(cur.description)
  const prevDesc = normStr(prev.description)

  if (curMarks === '') return true

  if (curMarks === prevMarks && curDesc === '' && prevDesc !== '') return true

  const curIc = normStr(cur.item_code)
  const prevIc = normStr(prev.item_code)
  if (curMarks === prevMarks && curIc === '' && prevIc !== '' && curDesc === '' && prevDesc !== '')
    return true

  return false
}

/**
 * Same product line printed twice for two price/qty tiers but one physical carton
 * (e.g. two pc counts, same style). Require similar CBM so we do not merge distinct cartons
 * that happen to share marks+desc (different sizes → very different CBM).
 */
function isSplitQuantityTierSecondLine(prev: ExtractedProduct, cur: ExtractedProduct): boolean {
  const pm = normStr(prev.marks)
  const cm = normStr(cur.marks)
  if (pm === '' || pm !== cm) return false
  if (normStr(prev.item_code) !== normStr(cur.item_code)) return false
  if (normStr(prev.description) !== normStr(cur.description)) return false
  if (normStr(prev.shop) !== normStr(cur.shop)) return false

  const pc = prev.total_cartons ?? 0
  const cc = cur.total_cartons ?? 0
  if (pc <= 0 || cc <= 0) return false

  const pcbm = prev.total_cbm ?? 0
  const ccbm = cur.total_cbm ?? 0
  if (Math.abs(pcbm - ccbm) > SPLIT_TIER_CBM_MAX_DIFF) return false

  const pq = prev.total_qty ?? null
  const cq = cur.total_qty ?? null
  const pa = prev.total_amount_rmb ?? null
  const ca = cur.total_amount_rmb ?? null
  const qtyDiffers = pq !== null && cq !== null && pq !== cq
  const amtDiffers = pa !== null && ca !== null && normNum(pa) !== normNum(ca)
  if (!qtyDiffers && !amtDiffers) return false

  return true
}

function stripPhantomCartonFromVolumelessRow(p: ExtractedProduct): ExtractedProduct {
  if ((p.section ?? 'shipped') !== 'shipped') return p
  const ctn = p.total_cartons ?? 0
  if (ctn < PHANTOM_CTN_MIN) return p
  if (!isNearZeroVolume(p.total_cbm) || !isNearZeroVolume(p.total_weight_kg)) return p
  return {
    ...p,
    total_cartons: 0,
    remarks: appendRemark(p.remarks, 'carton_dedup:qty_misread_as_ctn'),
  }
}

function appendRemark(existing: string | null | undefined, tag: string): string {
  const e = (existing ?? '').trim()
  if (!e) return tag
  if (e.includes(tag)) return e
  return `${e} ${tag}`
}

/** Pre-pass: structural phantom CTNs; pair pass: duplicates, rowspan, split tiers. */
function normalizeManifestCartonCounts(
  products: ExtractedProduct[],
  docType: DocType
): ExtractedProduct[] {
  if (docType !== 'container_manifest') return products
  const stripped = products.map(p => stripPhantomCartonFromVolumelessRow({ ...p }))
  const out = stripped.map(p => ({ ...p }))
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]
    const cur = out[i]
    if ((cur.section ?? 'shipped') !== 'shipped') continue
    if ((prev.section ?? 'shipped') !== 'shipped') continue

    if (rowsAreOcrDuplicate(prev, cur)) {
      cur.total_cartons = 0
      cur.remarks = appendRemark(cur.remarks, 'carton_dedup:secondary_row')
      continue
    }
    if (isRowspanContinuationSplit(prev, cur)) {
      cur.total_cartons = 0
      cur.remarks = appendRemark(cur.remarks, 'carton_dedup:secondary_row')
      continue
    }
    if (isSplitQuantityTierSecondLine(prev, cur)) {
      cur.total_cartons = 0
      cur.remarks = appendRemark(cur.remarks, 'carton_dedup:secondary_row')
    }
  }
  return out
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
  return normalizeManifestCartonCounts(products, docType)
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
