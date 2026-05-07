/**
 * Fix 1: Deterministic parser for Reducto /parse HTML chunk output.
 *
 * Converts the chunk array returned by Reducto's /parse endpoint into typed
 * ExtractedProduct[] and ExtractedDocument — no LLM involved.
 * Given identical input chunks, output is always identical (no randomness).
 *
 * Handles all three document types: container_manifest, sales_order, unknown.
 * Handles section classification, MARKS propagation, merged cells, box ranges.
 */

import type { ExtractedDocument, ExtractedProduct } from './claude-extractor'
import type { DocType } from './prompts'
import { expandHtmlTable } from './html-table-parser'
import { resolveColumn, type ProductField } from './column-map'
import { FULL_EXTRACT_ITEM_CODE, SECTION_SUBTOTAL_ITEM_CODE, FOOTER_ITEM_CODE } from './full-extract'
import {
  isBeforeGoodsHeader,
  isGoodsLeftHeader,
  isNewOrderSectionHeader,
  isRepackagedSectionHeader,
} from './sections'
import { dedupeShippedCartonCounts, fixManifestSectionContinuity } from './manifest-section-fixer'

type Section = ExtractedProduct['section']
const BEFORE_GOODS_REMARK = 'carryover:before_goods'

/** `inventory` skips banners/subtotals (default). `full` emits every table row + non-table text as editable lines. */
export type ParseMode = 'inventory' | 'full'

export interface ParseReductoChunksOptions {
  mode?: ParseMode
}

function syntheticFullExtractRow(
  lineNo: number,
  text: string,
  section: Section,
  remarks: string
): ExtractedProduct {
  return {
    line_no: lineNo,
    marks: null,
    shop: null,
    item_code: FULL_EXTRACT_ITEM_CODE,
    description: text.trim() || null,
    packaging: null,
    qty_per_carton: null,
    total_cartons: null,
    total_qty: null,
    unit_price_rmb: null,
    total_amount_rmb: null,
    dim_l_cm: null,
    dim_w_cm: null,
    dim_h_cm: null,
    unit_cbm: null,
    total_cbm: null,
    unit_weight_kg: null,
    total_weight_kg: null,
    barcode: null,
    warehouse: null,
    box_no_start: null,
    box_no_end: null,
    section,
    remarks,
  }
}

export interface ReductoChunkInput {
  content: string
  blocks?: Array<{ type?: string; content?: string; confidence?: string }>
}

export interface HtmlParseResult {
  products: ExtractedProduct[]
  document: ExtractedDocument
  tablesFound: number
  rowsMapped: number
}

/**
 * Primary entry point. Processes chunks sequentially, tracking section
 * transitions and MARKS carry-across so multi-table/multi-page PDFs
 * are handled correctly.
 */
export function parseReductoChunks(
  chunks: ReductoChunkInput[],
  docType: DocType,
  options?: ParseReductoChunksOptions
): HtmlParseResult {
  const mode: ParseMode = options?.mode ?? 'inventory'
  const headerTexts: string[] = []
  const footerTexts: string[] = []
  const products: ExtractedProduct[] = []
  let currentSection: Section = 'shipped'
  let hasSeenTable = false
  let tablesFound = 0
  let rowsMapped = 0
  let lineCounter = 1
  let prevMarks: string | null = null
  const chunkPlainParts: string[] = []

  for (const chunk of chunks) {
    const content = (chunk.content ?? '').trim()
    if (!content) continue

    const plainOne = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (plainOne) chunkPlainParts.push(plainOne)

    const isTableChunk =
      /<table[\s>]/i.test(content) ||
      (chunk.blocks ?? []).some(b => (b.type ?? '').toLowerCase() === 'table')

    if (isTableChunk) {
      hasSeenTable = true
      tablesFound++
      const result = parseTableHtml(
        content,
        currentSection,
        docType,
        lineCounter,
        prevMarks,
        mode
      )
      products.push(...result.products)
      rowsMapped += result.products.length
      lineCounter += result.products.length
      if (result.lastMarks !== null) prevMarks = result.lastMarks
      currentSection = result.exitSection
    } else {
      const plainText = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (!plainText) continue

      // Update section state from text headers between tables
      if (isNewOrderSectionHeader(plainText)) {
        currentSection = 'shipped'
      } else if (isBeforeGoodsHeader(plainText)) {
        currentSection = 'left_in_warehouse'
      } else if (isGoodsLeftHeader(plainText)) {
        currentSection = 'left_in_warehouse'
      } else if (isRepackagedSectionHeader(plainText)) {
        currentSection = 'repacked'
      }

      // Full extract: keep all text between tables, including section headers.
      if (mode === 'full') {
        products.push(
          syntheticFullExtractRow(lineCounter++, plainText, currentSection, 'full_extract:text_block')
        )
        rowsMapped++
      }

      if (!hasSeenTable) headerTexts.push(plainText)
      else footerTexts.push(plainText)
    }
  }

  const document = buildDocument(headerTexts, footerTexts, docType, chunkPlainParts.join('\n'))
  const productsFixed = dedupeShippedCartonCounts(fixManifestSectionContinuity(products, docType), docType)
  return { products: productsFixed, document, tablesFound, rowsMapped }
}

// ── Table HTML parsing ────────────────────────────────────────────────────────

interface TableHtmlResult {
  products: ExtractedProduct[]
  lastMarks: string | null
  exitSection: Section
}

function parseTableHtml(
  html: string,
  defaultSection: Section,
  docType: DocType,
  startLineNo: number,
  inheritedMarks: string | null,
  parseMode: ParseMode
): TableHtmlResult {
  const normalizeHtmlText = (fragment: string): string =>
    fragment.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

  const applySectionHint = (section: Section, text: string): Section => {
    if (!text) return section
    if (isNewOrderSectionHeader(text)) return 'shipped'
    if (isBeforeGoodsHeader(text)) return 'left_in_warehouse'
    if (isGoodsLeftHeader(text)) return 'left_in_warehouse'
    if (isRepackagedSectionHeader(text)) return 'repacked'
    return section
  }

  const tableMatches = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)]
  let entrySection: Section = defaultSection

  if (tableMatches.length === 0) {
    entrySection = applySectionHint(entrySection, normalizeHtmlText(html))
    return parseGridToProducts(
      expandHtmlTable(html),
      entrySection,
      docType,
      startLineNo,
      inheritedMarks,
      parseMode
    )
  }

  const products: ExtractedProduct[] = []
  let lineNo = startLineNo
  let lastMarks = inheritedMarks
  let exitSection = entrySection
  let cursor = 0
  let lastHeaderRow: string[] | null = null

  for (const tableMatch of tableMatches) {
    const tableStart = tableMatch.index ?? cursor
    const interTableText = normalizeHtmlText(html.slice(cursor, tableStart))
    exitSection = applySectionHint(exitSection, interTableText)

    const rawGrid = expandHtmlTable(tableMatch[0])
    const headerInfo = detectBestHeaderRow(rawGrid, docType)
    if (headerInfo.index >= 0 && headerInfo.score >= 3) {
      lastHeaderRow = [...rawGrid[headerInfo.index]]
    }
    const grid =
      headerInfo.score >= 3 || !lastHeaderRow || !looksLikeHeaderlessDataTable(rawGrid)
        ? rawGrid
        : [lastHeaderRow, ...rawGrid]

    const result = parseGridToProducts(
      grid,
      exitSection,
      docType,
      lineNo,
      lastMarks,
      parseMode
    )
    products.push(...result.products)
    lineNo += result.products.length
    if (result.lastMarks !== null) lastMarks = result.lastMarks
    exitSection = result.exitSection
    cursor = tableStart + tableMatch[0].length
  }

  const trailingText = normalizeHtmlText(html.slice(cursor))
  exitSection = applySectionHint(exitSection, trailingText)

  return { products, lastMarks, exitSection }
}

interface GridParseResult {
  products: ExtractedProduct[]
  lastMarks: string | null
  exitSection: Section
}

function detectBestHeaderRow(grid: string[][], docType: DocType): { index: number; score: number } {
  const headerScanRows = Math.min(grid.length, 8)
  let headerRowIdx = -1
  let bestScore = 0

  for (let r = 0; r < headerScanRows; r++) {
    let score = 0
    for (const cell of grid[r]) {
      if (cell && resolveColumn(cell, docType) !== null) score++
    }
    if (score > bestScore) {
      bestScore = score
      headerRowIdx = r
    }
  }

  return { index: headerRowIdx, score: bestScore }
}

function looksLikeHeaderlessDataTable(grid: string[][]): boolean {
  if (grid.length === 0) return false
  const row = grid[0] ?? []
  const nonEmpty = row.filter(c => c.trim() !== '').length
  if (nonEmpty < 8) return false
  return row.some(c => /\bSANCARGO\b|\bRGO\b|\bMS-[A-Z0-9-]+\b|\b\d+-T-[A-Z0-9-]+\b/i.test(c))
}

/**
 * Sales order pages 2+ arrive as headerless <tbody>-only tables.
 * Detected by: first cell = row number, second-to-last or third-to-last = 13-digit barcode.
 */
function looksLikeHeaderlessSalesOrderTable(grid: string[][]): boolean {
  if (grid.length === 0) return false
  const row = grid[0] ?? []
  if (row.length < 10) return false
  if (!/^\d{1,4}$/.test(row[0]?.trim() ?? '')) return false
  const n = row.length
  return (
    /^\d{12,15}$/.test(row[n - 2]?.trim() ?? '') ||
    /^\d{12,15}$/.test(row[n - 3]?.trim() ?? '')
  )
}

/**
 * Right-anchored positional parser for a single headerless sales order row.
 * Works across all page variants (19–22 columns) because it anchors from the
 * right (W.H. last, barcode second-to-last) and works inward.
 * Returns null for TOTAL/label/blank rows.
 */
function parseSalesOrderRowPositional(
  row: string[],
  section: Section,
  lineNo: number,
  inheritedMarks: string | null,
): ExtractedProduct | null {
  const n = row.length
  if (n < 7) return null

  // Row must start with an integer row number
  if (!/^\d{1,4}$/.test(row[0]?.trim() ?? '')) return null

  // Detect REK vs CODE at second-to-last position
  let codeIdx: number
  let rekValue: string | null = null
  const penultimate = row[n - 2]?.trim() ?? ''
  if (/^\d{12,15}$/.test(penultimate)) {
    codeIdx = n - 2
  } else {
    codeIdx = n - 3
    rekValue = penultimate || null
  }
  if (codeIdx < 5) return null

  // Verify barcode is a real 13-15 digit code
  const barcodeVal = row[codeIdx]?.trim() ?? ''
  if (!/^\d{12,15}$/.test(barcodeVal)) return null

  // Right-anchored numeric fields
  const ttKgsIdx = codeIdx - 1
  const ttCbmIdx = codeIdx - 2
  const gwIdx    = codeIdx - 3
  const cbmIdx   = codeIdx - 4

  // Detect W+H merge: cell at codeIdx-5 contains "NUM NUM" (two numbers separated by space)
  const cellMinus5 = row[codeIdx - 5]?.trim() ?? ''
  const whMerge = cellMinus5.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/)

  let dim_l_cm: number | null
  let dim_w_cm: number | null
  let dim_h_cm: number | null
  let lIdx: number

  if (whMerge) {
    dim_w_cm = parseFloat(whMerge[1])
    dim_h_cm = parseFloat(whMerge[2])
    lIdx = codeIdx - 6
    dim_l_cm = parseNum(row[lIdx])
  } else {
    dim_h_cm = parseNum(row[codeIdx - 5])
    dim_w_cm = parseNum(row[codeIdx - 6])
    lIdx = codeIdx - 7
    dim_l_cm = parseNum(row[lIdx])
  }

  const amountIdx = lIdx - 1
  const upIdx     = amountIdx - 1
  const tqtyIdx   = upIdx - 1
  const qtyIdx    = tqtyIdx - 1
  const ctnIdx    = qtyIdx - 1
  const desIdx    = ctnIdx - 1

  if (desIdx < 1) return null

  // Find ITEM_NO by scanning left side (after row number, skipping dates and ORD NO)
  let itemCode: string | null = null
  for (let i = 1; i < desIdx; i++) {
    const c = row[i]?.trim() ?? ''
    if (!c) continue
    if (/^\d{4}-\d{2}-\d{2}$/.test(c)) continue   // full date YYYY-MM-DD
    if (/^20\d{2}[-\/]\d{2}/.test(c)) continue     // modern year partial date 20XX-MM
    if (/^\d{2}-\d{2}-?$/.test(c)) continue        // 2-digit year partial YY-MM or YY-MM-
    if (/^[A-Z]\d{2}-\d{4}$/.test(c)) continue     // ORD NO like C25-6083
    itemCode = c
    break
  }

  const desc = row[desIdx]?.trim() ?? ''
  if (!desc && !itemCode) return null

  const total_qty_parsed    = parseNum(row[tqtyIdx])
  const total_amount_parsed = parseNum(row[amountIdx])
  let unit_price_rmb        = parseNum(row[upIdx])
  if (
    (unit_price_rmb === null || unit_price_rmb <= 0) &&
    total_amount_parsed !== null && total_qty_parsed !== null && total_qty_parsed > 0
  ) {
    const inferred = Math.round((total_amount_parsed / total_qty_parsed) * 100) / 100
    if (isFinite(inferred) && inferred > 0) unit_price_rmb = inferred
  }

  const qty_per_carton = parseNum(row[qtyIdx])

  return {
    line_no: lineNo,
    marks: inheritedMarks,
    shop: null,
    item_code: itemCode,
    description: desc || null,
    packaging: qty_per_carton !== null ? `${qty_per_carton}pcs` : null,
    qty_per_carton,
    total_cartons: parseNum(row[ctnIdx]),
    total_qty: total_qty_parsed,
    unit_price_rmb,
    total_amount_rmb: total_amount_parsed,
    dim_l_cm,
    dim_w_cm,
    dim_h_cm,
    unit_cbm: parseNum(row[cbmIdx]),
    total_cbm: parseNum(row[ttCbmIdx]),
    unit_weight_kg: parseNum(row[gwIdx]),
    total_weight_kg: parseNum(row[ttKgsIdx]),
    barcode: barcodeVal || null,
    warehouse: row[n - 1]?.trim() || null,
    box_no_start: null,
    box_no_end: null,
    section,
    remarks: rekValue,
  }
}

/** Parse an entire headerless sales order grid using right-anchored positional mapping. */
function parseSalesOrderGridPositional(
  grid: string[][],
  defaultSection: Section,
  startLineNo: number,
  inheritedMarks: string | null,
  parseMode: ParseMode
): GridParseResult {
  const products: ExtractedProduct[] = []
  let lineNo = startLineNo

  for (const row of grid) {
    if (row.every(c => !c.trim())) continue

    // TOTAL / label rows (first cell is not an integer)
    const firstCell = row[0]?.trim() ?? ''
    if (!/^\d{1,4}$/.test(firstCell)) {
      if (parseMode === 'full') {
        const rowText = row.filter(Boolean).join(' ')
        if (rowText.trim()) {
          const synth = syntheticFullExtractRow(lineNo++, rowText, defaultSection, 'full_extract:sales_order_total')
          synth.item_code = FOOTER_ITEM_CODE
          products.push(synth)
        }
      }
      continue
    }

    const product = parseSalesOrderRowPositional(row, defaultSection, lineNo, inheritedMarks)
    if (product) {
      products.push(product)
      lineNo++
    }
  }

  return { products, lastMarks: inheritedMarks, exitSection: defaultSection }
}

/** When a header cell has colspan, expandHtmlTable duplicates the label across spanned columns. */
function mergeFieldParts(a: string, b: string): string {
  const t1 = a.trim()
  const t2 = b.trim()
  if (!t2) return t1
  if (!t1) return t2
  if (t1 === t2) return t1
  return `${t1} ${t2}`
}

// When a table's header uses a single DESCRIPTION cell (no colspan) but data rows
// contain an extra sub-description cell, every column after description shifts by 1.
// This merges those overflow cells back into the description column so the mapping stays aligned.
function normalizeRowToColMap(row: string[], colMap: Map<number, ProductField | 'skip'>): string[] {
  if (colMap.size === 0) return row
  const maxIdx = Math.max(...colMap.keys())
  const overflow = row.length - (maxIdx + 1)
  if (overflow <= 0) return row
  let descIdx = -1
  for (const [idx, field] of colMap) {
    if (field === 'description') { descIdx = idx; break }
  }
  if (descIdx < 0) return row
  // When the header already uses colspan to spread description across multiple
  // colMap entries (e.g. colMap[4]=description AND colMap[5]=description), the
  // apparent overflow is caused by an unrecognised trailing column — NOT by an
  // extra sub-description cell.  Normalising here would shift every column after
  // description by one, corrupting CTN/QTY/CBM/etc.
  if (colMap.get(descIdx + 1) === 'description') return row
  const normalized = [...row]
  for (let i = 0; i < overflow; i++) {
    const extra = (normalized[descIdx + 1] ?? '').trim()
    if (extra) normalized[descIdx] = normalized[descIdx] ? `${normalized[descIdx]} ${extra}` : extra
    normalized.splice(descIdx + 1, 1)
  }
  return normalized
}

function buildRawFromRow(
  row: string[],
  colMap: Map<number, ProductField | 'skip'>
): Record<string, string> {
  const indices = [...colMap.keys()].sort((x, y) => x - y)
  const raw: Record<string, string> = {}

  let pendingField: ProductField | null = null
  let acc = ''

  const flush = () => {
    if (pendingField === null) return
    raw[pendingField] = acc
    pendingField = null
    acc = ''
  }

  for (const colIdx of indices) {
    const field = colMap.get(colIdx) ?? 'skip'
    if (field === 'skip') {
      flush()
      continue
    }
    const cell = (row[colIdx] ?? '').trim()
    if (field === pendingField) {
      acc = mergeFieldParts(acc, cell)
    } else {
      flush()
      pendingField = field
      acc = cell
    }
  }
  flush()
  return raw
}

/** Row is probably a 2nd header line (sub-headers like U.PRICE under a group row), not data. */
function isLikelySubHeaderRow(row: string[] | undefined, docType: DocType): boolean {
  if (!row?.length) return false
  let headerHits = 0
  let nonEmpty = 0
  for (const cell of row) {
    const t = cell.trim()
    if (!t) continue
    nonEmpty++
    const f = resolveColumn(t, docType)
    if (f !== null && f !== 'skip') headerHits++
  }
  if (nonEmpty === 0) return false
  // Narrow row where every cell is a known column label (common 2nd header line)
  if (nonEmpty <= 8 && headerHits === nonEmpty) return true
  return headerHits >= Math.max(2, Math.ceil(nonEmpty * 0.35))
}

function mergeHeaderLabels(a: string, b: string): string {
  const t1 = a.trim()
  const t2 = b.trim()
  if (!t2) return t1
  if (!t1) return t2
  return `${t1} ${t2}`
}

/**
 * Build column map from one or two header rows. Reducto often emits a group header row
 * plus a second row with real labels (e.g. U.PRICE (RMB)); without merging, price columns stay unmapped.
 */
function buildColMapFromHeaderRows(
  grid: string[][],
  primaryIdx: number,
  includeNextRow: boolean,
  docType: DocType
): Map<number, ProductField | 'skip'> {
  const colMap = new Map<number, ProductField | 'skip'>()
  const rowA = grid[primaryIdx] ?? []
  const rowB = includeNextRow ? grid[primaryIdx + 1] ?? [] : []
  const maxCol = Math.max(rowA.length, rowB.length, 0)

  for (let c = 0; c < maxCol; c++) {
    const a = (rowA[c] ?? '').trim()
    const b = (rowB[c] ?? '').trim()

    let field = a ? resolveColumn(a, docType) : null
    if (field === null && b) field = resolveColumn(b, docType)
    if (field === null && (a || b)) {
      const merged = mergeHeaderLabels(a, b)
      if (merged) field = resolveColumn(merged, docType)
    }

    if (field !== null) colMap.set(c, field)
  }

  return colMap
}

/** Reducto sometimes leaves rowspan MARKS cells visually empty; scan cells for typical marks text. */
function inferMarksFromRowCells(row: string[]): string | null {
  for (const cell of row) {
    const t = cell.trim()
    if (!t || t.length > 160) continue
    if (/\bMS-[A-Z0-9]+(?:-[A-Z0-9]+)+\s+SANCARGO\b/i.test(t)) return t.replace(/\s+/g, ' ').trim()
    if (/\b\d+-T-[A-Z0-9]+-\d+\s+SANCARGO\b/i.test(t)) return t.replace(/\s+/g, ' ').trim()
    if (/^\s*MOSES\b/i.test(t) && !/\d+\s*CTNS?\b/i.test(t)) return t.replace(/\s+/g, ' ').trim()
    // Short supplier marks (PDF column): VICHAS, M DUSS, etc.
    if (/^VICHAS$/i.test(t)) return t
    if (/^M\s+DUSS$/i.test(t) || /^M\s+DUSS\b/i.test(t)) return t.replace(/\s+/g, ' ').trim()
    // Lines that are clearly marks (not amounts): letters + SANCARGO, limited length
    if (/\bSANCARGO\b/i.test(t) && t.length < 88 && !/\d+\s*pcs/i.test(t) && !/\bCTNS?\b/i.test(t))
      return t.replace(/\s+/g, ' ').trim()
  }
  return null
}

/**
 * Yellow-bar section subtotal rows in packing lists: rolled-up CTN/CBM/KGS/¥ without a real product line.
 * Must not become product rows (avoids "400" mis-read as qty).
 */
function isLikelyYellowSubtotalRow(row: string[]): boolean {
  const joined = row
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!joined) return false
  // Explicit subtotal labels
  if (/\bSUB\s*TOTAL\b|\bSECTION\s+TOTAL\b/i.test(joined)) return true
  // Packing-list product rows almost always mention pcs/ctn
  if (/\d+\s*pcs\/ctn/i.test(joined)) return false
  // Glued tokens common in PDF exports: "400CTNS", "85.344CBM"
  const hasCtn =
    /\b\d+\s*CTNS?\b/i.test(joined) ||
    /\b\d+CTNS\b/i.test(joined)
  const hasCbm =
    /\b\d+\.?\d*\s*CBM\b/i.test(joined) ||
    /\d+\.?\d*CBM\b/i.test(joined)
  const hasMoney = /[¥￥]\s*[\d,]+/.test(joined)
  const hasKgs =
    /\b\d+\.?\d*\s*KGS?\b/i.test(joined) ||
    /\d+\.?\d*KGS?\b/i.test(joined) ||
    /\d+\.?\d*GS\b/i.test(joined)
  let signals = 0
  if (hasCtn) signals++
  if (hasCbm) signals++
  if (hasMoney) signals++
  if (hasKgs) signals++
  if (signals < 3) return false
  // Few natural-language words → summary row, not "Ice cream machine …"
  const alphaChunks = joined.replace(/[\d.,¥￥\s/:%\-]/g, ' ')
  const words = alphaChunks.split(/\s+/).filter(w => /^[A-Za-z]{3,}/.test(w))
  if (words.length >= 5) return false
  return true
}

/** Mapped row looks like a rolled total (large CTN / amount, no real description). */
function isSubtotalAggregateRaw(raw: Record<string, string>): boolean {
  const desc = (raw['description'] ?? '').trim()
  const item = (raw['item_code'] ?? '').trim()
  if (desc.length > 2 || item.length > 2) {
    if (/machine|parts|oven|grill|bra|sleepwear|shapewear|tape|mixer|dispenser/i.test(desc)) return false
  }
  const ctn = parseNum(raw['total_cartons'])
  const qty = parseNum(raw['total_qty'])
  const amt = parseNum(raw['total_amount_rmb'])
  if (ctn !== null && ctn >= 40 && amt !== null && amt >= 3000 && desc.length <= 1 && item.length <= 1)
    return true
  if (qty !== null && qty >= 200 && amt !== null && amt >= 10000 && !desc) return true
  return false
}

/**
 * Subtotal row landed mostly in "description" or split cells; same rolled CTNS+CBM+KGS+¥ pattern.
 */
function isRolledTotalsBlobInFields(raw: Record<string, string>, rowText: string): boolean {
  const joined = [
    rowText,
    raw['description'] ?? '',
    raw['marks'] ?? '',
    raw['item_code'] ?? '',
    raw['shop'] ?? '',
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (joined.length < 12) return false
  if (/\d+\s*pcs\/ctn/i.test(joined)) return false
  const hasCtn = /\b\d+\s*CTNS?\b/i.test(joined) || /\b\d+CTNS\b/i.test(joined)
  const hasCbm = /\b\d+\.?\d*\s*CBM\b/i.test(joined) || /\d+\.?\d*CBM\b/i.test(joined)
  const hasMoney = /[¥￥]\s*[\d,]+/.test(joined)
  const hasKgs =
    /\b\d+\.?\d*\s*KGS?\b/i.test(joined) ||
    /\d+\.?\d*KGS?\b/i.test(joined) ||
    /\d+\.?\d*GS\b/i.test(joined)
  let signals = 0
  if (hasCtn) signals++
  if (hasCbm) signals++
  if (hasMoney) signals++
  if (hasKgs) signals++
  if (signals < 3) return false
  const alphaChunks = joined.replace(/[\d.,¥￥\s/:%\-_]/g, ' ')
  const words = alphaChunks.split(/\s+/).filter(w => /^[A-Za-z]{3,}/.test(w))
  if (words.length >= 5) return false
  return true
}

function isLikelyBannerNoiseRow(raw: Record<string, string>): boolean {
  const shop = (raw['shop'] ?? '').trim().toUpperCase()
  const item = (raw['item_code'] ?? '').trim().toUpperCase()
  const desc = (raw['description'] ?? '').trim().toUpperCase()
  const pack = (raw['packaging'] ?? '').trim().toUpperCase()
  return shop === 'NEW ORDER' && item === 'NEW ORDER' && desc === 'NEW ORDER' && pack === 'NEW ORDER'
}

/**
 * Rows from the financial summary table / footer section at the bottom of the PDF.
 * Covers: totals, payment lines, GOODS BALANCE, freight, payment terms text, reduce notes.
 * These are already captured in document_totals / document_payments — not products.
 */
function isDocumentFooterRow(raw: Record<string, string>, rowText: string): boolean {
  const combined = [
    raw['marks'] ?? '',
    raw['description'] ?? '',
    raw['item_code'] ?? '',
    raw['shop'] ?? '',
    rowText,
  ].join(' ').replace(/\s+/g, ' ').trim().toUpperCase()

  // Standard totals
  if (/\bTOTAL\s+(WEIGHT|CBM|CARTON|COST|BALANCE)\b/.test(combined)) return true
  // Balance line items
  if (/\b(GOODS\s+BALANCE|CREDIT\s+SUPPORT|PIVOC|EXCHANGE\s+RATE)\b/.test(combined)) return true
  // Freight line
  if (/YIWU.{0,10}MOMBASA.{0,10}FREIGHT/i.test(combined)) return true
  // Payment rows (date + PAYMENT + USD, including "PAID IN CHINA" variants)
  if (/\bPAYMENT\b/.test(combined) && /USD/.test(combined) && !/\bpcs\/ctn\b/i.test(combined)) return true
  // Payment terms header and body text
  if (/BALANCE\s+PAYMENT\s+TERMS/i.test(combined)) return true
  if (/IF\s+OUTSTANDING\s+BALANCE\s+IS\s+NOT\s+PAID/i.test(combined)) return true
  if (/PAYMENT\s+DELAY\s+SURCHARGE/i.test(combined)) return true
  if (/VESSEL\s+ARRIVAL\s+MOMBASA/i.test(combined)) return true
  // Reduce / adjustment notes that appear after TOTAL CARTON
  if (/REDUCE\s+DETAILS/i.test(combined)) return true
  if (/REDUCE\s+\d+\s*CTN/i.test(combined)) return true
  return false
}

/**
 * Some sales-order pages arrive as flattened text rows (single-cell tables).
 * Recover key identity fields so rows are editable/savable instead of `__FU`.
 */
function recoverSalesOrderFlatRow(
  text: string,
  section: Section,
  lineNo: number,
  inheritedMarks: string | null
): ExtractedProduct | null {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  const m = flat.match(
    /^(\d{1,4})\s+([A-Z0-9]+(?:\s*-\s*[A-Z0-9]+)+)\s+([A-Z0-9]{2,}[-/A-Z0-9]*)\s+(.+)$/i
  )
  if (!m) return null

  const marks = m[2].replace(/\s*-\s*/g, '-').trim()
  const item = m[3].trim()
  let desc = m[4].trim()
  if (!item || !desc) return null

  // Drop trailing numeric bundle/barcode tail but keep human-readable description.
  desc = desc
    .replace(/\s+\d{8,}\s*[\u4e00-\u9fffA-Za-z]{0,12}\s*$/, '')
    .replace(/\s+(?:\d+(?:\.\d+)?\s*){7,}$/, '')
    .trim()
  if (!desc) return null

  return {
    line_no: lineNo,
    marks: marks || inheritedMarks,
    shop: null,
    item_code: item,
    description: desc,
    packaging: null,
    qty_per_carton: null,
    total_cartons: null,
    total_qty: null,
    unit_price_rmb: null,
    total_amount_rmb: null,
    dim_l_cm: null,
    dim_w_cm: null,
    dim_h_cm: null,
    unit_cbm: null,
    total_cbm: null,
    unit_weight_kg: null,
    total_weight_kg: null,
    barcode: null,
    warehouse: null,
    box_no_start: null,
    box_no_end: null,
    section,
    remarks: 'full_extract:flattened_sales_order_row',
  }
}

function parseGridToProducts(
  grid: string[][],
  defaultSection: Section,
  docType: DocType,
  startLineNo: number,
  inheritedMarks: string | null,
  parseMode: ParseMode
): GridParseResult {
  if (grid.length < 2) return { products: [], lastMarks: inheritedMarks, exitSection: defaultSection }

  const { index: headerRowIdx, score: bestScore } = detectBestHeaderRow(grid, docType)

  // Require at least 3 known columns — otherwise this table is not a product table
  if (bestScore < 3 || headerRowIdx === -1) {
    // Sales order pages 2+ arrive as headerless <tbody>-only tables — use positional parser
    if (docType === 'sales_order' && looksLikeHeaderlessSalesOrderTable(grid)) {
      return parseSalesOrderGridPositional(grid, defaultSection, startLineNo, inheritedMarks, parseMode)
    }
    if (parseMode === 'full') {
      const rows = grid
        .map(row => row.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
      const products = rows.map((text, idx) => {
        if (docType === 'sales_order') {
          const recovered = recoverSalesOrderFlatRow(
            text,
            defaultSection,
            startLineNo + idx,
            inheritedMarks
          )
          if (recovered) return recovered
        }
        return syntheticFullExtractRow(
          startLineNo + idx,
          text,
          defaultSection,
          'full_extract:unmapped_table_row'
        )
      })
      return { products, lastMarks: inheritedMarks, exitSection: defaultSection }
    }
    return { products: [], lastMarks: inheritedMarks, exitSection: defaultSection }
  }

  const nextRow = grid[headerRowIdx + 1]
  // Merge second row when it looks like sub-headers (U.PRICE, T.AMOUNT, …)
  const includeNextAsHeader = nextRow !== undefined && isLikelySubHeaderRow(nextRow, docType)

  const colMap = buildColMapFromHeaderRows(grid, headerRowIdx, includeNextAsHeader, docType)

  let dataStartRow = headerRowIdx + 1
  if (includeNextAsHeader) dataStartRow = headerRowIdx + 2

  let currentSection: Section = defaultSection
  let inBeforeGoodsBlock = false
  const products: ExtractedProduct[] = []
  let lineNo = startLineNo
  let prevMarks = inheritedMarks

  for (let r = dataStartRow; r < grid.length; r++) {
    const row = grid[r]

    // Skip fully blank rows
    if (row.every(cell => !cell.trim())) continue

    // Section banners: NEW ORDER, GOODS LEFT IN SANCARGO, stuffed/repacked container
    const rowText = row.filter(Boolean).join(' ')
    if (isNewOrderSectionHeader(rowText)) {
      // Explicit NEW ORDER/NEW ORDERS header starts the shipped block.
      currentSection = 'shipped'
      inBeforeGoodsBlock = false
      prevMarks = null
      if (parseMode === 'full') {
        products.push(
          syntheticFullExtractRow(lineNo++, rowText, currentSection, 'full_extract:new_order')
        )
      }
      continue
    }
    if (isBeforeGoodsHeader(rowText)) {
      currentSection = 'left_in_warehouse'
      inBeforeGoodsBlock = true
      prevMarks = null
      if (parseMode === 'full') {
        products.push(syntheticFullExtractRow(lineNo++, rowText, currentSection, 'full_extract:before_goods'))
      }
      continue
    }
    if (isGoodsLeftHeader(rowText)) {
      currentSection = 'left_in_warehouse'
      inBeforeGoodsBlock = false
      prevMarks = null
      if (parseMode === 'full') {
        products.push(syntheticFullExtractRow(lineNo++, rowText, currentSection, 'full_extract:goods_left'))
      }
      continue
    }
    if (isRepackagedSectionHeader(rowText)) {
      currentSection = 'repacked'
      inBeforeGoodsBlock = false
      prevMarks = null
      if (parseMode === 'full') {
        products.push(syntheticFullExtractRow(lineNo++, rowText, currentSection, 'full_extract:repacked'))
      }
      continue
    }

    // Grand-total labelling rows (document-level label — not a product line)
    const firstCell = row[0]?.trim() ?? ''
    if (/^(GRAND\s+)?TOTAL\s*[:\s]*$/i.test(firstCell) || /^(小计|合计|总计)/.test(firstCell)) {
      if (parseMode === 'full') {
        products.push(syntheticFullExtractRow(lineNo++, rowText, currentSection, 'full_extract:total_label'))
      }
      continue
    }

    // Build raw field map — normalize row length first (handles extra description cells in
    // tables where the header has DESCRIPTION as a single cell instead of colspan=3)
    const raw = buildRawFromRow(normalizeRowToColMap(row, colMap), colMap)

    // Yellow / rolled section subtotal bars (CTNS+CBM+KGS+¥)
    // In inventory mode: skip entirely — not real product rows.
    // In full mode: emit tagged with SECTION_SUBTOTAL_ITEM_CODE so live view shows them
    // in yellow, but the DB inserter knows to exclude them.
    if (
      isLikelyYellowSubtotalRow(row) ||
      isSubtotalAggregateRaw(raw) ||
      isRolledTotalsBlobInFields(raw, rowText)
    ) {
      if (isGoodsLeftHeader(rowText)) {
        currentSection = 'left_in_warehouse'
      }
      prevMarks = null
      if (parseMode !== 'full') continue
      const sub = rawToProduct(raw, currentSection, lineNo, null)
      sub.item_code = SECTION_SUBTOTAL_ITEM_CODE
      products.push(sub)
      lineNo++
      continue
    }
    // Document footer rows (TOTAL WEIGHT/CBM, payment lines, GOODS BALANCE, etc.)
    // Already stored in document_totals / document_payments — never save as product rows.
    if (isDocumentFooterRow(raw, rowText)) {
      if (parseMode !== 'full') continue
      const ftr = rawToProduct(raw, currentSection, lineNo, null)
      ftr.item_code = FOOTER_ITEM_CODE
      products.push(ftr)
      lineNo++
      continue
    }

    // Infer marks from visible cells FIRST so a new section mark isn't overwritten by carry-forward
    const inferredMarks = inferMarksFromRowCells(row)
    if (!(raw['marks'] ?? '').trim() && inferredMarks) raw['marks'] = inferredMarks
    if (!(raw['marks'] ?? '').trim() && prevMarks) raw['marks'] = prevMarks
    if (isLikelyBannerNoiseRow(raw)) {
      if (parseMode === 'full') {
        const label =
          [raw['shop'], raw['item_code'], raw['description'], raw['packaging']].filter(Boolean).join(' · ') ||
          rowText
        products.push(
          syntheticFullExtractRow(lineNo++, label, currentSection, 'full_extract:new_order_cells')
        )
      }
      continue
    }

    let product = rawToProduct(raw, currentSection, lineNo, prevMarks)
    if (docType === 'container_manifest' || docType === 'unknown') {
      product = fixShiftedManifestRowColumns(product)
    }
    if (inBeforeGoodsBlock) {
      product.section = 'left_in_warehouse'
      product.remarks = product.remarks
        ? `${product.remarks};${BEFORE_GOODS_REMARK}`
        : BEFORE_GOODS_REMARK
    }
    if (product.marks) prevMarks = product.marks

    products.push(product)
    lineNo++
  }

  return { products, lastMarks: prevMarks, exitSection: currentSection }
}

function looksLikeShiftedManifestRow(p: ExtractedProduct): boolean {
  const pack = (p.packaging ?? '').trim()
  const desc = (p.description ?? '').trim()
  if (!/^\d+(?:\.\d+)?\s*CTNS?$/i.test(pack)) return false
  if (!/\d+(?:\.\d+)?\s*pcs\/ctn/i.test(desc)) return false
  const cartons = p.total_cartons ?? 0
  const qty = p.total_qty ?? 0
  const unitPrice = p.unit_price_rmb ?? 0
  const dimL = p.dim_l_cm ?? 0
  const totalAmount = p.total_amount_rmb ?? 0
  if (cartons <= 0 || qty <= 0) return false
  // Shift signature:
  // - cartons contains quantity-scale values (e.g. 6000, 240, 156)
  // - qty contains dimension-scale values (e.g. 47, 63, 145)
  // - unit_price carries total amount value (large), amount may carry box-no prefix
  const cartonsLooksLikeQty = cartons >= 100 || cartons > qty * 2
  const qtyLooksLikeDim = qty >= 20 && qty <= 200
  const unitPriceLooksLikeAmount = unitPrice >= 500
  const dimLLooksLikeUnitCbm = dimL > 0 && dimL < 2
  const amountLooksLikeBoxNoLeak = totalAmount > 0 && totalAmount < 1000
  if (!cartonsLooksLikeQty) return false
  if (!qtyLooksLikeDim) return false
  if (!unitPriceLooksLikeAmount) return false
  if (!dimLLooksLikeUnitCbm) return false
  if (!amountLooksLikeBoxNoLeak && totalAmount > 0 && totalAmount < unitPrice * 0.1) return false
  return true
}

function fixShiftedManifestRowColumns(p: ExtractedProduct): ExtractedProduct {
  if (!looksLikeShiftedManifestRow(p)) return p
  const out: ExtractedProduct = { ...p }

  const desc = out.description ?? ''
  const pcsMatch = desc.match(/(\d+(?:\.\d+)?\s*pcs\/ctn)\s*$/i)
  if (pcsMatch) {
    out.packaging = pcsMatch[1]
    out.description = desc.slice(0, pcsMatch.index).trim() || null
    const q = pcsMatch[1].match(/(\d+(?:\.\d+)?)/)
    out.qty_per_carton = q ? parseFloat(q[1]) : out.qty_per_carton
  }

  const ctnFromPack = (p.packaging ?? '').match(/(\d+(?:\.\d+)?)/)
  const fixedCartons = ctnFromPack ? parseFloat(ctnFromPack[1]) : p.total_cartons

  out.total_amount_rmb = p.unit_price_rmb
  out.unit_price_rmb = p.total_weight_kg
  out.total_weight_kg = p.unit_weight_kg
  out.unit_weight_kg = p.total_cbm
  out.total_cbm = p.unit_cbm
  out.unit_cbm = p.dim_l_cm
  out.dim_l_cm = p.dim_w_cm
  out.dim_w_cm = p.dim_h_cm
  out.dim_h_cm = p.total_qty
  out.total_qty = p.total_cartons
  out.total_cartons = fixedCartons

  out.remarks = out.remarks ? `${out.remarks};repair:shifted_manifest_columns` : 'repair:shifted_manifest_columns'
  return out
}

function rawToProduct(
  raw: Record<string, string>,
  section: Section,
  lineNo: number,
  inheritedMarks: string | null
): ExtractedProduct {
  const rawMarks = parseStr(raw['marks'])
  const marks = rawMarks ?? inheritedMarks

  // qty_per_carton: extract the leading number from the packing string
  let qty_per_carton: number | null = null
  const packingRaw = raw['packaging'] ?? ''
  if (packingRaw.trim()) {
    const m = packingRaw.match(/(\d+(?:\.\d+)?)/)
    if (m) qty_per_carton = parseFloat(m[1])
  }

  // box_no range: "170-278", "170~278", or just "170"
  let box_no_start: number | null = null
  let box_no_end: number | null = null
  const boxRaw = raw['box_no_start'] ?? ''
  if (boxRaw.trim()) {
    const m = boxRaw.match(/(\d+)(?:\s*[-–~]\s*(\d+))?/)
    if (m) {
      box_no_start = parseInt(m[1])
      box_no_end = m[2] ? parseInt(m[2]) : box_no_start
    }
  }

  const total_qty_parsed = parseNum(raw['total_qty'])
  const total_amount_parsed = parseNum(raw['total_amount_rmb'])
  let unit_price_rmb = parseNum(raw['unit_price_rmb'])
  if (unit_price_rmb === null || unit_price_rmb <= 0) {
    if (
      total_amount_parsed !== null &&
      total_amount_parsed > 0 &&
      total_qty_parsed !== null &&
      total_qty_parsed > 0
    ) {
      const inferred = Math.round((total_amount_parsed / total_qty_parsed) * 100) / 100
      if (isFinite(inferred) && inferred > 0) unit_price_rmb = inferred
    }
  }

  return {
    line_no: lineNo,
    marks,
    shop: parseStr(raw['shop']),
    item_code: parseStr(raw['item_code']),
    description: parseStr(raw['description']),
    packaging: parseStr(raw['packaging']),
    qty_per_carton,
    total_cartons: parseNum(raw['total_cartons']),
    total_qty: total_qty_parsed,
    unit_price_rmb,
    total_amount_rmb: total_amount_parsed,
    dim_l_cm: parseNum(raw['dim_l_cm']),
    dim_w_cm: parseNum(raw['dim_w_cm']),
    dim_h_cm: parseNum(raw['dim_h_cm']),
    unit_cbm: parseNum(raw['unit_cbm']),
    total_cbm: parseNum(raw['total_cbm']),
    unit_weight_kg: parseNum(raw['unit_weight_kg']),
    total_weight_kg: parseNum(raw['total_weight_kg']),
    barcode: parseStr(raw['barcode']),
    warehouse: parseStr(raw['warehouse']),
    box_no_start,
    box_no_end,
    section,
    remarks: parseStr(raw['remarks']),
  }
}

// ── Document metadata extraction ──────────────────────────────────────────────

function buildDocument(
  headerTexts: string[],
  footerTexts: string[],
  docType: DocType,
  /** Stripped text from every chunk (tables included) — header/footer alone miss PDF info embedded only in HTML tables */
  allChunksPlain?: string
): ExtractedDocument {
  const headerText = headerTexts.join('\n')
  const footerText = footerTexts.join('\n')
  const allText = [headerText, footerText, allChunksPlain ?? ''].filter(Boolean).join('\n')
  const flat = allText.replace(/\s+/g, ' ')

  const container_no =
    flat.match(/CONTAINER\s+NO\.?\s*[:\s]+([A-Z]{4}\d{7,})/i)?.[1] ??
    flat.match(/CONT(?:AINER)?\s*#?\s*[:\s]+([A-Z0-9]{9,})/i)?.[1] ??
    null

  const client_id =
    flat.match(/CLIENT\s+DETAILS\s*[:\s]+([^\n\r]{2,80}?)(?:\s+CONTAINER|\s{2,}|$)/i)?.[1]?.trim() ??
    flat.match(/CLIENT\s*(?:DETAILS|ID|NAME|NO)?\.?\s*[:\s]+([^\n\r,]{2,80})/i)?.[1]?.trim() ??
    // Sales order: "客户：C707-CG"
    flat.match(/客户[：:]\s*([^\s\n,，]{2,40})/)?.[1]?.trim() ??
    null

  const doc_number =
    flat.match(/(?:ORDER\s*NO|MANIFEST\s*NO|REF\s*NO|DOC\s*NO)\.?\s*[:\s]+([A-Z0-9-]+)/i)?.[1]?.trim() ??
    // Sales order header: "NO: C25-6083" — \bNO followed by colon/space, then an order-number pattern
    flat.match(/\bNO[:\s]+([A-Z][A-Z0-9]*\d+-\d+)\b/)?.[1]?.trim() ??
    null

  const document_date =
    headerText.match(/DATE\s*[:\s]+(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/i)?.[1]?.replace(/\//g, '-') ??
    // Sales order: "销售日期：2026-03-15"
    flat.match(/销售日期[：:]\s*(\d{4}-\d{2}-\d{2})/)?.[1] ??
    flat.match(/(\d{4}[-\/]\d{2}[-\/]\d{2})/)?.[1]?.replace(/\//g, '-') ??
    null

  const totalLine =
    footerTexts.find(t => /TOTAL/i.test(t) && /CTN|CBM|KGS/i.test(t)) ??
    footerTexts.find(t => /CTN|CBM|KGS/i.test(t)) ??
    ''

  // Sales order TOTAL row flat text: "TOTAL: 1587 36839 372377.1 87.57 21772.49 CTN PCS Amount CBM KGS"
  // Five consecutive numbers: CTN, PCS, Amount(RMB), CBM, KGS
  const flatClean = flat.replace(/,/g, '')
  const soTotalsMatch = flatClean.match(
    /TOTAL[:\s]+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i
  )

  const footer_totals: ExtractedDocument['footer_totals'] = {
    total_cartons:
      extractUnit(flat, /TOTAL\s+CARTONS?\s*[:\s]*([\d,]+)/i) ??
      extractUnit(flat, /TOTAL\s+CARTON\s*[:\s]*([\d,]+)/i) ??
      extractUnit(totalLine, /(\d+(?:\.\d+)?)\s*CTNS?/i) ??
      (soTotalsMatch ? parseFloat(soTotalsMatch[1]) || null : null),
    total_cbm:
      extractUnit(flat, /TOTAL\s+CBM\s*[:\s]*([\d.]+)/i) ??
      extractUnit(totalLine, /(\d+(?:\.\d+)?)\s*CBM/i) ??
      (soTotalsMatch ? parseFloat(soTotalsMatch[4]) || null : null),
    total_weight_kg:
      extractUnit(flat, /TOTAL\s+WEIGHT\s*[:\s]*([\d,]+)/i) ??
      extractUnit(totalLine, /(\d+(?:\.\d+)?)\s*KGS?/i) ??
      (soTotalsMatch ? parseFloat(soTotalsMatch[5]) || null : null),
    total_amount_rmb:
      extractUnit(flatClean, /TOTAL\s+COST\s*[:\s]*RMB\s*([\d,]+)/i) ??
      extractUnit(flatClean, /TOTAL\s+COST[^\d]{0,24}([\d,]{4,})/i) ??
      extractUnit(totalLine.replace(/,/g, ''), /[¥￥]([\d.]+)/) ??
      (soTotalsMatch ? parseFloat(soTotalsMatch[3]) || null : null),
    total_amount_usd:
      extractUnit(flat.replace(/,/g, ''), /TOTAL.*?USD\s+([\d.]+)/i) ??
      extractUnit(flat.replace(/,/g, ''), /USD\s+([\d.]+)/i),
    exchange_rate: extractUnit(flat, /(?:EXCHANGE\s+RATE|RATE)\s*[:\s]+([\d.]+)/i),
    goods_balance_usd: null,
    freight_usd: extractUnit(flat.replace(/,/g, ''), /FREIGHT.*?USD\s+([\d.]+)/i),
    total_balance_usd:
      extractUnit(flat.replace(/,/g, ''), /(?:TOTAL\s+BALANCE|BALANCE\s+TOTAL).*?USD\s+([\d.]+)/i),
  }

  const payments = extractPayments(allText)

  return {
    doc_number,
    client_id,
    container_no,
    document_date,
    document_type: docType,
    footer_totals,
    payments,
  }
}

function extractPayments(text: string): ExtractedDocument['payments'] {
  const payments: ExtractedDocument['payments'] = []
  for (const line of text.split('\n')) {
    const amountMatch = line.replace(/,/g, '').match(/USD\s+([\d.]+)/i)
    if (!amountMatch) continue
    const amount_usd = parseFloat(amountMatch[1])
    if (!isFinite(amount_usd) || amount_usd <= 0) continue

    const dateMatch = line.match(/(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/)
    const payment_date = dateMatch?.[1]?.replace(/\//g, '-') ?? null

    const isBalance = /BALANCE|SECOND|REMAINING/i.test(line)
    const isFreight = /FREIGHT/i.test(line)
    payments.push({
      payment_date,
      amount_usd,
      payment_type: isFreight ? 'freight' : isBalance ? 'balance' : 'deposit',
    })
  }
  return payments
}

// ── Cell value parsers ────────────────────────────────────────────────────────

function parseNum(raw: string | undefined): number | null {
  if (!raw?.trim()) return null
  const cleaned = raw
    .replace(/[¥￥%]/g, '')
    .replace(/\b(PCS|CTN|CTNS|KGS|KG|CBM|CM|MM)\b/gi, '')
    .replace(/,/g, '')
    .trim()
  const n = parseFloat(cleaned)
  return isFinite(n) ? n : null
}

function parseStr(raw: string | undefined): string | null {
  const s = raw?.trim()
  return s ? s : null
}

function extractUnit(text: string, re: RegExp): number | null {
  const m = text.match(re)
  if (!m) return null
  const n = parseFloat(m[1].replace(/,/g, ''))
  return isFinite(n) ? n : null
}
