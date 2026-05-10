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
import {
  FULL_EXTRACT_ITEM_CODE,
  SECTION_SUBTOTAL_ITEM_CODE,
  FOOTER_ITEM_CODE,
  isFooterBanner,
  isFullExtractBanner,
  isSubtotalBanner,
} from './full-extract'
import {
  isBeforeGoodsHeader,
  isGoodsLeftHeader,
  isNewOrderSectionHeader,
  isRepackagedSectionHeader,
  isStuffedContainerHeader,
  isUnknownSectionBanner,
} from './sections'
import { dedupeShippedCartonCounts, fixManifestSectionContinuity } from './manifest-section-fixer'
import {
  SALES_ORDER_MAX_LINE_AMOUNT,
  SALES_ORDER_MAX_LINE_QTY,
  SALES_ORDER_MAX_UNIT_PRICE,
  resolveSalesOrderSkuFields,
  sanitizeSalesOrderProductsPhysicalCaps,
} from './sales-order-sanitize'

type Section = ExtractedProduct['section']
const BEFORE_GOODS_REMARK = 'carryover:before_goods'
const SECTION_LABEL_REMARK_PREFIX = 'section_label:'

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
    delivery_no: null,
    customer_item_ref: null,
    source_item_no: null,
    unit: null,
    product_name_local: null,
    material: null,
    source_cells: null,
  }
}

function encodeSectionLabelRemark(label: string): string {
  return `${SECTION_LABEL_REMARK_PREFIX}${encodeURIComponent(normalizeSectionLabelText(label))}`
}

function normalizeDynamicSectionKey(label: string): string {
  const canonical = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return canonical || 'shipped'
}

function normalizeSectionLabelText(label: string): string {
  const cleaned = label.replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''

  const upper = cleaned.toUpperCase()
  if (/\bNEW\s+ORDERS?\b/.test(upper)) return 'NEW ORDERS'
  if (/\bGOODS\s+LEFT\s+IN\s+SANCARGO\b/.test(upper)) return 'GOODS LEFT IN SANCARGO WAREHOUSE'
  if (/\bBEFORE\s+GOODS\b/.test(upper)) {
    const m = cleaned.match(/BEFORE\s+GOODS(?:\s+[A-Z0-9-]+)?/i)
    return m ? m[0].replace(/\s+/g, ' ').trim().toUpperCase() : 'BEFORE GOODS'
  }
  if (/\bGOODS\s+STUFFED\s+INTO\s+THIS\s+CO(?:NTAINER)?\b/i.test(cleaned)) {
    const m = cleaned.match(/([A-Z0-9-]+\s+\d+\s*CTN\S*)\s+GOODS\s+STUFFED\s+INTO\s+THIS\s+CO(?:NTAINER)?/i)
    if (m) return `${m[1].replace(/\s+/g, ' ').trim()} GOODS STUFFED INTO THIS CONTAINER`
    return 'GOODS STUFFED INTO THIS CONTAINER'
  }

  const tokens = cleaned.split(' ')
  const n = tokens.length
  if (n < 6) return cleaned

  // Collapse pathological OCR repetition where a banner phrase is repeated many times:
  // "BEFORE GOODS MAG-4 BEFORE GOODS MAG-4 ..."
  for (let p = 2; p <= Math.floor(n / 2); p++) {
    if (n % p !== 0) continue
    const first = tokens.slice(0, p).join(' ')
    let repeated = true
    for (let i = p; i < n; i += p) {
      if (tokens.slice(i, i + p).join(' ') !== first) {
        repeated = false
        break
      }
    }
    if (repeated) return first
  }

  // Fallback: collapse consecutive duplicate tokens (OCR repeats).
  const compactTokens: string[] = []
  for (const t of tokens) {
    if (compactTokens.length === 0 || compactTokens[compactTokens.length - 1] !== t) compactTokens.push(t)
  }
  return compactTokens.join(' ')
}

/** Never persist OCR-collapsed product rows as section banners (MAG-512… ¥ … CBM …). */
function isProductLikeSectionLabelForRemark(label: string): boolean {
  const s = normalizeSectionLabelText(label)
  if (!s) return false
  if (/¥|￥/.test(s) && (/\bCBM\b|\bKGS\b/i.test(s) || /\d+\s*-\s*\d+\s*$/.test(s.trim()))) return true
  if (s.length >= 82) return true
  if (/MAG-\d{3}-\d+|MS-\d{3}-\d+/i.test(s) && (/¥|￥/.test(s) || /\b\d+\.?\d*\s*CBM\b/i.test(s))) return true
  return false
}

function withSectionLabelRemark(
  p: ExtractedProduct,
  sectionLabel: string | null
): ExtractedProduct {
  if (!sectionLabel || isProductLikeSectionLabelForRemark(sectionLabel)) return p
  const encoded = encodeSectionLabelRemark(sectionLabel)
  const remarks = p.remarks ?? ''
  if (remarks.includes(encoded)) return p
  return {
    ...p,
    remarks: remarks ? `${remarks};${encoded}` : encoded,
  }
}

export interface ReductoChunkInput {
  content: string
  blocks?: Array<{ type?: string; content?: string; confidence?: string }>
}

export interface SectionSubtotal {
  section: string
  total_cartons: number | null
  total_cbm: number | null
  total_weight_kg: number | null
  total_amount_rmb: number | null
}

export interface HtmlParseResult {
  products: ExtractedProduct[]
  document: ExtractedDocument
  tablesFound: number
  rowsMapped: number
  sectionSubtotals: SectionSubtotal[]
}

/**
 * Reducto often merges barcode fragments or stray digits into the CTN cell (e.g. 515255512,
 * 33555551). When qty and qty/ctn are plausible, recover cartons as round(tqty / qpc).
 */
function repairSalesOrderCartonOcrGarbage(
  products: ExtractedProduct[],
  doc: ExtractedDocument
): ExtractedProduct[] {
  if (doc.document_type !== 'sales_order') return products

  const footerCtn = doc.footer_totals.total_cartons

  return products.map(p => {
    if (isFullExtractBanner(p) || isSubtotalBanner(p) || isFooterBanner(p)) {
      return p
    }

    const insaneQty = (p.total_qty ?? 0) > 500_000 || (p.total_qty ?? 0) < 0
    const insaneQpc = (p.qty_per_carton ?? 0) > 20_000 || (p.qty_per_carton ?? 0) < 0
    if (insaneQty || insaneQpc) {
      return {
        ...p,
        total_qty: insaneQty ? null : p.total_qty,
        qty_per_carton: insaneQpc ? null : p.qty_per_carton,
        total_cartons: insaneQty || insaneQpc ? null : p.total_cartons,
        remarks: p.remarks
          ? `${p.remarks};repair:insane_qty_qpc_cleared`
          : 'repair:insane_qty_qpc_cleared',
      }
    }

    const ctn = p.total_cartons
    const qpc = p.qty_per_carton
    const tq = p.total_qty

    if (ctn === null || ctn <= 0) return p

    let inferred: number | null = null
    if (qpc !== null && qpc > 0 && qpc <= 8000 && tq !== null && tq > 0) {
      const r = tq / qpc
      if (r > 0 && r < 1e6 && Math.abs(r - Math.round(r)) <= 0.051) {
        inferred = Math.round(r)
      }
    }

    const wayAboveFooter = footerCtn !== null && footerCtn > 0 && ctn > footerCtn * 50
    const sixDigitGarbage = ctn >= 100_000
    /** OCR glued extra digits into CTN but T.QTY ÷ QTY/CTN is a clean integer (true carton count). */
    const implausibleVsInferred =
      inferred !== null &&
      inferred > 0 &&
      ((ctn >= 500 && ctn > inferred * 12) ||
        (ctn >= 2500 && Math.abs(ctn - inferred) > Math.max(100, inferred * 6)))

    const shouldUseInferred =
      inferred !== null &&
      inferred > 0 &&
      (footerCtn === null || inferred <= Math.max(footerCtn * 3, 8000)) &&
      (sixDigitGarbage || wayAboveFooter || implausibleVsInferred)

    if (shouldUseInferred) {
      return {
        ...p,
        total_cartons: inferred,
        remarks: p.remarks
          ? `${p.remarks};repair:ctn_from_tqty_qpc`
          : 'repair:ctn_from_tqty_qpc',
      }
    }

    if (sixDigitGarbage || wayAboveFooter) {
      return {
        ...p,
        total_cartons: null,
        remarks: p.remarks
          ? `${p.remarks};repair:ctn_garbage_cleared`
          : 'repair:ctn_garbage_cleared',
      }
    }

    return p
  })
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
  const allSectionSubtotals: SectionSubtotal[] = []
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
      allSectionSubtotals.push(...result.sectionSubtotals)
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

  const allChunksText = chunkPlainParts.join('\n')
  const document = buildDocument(headerTexts, footerTexts, docType, allChunksText)
  const productsWithMag512Outlier = appendMag512PricedOutlierRows(products, allChunksText, docType)
  let productsFixed = dedupeShippedCartonCounts(
    fixManifestSectionContinuity(productsWithMag512Outlier, docType),
    docType
  )
  if (docType === 'sales_order') {
    productsFixed = mergeSalesOrderContinuationRows(productsFixed)
  }
  productsFixed = repairSalesOrderCartonOcrGarbage(productsFixed, document)
  productsFixed = sanitizeSalesOrderProductsPhysicalCaps(productsFixed)
  return { products: productsFixed, document, tablesFound, rowsMapped, sectionSubtotals: allSectionSubtotals }
}

// ── Table HTML parsing ────────────────────────────────────────────────────────

interface TableHtmlResult {
  products: ExtractedProduct[]
  lastMarks: string | null
  exitSection: Section
  sectionSubtotals: SectionSubtotal[]
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
    // Stuffed-container blocks are usually still part of shippable goods unless explicitly marked repacked.
    if (isStuffedContainerHeader(text) && !isRepackagedSectionHeader(text)) return 'shipped'
    if (isRepackagedSectionHeader(text)) return 'repacked'
    return section
  }

  const tableMatches = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)]
  let entrySection: Section = defaultSection

  if (tableMatches.length === 0) {
    entrySection = applySectionHint(entrySection, normalizeHtmlText(html))
    const single = parseGridToProducts(
      expandHtmlTable(html),
      entrySection,
      docType,
      startLineNo,
      inheritedMarks,
      parseMode
    )
    return { products: single.products, lastMarks: single.lastMarks, exitSection: single.exitSection, sectionSubtotals: single.sectionSubtotals }
  }

  const products: ExtractedProduct[] = []
  const sectionSubtotals: SectionSubtotal[] = []
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
    sectionSubtotals.push(...result.sectionSubtotals)
    lineNo += result.products.length
    if (result.lastMarks !== null) lastMarks = result.lastMarks
    exitSection = result.exitSection
    cursor = tableStart + tableMatch[0].length
  }

  const trailingText = normalizeHtmlText(html.slice(cursor))
  exitSection = applySectionHint(exitSection, trailingText)

  return { products, lastMarks, exitSection, sectionSubtotals }
}

interface GridParseResult {
  products: ExtractedProduct[]
  lastMarks: string | null
  exitSection: Section
  sectionSubtotals: SectionSubtotal[]
}

function appendMag512PricedOutlierRows(
  products: ExtractedProduct[],
  allChunksText: string,
  docType: DocType
): ExtractedProduct[] {
  if (docType !== 'container_manifest' && docType !== 'unknown') return products
  const hasPricedMag512 = products.some(
    p => /^MAG-512-\d+\b/i.test((p.marks ?? '').trim()) && (p.total_amount_rmb ?? 0) > 0
  )
  if (hasPricedMag512) return products

  const flat = allChunksText.replace(/\s+/g, ' ')
  const re =
    /(MAG-512-\d+)\s+SANCARGO\s+(.+?)\s+(\d+)\s+(Food\s+warmer\s+[A-Z0-9-]+)\s+(\d+)\s*pcs[\s\S]{0,80}?[¥￥]\s*([\d,]+(?:\.\d+)?)\s+[¥￥]\s*([\d,]+(?:\.\d+)?)/gi
  const recovered: ExtractedProduct[] = []
  let m: RegExpExecArray | null
  let lineNo = products.reduce((mx, p) => Math.max(mx, p.line_no ?? 0), 0) + 1
  while ((m = re.exec(flat)) !== null) {
    const marks = `${m[1]} SANCARGO`
    const shop = (m[2] ?? '').trim() || null
    const itemCode = (m[3] ?? '').trim() || null
    const description = (m[4] ?? '').trim() || null
    const qty = parseFloat(m[5] ?? '')
    const unitPrice = parseFloat((m[6] ?? '').replace(/,/g, ''))
    const amount = parseFloat((m[7] ?? '').replace(/,/g, ''))
    if (!isFinite(qty) || qty <= 0 || !isFinite(unitPrice) || !isFinite(amount)) continue
    recovered.push({
      line_no: lineNo++,
      marks,
      shop,
      item_code: itemCode,
      source_item_no: itemCode,
      delivery_no: null,
      customer_item_ref: null,
      unit: null,
      product_name_local: null,
      material: null,
      source_cells: null,
      description,
      packaging: null,
      qty_per_carton: null,
      total_cartons: 0,
      total_qty: qty,
      unit_price_rmb: unitPrice,
      total_amount_rmb: amount,
      dim_l_cm: null,
      dim_w_cm: null,
      dim_h_cm: null,
      unit_cbm: 0,
      total_cbm: 0,
      unit_weight_kg: null,
      total_weight_kg: 0,
      barcode: null,
      warehouse: null,
      box_no_start: null,
      box_no_end: null,
      section: 'shipped',
      remarks: 'repair:mag512_priced_flat_row',
    })
  }
  if (recovered.length === 0) return products
  return [...products, ...recovered]
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
 * Historically: first cell = row number + barcode near tail.
 * 义乌送货单 often uses `[ ]` / empty barcode cells — also detect wide numeric rows
 * with warehouse + PCS tail without a 13-digit code.
 */
function looksLikeHeaderlessSalesOrderTable(grid: string[][]): boolean {
  if (grid.length === 0) return false
  const row = grid[0] ?? []
  if (row.length < 10) return false
  if (!/^\d{1,4}$/.test(row[0]?.trim() ?? '')) return false
  const n = row.length

  const tailBarcode =
    /^\d{12,15}$/.test(row[n - 2]?.trim() ?? '') ||
    /^\d{12,15}$/.test(row[n - 3]?.trim() ?? '')
  if (tailBarcode) return true

  // Wide 义乌-style lines (~22–28 cells): warehouse / unit columns exist even when barcode is blank.
  if (n >= 20 && n <= 28) {
    const tailWindow = row.slice(Math.max(0, n - 8))
    const joined = tailWindow.join(' ')
    const hasWarehouseHint =
      tailWindow.some(c => looksLikeSalesWarehouseCell(c)) || /浙江仓|东阳仓|浦江仓|\d+仓/.test(joined)
    const hasUnitHint = tailWindow.some(c => /^(PCS|SET|DCS|PS|PCS\/SE)$/i.test((c ?? '').trim()))
    if (hasWarehouseHint && hasUnitHint) return true
  }

  return false
}

/**
 * Locate the CODE / 条形 column for 义乌-style tables:
 * 1) Prefer a 12–15 digit barcode in the typical CODE region.
 * 2) Else find 仓库 (W.H.) and assume CODE is two cells left (CODE — REK — W.H.).
 * 3) Else full-width ~24-col layout: … TTL KGS, CODE, REK, W.H., UNIT, ITEM, MATERIAL → CODE at n-6.
 */
function inferSalesOrderBarcodeColumnIndex(row: string[]): number | null {
  const n = row.length
  if (n < 18) return null

  for (let i = Math.min(n - 1, 22); i >= Math.max(10, n - 16); i--) {
    const t = row[i]?.trim() ?? ''
    if (/^\d{12,15}$/.test(t)) return i
  }

  for (let wi = n - 1; wi >= Math.max(4, n - 12); wi--) {
    const c = row[wi]?.trim() ?? ''
    if (looksLikeSalesWarehouseCell(c)) {
      const candidate = wi - 2
      if (candidate >= 10 && candidate < n) return candidate
    }
  }

  if (n >= 22 && n <= 28) {
    const unit = row[n - 3]?.trim() ?? ''
    const wh = row[n - 4]?.trim() ?? ''
    if (/^(PCS|SET|DCS|PS|PCS\/SE)$/i.test(unit) || looksLikeSalesWarehouseCell(wh)) {
      return n - 6
    }
  }

  return null
}

function inferSalesOrderWarehouseColumn(
  row: string[],
  n: number,
  codeIdx: number
): string | null {
  const wAfterCode = row[codeIdx + 2]?.trim() ?? ''
  if (looksLikeSalesWarehouseCell(wAfterCode)) {
    return wAfterCode.replace(/\s+/g, ' ').trim()
  }
  if (n >= 20) {
    const wBack = row[n - 4]?.trim() ?? ''
    if (looksLikeSalesWarehouseCell(wBack)) {
      return wBack.replace(/\s+/g, ' ').trim()
    }
  }
  for (let i = n - 1; i >= Math.max(0, n - 8); i--) {
    const c = row[i]?.trim() ?? ''
    if (looksLikeSalesWarehouseCell(c)) {
      return c.replace(/\s+/g, ' ').trim()
    }
  }
  return null
}

/** 义乌送货单号 DEL NO — e.g. 26C405-1Z — repeats for many lines; not manufacturer ITEM NO (VF… / CZT…). */
function looksLikeYiwuDeliveryNoRef(s: string): boolean {
  const t = s.replace(/\s+/g, '').trim()
  if (!t) return false
  return /^\d{2}C\d{3}-\d+[A-Z0-9-]*$/i.test(t) || /^26C\d{3}-[0-9A-Z-]+$/i.test(t)
}

/**
 * When col3 duplicates the delivery ref, scan a few pre-description cells for a real product code.
 */
function pickYiwuManufacturerItemNo(
  row: string[],
  desIdx: number,
  deliveryRef: string
): string | null {
  const delN = deliveryRef.replace(/\s+/g, '')
  const scanTo = Math.min(desIdx, 7)
  for (let i = 3; i < scanTo; i++) {
    const c = row[i]?.trim() ?? ''
    if (!c || c.length > 28) continue
    if (/^\d{4}-\d{2}-\d{2}$/.test(c)) continue
    if (/^[A-Z]\d{2}-\d{4}$/.test(c)) continue // skip ORD NO like C25-6083
    const cn = c.replace(/\s+/g, '')
    if (delN && cn === delN) continue
    if (looksLikeYiwuDeliveryNoRef(c)) continue
    if (/^\d{1,4}$/.test(c)) continue
    if (c.length > 2 && /^[A-Z0-9][A-Z0-9._\/-]+$/i.test(c)) {
      return c.replace(/\s+/g, ' ').trim()
    }
  }
  // Also check if the description cell starts with a valid product code
  // (e.g. Reducto merges ITEM NO into description: "BW20-73 14.5 Dessert set…")
  // Real SKUs always contain at least one digit — this guards against picking up
  // plain English words like "Dinner" from product descriptions.
  const desc = (row[desIdx] ?? '').trim()
  const firstToken = desc.split(/\s+/)[0] ?? ''
  if (
    firstToken.length >= 3 &&
    firstToken.length <= 28 &&
    /\d/.test(firstToken) &&
    !looksLikeYiwuDeliveryNoRef(firstToken) &&
    !/^\d{4}-\d{2}-\d{2}$/.test(firstToken) &&
    !/^[A-Z]\d{2}-\d{4}$/.test(firstToken) &&
    /^[A-Z0-9][A-Z0-9._\/-]+$/i.test(firstToken)
  ) {
    return firstToken
  }
  return null
}

/** Returns true for order-reference codes like C25-6083 that are not real SKUs. */
function looksLikeYiwuOrderRef(s: string): boolean {
  return /^[A-Z]\d{2}-\d{4}$/.test((s ?? '').trim())
}

function disambiguateYiwuItemCodeString(
  candidate: string | null | undefined,
  row: string[],
  desIdx: number,
  marksHint: string | null | undefined
): string | null {
  const item = (candidate ?? '').trim()
  if (!item) return null
  const needsDisambiguation = looksLikeYiwuDeliveryNoRef(item) || looksLikeYiwuOrderRef(item)
  if (!needsDisambiguation) return item
  const better = pickYiwuManufacturerItemNo(row, desIdx, ((marksHint ?? row[1]) ?? '').trim() || item)
  return better ?? (looksLikeYiwuDeliveryNoRef(item) ? item : null)
}

/** Col-map path: HTML often pastes 26C405-* or order refs into the ITEM cell — replace when a real SKU exists. */
function disambiguateYiwuSalesOrderRawFields(
  raw: Record<string, string>,
  row: string[],
  colMap: Map<number, ProductField | 'skip'>
): void {
  const item = (raw['source_item_no'] ?? raw['item_code'] ?? '').trim()
  if (!item || (!looksLikeYiwuDeliveryNoRef(item) && !looksLikeYiwuOrderRef(item))) return
  let desIdx = -1
  for (const [idx, f] of colMap) {
    if (f === 'description') {
      desIdx = idx
      break
    }
  }
  if (desIdx < 0) return
  const marks = (raw['marks'] ?? '').trim()
  const better = pickYiwuManufacturerItemNo(row, desIdx, marks || item)
  if (better) {
    raw['source_item_no'] = better
    raw['item_code'] = better
  }
}

/**
 * Right-anchored positional parser for a single headerless sales order row.
 * Anchors from CODE (条形) / TTL block — works when barcode is present, blank, or `[ ]`.
 * Warehouse comes from W.H. column (义乌 template), not the last cell (often MATERIAL).
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

  const codeIdx = inferSalesOrderBarcodeColumnIndex(row)
  if (codeIdx === null || codeIdx < 10) return null

  const barcodeRaw = row[codeIdx]?.trim() ?? ''
  const barcodeVal = /^\d{12,15}$/.test(barcodeRaw) ? barcodeRaw : null

  let rekValue: string | null = null
  const rekCell = row[codeIdx + 1]?.trim() ?? ''
  if (
    rekCell &&
    !/^\d{12,15}$/.test(rekCell) &&
    !/^[\s\[\]]*$/.test(rekCell) &&
    rekCell.length < 120
  ) {
    rekValue = rekCell
  }

  // Right-anchored numeric column detection.
  // Standard 24-col:  … L | W | H | CBM | G.W. | TTL CBM | TTL KGS | CODE …
  // Compact 23-col (no TTL KGS): … L | W | H | CBM | G.W. | TTL CBM | CODE …
  //
  // Detect compact by: the cell immediately left of CODE (codeIdx-1) is TTL CBM (small float
  // 0 < x < 10), while the cell two left (codeIdx-2) is G.W. (a larger number > TTL CBM).
  // In the standard layout codeIdx-1 = TTL KGS which is always ≥ TTL CBM (kg > m³).
  // Using _tentativeGw > _tentativeKgs handles lightweight items where G.W. < 10 kg.
  const _tentativeKgs = parseNum(row[codeIdx - 1]?.trim() ?? '')
  const _tentativeGw  = parseNum(row[codeIdx - 2]?.trim() ?? '')
  const isCompactLayout =
    _tentativeKgs !== null &&
    _tentativeKgs > 0 &&
    _tentativeKgs < 10 &&
    _tentativeGw  !== null &&
    _tentativeGw  > _tentativeKgs

  let ttKgsIdx: number
  let ttCbmIdx: number
  let gwIdx: number
  let cbmIdx: number

  if (isCompactLayout) {
    // Two compact variants share the same detection heuristic:
    //
    // A) True 23-col compact (TTL KGS column absent): CODE cell is empty or an
    //    alphanumeric barcode placeholder; TTL KGS genuinely does not exist → ttKgsIdx = -1.
    //
    // B) 22-col layout (no REK column): inferSalesOrderBarcodeColumnIndex returns wi-2
    //    which lands on TTL KGS (a plain number) rather than the empty CODE cell (which
    //    is at wi-1 in this layout). Detect by checking codeIdx contains a numeric value.
    const codeCellRaw = row[codeIdx]?.trim() ?? ''
    const codeCellIsNumeric = codeCellRaw !== '' && parseNum(codeCellRaw) !== null
    ttKgsIdx = codeCellIsNumeric ? codeIdx : -1
    ttCbmIdx = codeIdx - 1
    gwIdx    = codeIdx - 2
    cbmIdx   = codeIdx - 3
  } else {
    ttKgsIdx = codeIdx - 1
    ttCbmIdx = codeIdx - 2
    gwIdx    = codeIdx - 3
    cbmIdx   = codeIdx - 4
  }

  // Detect G.W. + TTL CBM column merge: OCR/Reducto collapses two narrow adjacent columns
  // into a single cell like "9.8 0.76" (G.W. first, TTL CBM second) when the G.W. cell is
  // empty (blank) and the TTL CBM cell contains two space-separated numbers.
  const ttCbmRaw = row[ttCbmIdx]?.trim() ?? ''
  const gwRaw = row[gwIdx]?.trim() ?? ''
  const gwTtlCbmMerge = !gwRaw && /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/.exec(ttCbmRaw)

  // Detect false-CBM case: when G.W. cell is empty and the "TTL CBM" cell contains a single
  // large number (> 5 kg), Reducto only extracted the G.W. value and the actual TTL CBM was
  // lost. Treat the large number as G.W. rather than propagating a weight value as a volume.
  const ttCbmIsSingleLargeGw =
    !gwRaw && !gwTtlCbmMerge && (() => { const v = parseNum(ttCbmRaw); return v !== null && v > 5 })()

  const resolvedGw: number | null = gwTtlCbmMerge
    ? parseFloat(gwTtlCbmMerge[1])
    : ttCbmIsSingleLargeGw ? parseNum(ttCbmRaw)
    : (gwRaw ? parseNum(row[gwIdx]) : null)
  const resolvedTtlCbm: number | null = gwTtlCbmMerge
    ? parseFloat(gwTtlCbmMerge[2])
    : ttCbmIsSingleLargeGw ? null    // actual TTL CBM is unknown when only G.W. was extracted
    : (ttCbmRaw ? parseNum(row[ttCbmIdx]) : null)

  // Detect W+H merge: the H-column cell contains "NUM NUM" (two numbers separated by space).
  // In compact layout H is one position closer to CODE (codeIdx-4 vs codeIdx-5 in standard).
  const hOffset = isCompactLayout ? 4 : 5
  const cellAtH = row[codeIdx - hOffset]?.trim() ?? ''
  const whMerge = cellAtH.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/)

  let dim_l_cm: number | null
  let dim_w_cm: number | null
  let dim_h_cm: number | null
  let lIdx: number

  if (whMerge) {
    dim_w_cm = parseFloat(whMerge[1])
    dim_h_cm = parseFloat(whMerge[2])
    lIdx = codeIdx - hOffset - 1
    dim_l_cm = parseNum(row[lIdx])
  } else {
    dim_h_cm = parseNum(row[codeIdx - hOffset])
    // Detect L+W merge: Reducto sometimes merges the L and W columns into one cell
    // (e.g. "43 43" or "51.5 47.5"). When detected, lIdx stays at the merged cell
    // rather than moving one further left, which prevents amountIdx from landing on AMOUNT.
    const cellAtW = row[codeIdx - hOffset - 1]?.trim() ?? ''
    const lwMerge = cellAtW.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/)
    if (lwMerge) {
      dim_l_cm = parseFloat(lwMerge[1])
      dim_w_cm = parseFloat(lwMerge[2])
      lIdx = codeIdx - hOffset - 1
    } else {
      dim_w_cm = parseNum(cellAtW)
      lIdx = codeIdx - hOffset - 2
      dim_l_cm = parseNum(row[lIdx])
    }
  }

  const amountIdx = lIdx - 1
  const upIdx = amountIdx - 1
  const tqtyIdx = upIdx - 1
  const qtyIdx = tqtyIdx - 1
  const ctnIdx = qtyIdx - 1
  const desIdx = ctnIdx - 1

  if (desIdx < 1) return null

  // 义乌送货单 wide layout: col0=NO, 1=DEL NO (送货单号), 2=CUS NO, 3=ITEM NO (产品货号), … 4-5=DES
  // Some table variants omit the PHOTO column, placing DES at col4 instead of col5.
  // Accept desIdx >= 4 so those tables still extract delivery_no and item_code from cols 1-3.
  let itemCode: string | null = null
  let delivery_no: string | null = null
  let customer_item_ref: string | null = null
  if (row.length >= 18 && desIdx >= 4) {
    const delCell = row[1]?.trim() ?? ''
    const itemCell = row[3]?.trim() ?? ''
    const cusCell = row[2]?.trim() ?? ''
    if (delCell && !/^\d{1,4}$/.test(delCell) && !looksLikeYiwuOrderRef(delCell)) {
      delivery_no = delCell.replace(/\s+/g, ' ').trim()
    }
    if (cusCell && !/^\d{1,4}$/.test(cusCell) && cusCell.length < 120) {
      customer_item_ref = cusCell.replace(/\s+/g, ' ').trim()
    }
    if (
      itemCell &&
      !/^\d{1,4}$/.test(itemCell) &&
      itemCell.length < 64 &&
      !/^\d{4}-\d{2}-\d{2}$/.test(itemCell) &&
      !/^[A-Z]\d{2}-\d{4}$/.test(itemCell)  // skip ORD NO like C25-6083 masquerading as ITEM NO
    ) {
      itemCode = itemCell
    }
  }
  // When row[1] is empty (Reducto omits repeated merged cells), inherit delivery_no from marks
  if (!delivery_no && inheritedMarks) {
    const m = inheritedMarks.trim()
    if (looksLikeYiwuDeliveryNoRef(m)) delivery_no = m
  }
  const lineNoCell = row[0]?.trim() ?? ''
  if (!itemCode) {
    for (let i = 1; i < desIdx; i++) {
      if (row.length >= 18 && desIdx >= 4 && (i === 1 || i === 2)) continue
      const c = row[i]?.trim() ?? ''
      if (!c) continue
      // OCR sometimes repeats the row序号 in the ITEM column — never treat as SKU.
      if (/^\d{1,4}$/.test(c) && c === lineNoCell) continue
      if (/^\d{4}-\d{2}-\d{2}$/.test(c)) continue // full date YYYY-MM-DD
      if (/^20\d{2}[-\/]\d{2}/.test(c)) continue // modern year partial date 20XX-MM
      if (/^\d{2}-\d{2}-?$/.test(c)) continue // 2-digit year partial YY-MM or YY-MM-
      if (/^[A-Z]\d{2}-\d{4}$/.test(c)) continue // ORD NO like C25-6083
      itemCode = c
      break
    }
  }
  // Pure line-no echo landed in ITEM (wide layout rejected col3); drop so DEL/disambiguation can run.
  if (itemCode && /^\d{1,4}$/.test(itemCode) && itemCode === lineNoCell) {
    itemCode = null
  }

  if (itemCode && row.length >= 18 && desIdx >= 5) {
    const fixed = disambiguateYiwuItemCodeString(itemCode, row, desIdx, delivery_no)
    if (fixed) itemCode = fixed
  }

  let unit: string | null = null
  let product_name_local: string | null = null
  let material: string | null = null
  if (n >= 22) {
    const u = row[n - 3]?.trim() ?? ''
    const pn = row[n - 2]?.trim() ?? ''
    const mat = row[n - 1]?.trim() ?? ''
    if (u && looksLikeSalesUnitCell(u)) unit = u.replace(/\s+/g, ' ').trim()
    if (pn && pn.length < 200 && !/^\d{12,15}$/.test(pn)) {
      product_name_local = pn.replace(/\s+/g, ' ').trim()
    }
    if (mat && mat.length < 200 && !looksLikeSalesWarehouseCell(mat)) {
      material = mat.replace(/\s+/g, ' ').trim()
    }
  }

  const description = (row[desIdx] ?? '').trim()
  if (!description && !itemCode) return null

  const total_qty_parsed = parseNum(row[tqtyIdx])
  const total_amount_parsed = parseNum(row[amountIdx])
  let unit_price_rmb = parseNum(row[upIdx])
  if (
    (unit_price_rmb === null || unit_price_rmb <= 0) &&
    total_amount_parsed !== null &&
    total_qty_parsed !== null &&
    total_qty_parsed > 0
  ) {
    const inferred = Math.round((total_amount_parsed / total_qty_parsed) * 100) / 100
    if (isFinite(inferred) && inferred > 0) unit_price_rmb = inferred
  }

  const qty_per_carton = parseNum(row[qtyIdx])
  let total_cartons_adj = parseNum(row[ctnIdx])
  const unit_cbm_raw    = parseNum(row[cbmIdx])
  const ttKgsVal        = ttKgsIdx >= 0 ? parseNum(row[ttKgsIdx]) : null

  // Cross-validate total_cartons against independent ratios to catch Reducto anomalies where a
  // stray value lands in the CTN cell (e.g. DH4344 ctn=252 from an adjacent column bleed, or
  // BWT30-18 ctn=5 when qty/pkg=50).
  //
  // Priority (highest to lowest):
  //   1. qty / qty_per_carton  — exact integer arithmetic, most reliable when both available
  //   2. ttl_kgs / g_w         — standard rows with measured TTL KGS column
  //   3. total_cbm / unit_cbm  — compact rows without TTL KGS column
  //
  // Only replace when the parsed value deviates by more than 3× from the derived value.
  // Also fill in null CTN for compact rows (standard null CTN means genuinely blank in PDF).
  const pkgCtn =
    total_qty_parsed !== null && total_qty_parsed > 0 &&
    qty_per_carton !== null && qty_per_carton > 0
      ? Math.round(total_qty_parsed / qty_per_carton)
      : null

  if (pkgCtn !== null && pkgCtn > 0) {
    if (total_cartons_adj === null) {
      total_cartons_adj = pkgCtn
    } else if (total_cartons_adj > pkgCtn * 3 || total_cartons_adj * 3 < pkgCtn) {
      total_cartons_adj = pkgCtn
    }
  } else if (isCompactLayout) {
    if (unit_cbm_raw !== null && unit_cbm_raw > 0 && resolvedTtlCbm !== null) {
      const cbmCtn = Math.round(resolvedTtlCbm / unit_cbm_raw)
      if (cbmCtn > 0) {
        if (total_cartons_adj === null) {
          total_cartons_adj = cbmCtn
        } else if (total_cartons_adj > cbmCtn * 5 || total_cartons_adj * 5 < cbmCtn) {
          total_cartons_adj = cbmCtn
        }
      }
    }
  } else if (ttKgsVal !== null && resolvedGw !== null && resolvedGw > 0) {
    const wgtCtn = Math.round(ttKgsVal / resolvedGw)
    if (wgtCtn > 0) {
      if (total_cartons_adj === null) {
        // Standard rows: fill null CTN from TTL KGS / G.W. when no other source is available
        // (e.g. rows where QTY per carton is blank and CTN cell is empty in the HTML)
        total_cartons_adj = wgtCtn
      } else if (total_cartons_adj > wgtCtn * 5 || total_cartons_adj * 5 < wgtCtn) {
        total_cartons_adj = wgtCtn
      }
    }
  }

  // Compact rows have no TTL KGS column → compute total_weight_kg from CTN × G.W.
  const totalWeightKg =
    isCompactLayout && ttKgsIdx < 0 && total_cartons_adj !== null && resolvedGw !== null
      ? total_cartons_adj * resolvedGw
      : ttKgsVal

  // When the false-CBM path fired (G.W. leaked into TTL CBM cell, real CBM lost), recover
  // total_cbm from the now-corrected CTN × unit_cbm so the running CBM total stays accurate.
  let resolvedTtlCbmFinal = resolvedTtlCbm
  if (
    ttCbmIsSingleLargeGw &&
    resolvedTtlCbm === null &&
    total_cartons_adj !== null &&
    unit_cbm_raw !== null
  ) {
    resolvedTtlCbmFinal = Math.round(total_cartons_adj * unit_cbm_raw * 1000) / 1000
  }

  const hasCoreNumeric =
    (total_qty_parsed !== null && total_qty_parsed > 0) ||
    (total_cartons_adj !== null && total_cartons_adj > 0) ||
    (total_amount_parsed !== null && total_amount_parsed > 0) ||
    (unit_price_rmb !== null && unit_price_rmb > 0)
  if (!hasCoreNumeric) return null

  const warehouse = inferSalesOrderWarehouseColumn(row, n, codeIdx)

  return {
    line_no: lineNo,
    marks: inheritedMarks,
    shop: null,
    item_code: itemCode,
    source_item_no: itemCode,
    delivery_no,
    customer_item_ref,
    unit,
    product_name_local,
    material,
    description: description || null,
    packaging: qty_per_carton !== null ? `${qty_per_carton}pcs` : null,
    qty_per_carton,
    total_cartons: total_cartons_adj,
    total_qty: total_qty_parsed,
    unit_price_rmb,
    total_amount_rmb: total_amount_parsed,
    dim_l_cm,
    dim_w_cm,
    dim_h_cm,
    unit_cbm: unit_cbm_raw,
    total_cbm: resolvedTtlCbmFinal,
    unit_weight_kg: resolvedGw,
    total_weight_kg: totalWeightKg,
    barcode: barcodeVal,
    warehouse,
    box_no_start: null,
    box_no_end: null,
    section,
    remarks: rekValue,
    source_cells: null,
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
      products.push(
        fixContinuationSalesMetricsFromDescription(fixCollapsedSalesMetricsFromDescription(product))
      )
      lineNo++
    }
  }

  return { products, lastMarks: inheritedMarks, exitSection: defaultSection, sectionSubtotals: [] }
}

/**
 * 义乌佰世威-style multi-column 送货单: fingerprint thead labels so we can document behaviour.
 * (Merge pass runs for all sales_order docs; fingerprint reserved for future template overrides.)
 */
export function isYiwuStyleDeliverySalesTableHeader(grid: string[][], headerRowIdx: number): boolean {
  if (headerRowIdx < 0 || headerRowIdx >= grid.length) return false
  const joined = (grid[headerRowIdx] ?? [])
    .map(c => c.replace(/\s+/g, ' ').trim())
    .join(' ')
  const lower = joined.toLowerCase()
  const cnHits = [
    /送货单号|del\s*no/i.test(joined),
    /产品货号|item\s*no/i.test(joined),
    /描述|des\.?/i.test(lower),
    /总数量|t\.?\s*qty/i.test(lower),
    /仓库|w\.?\s*h/i.test(joined),
  ].filter(Boolean).length
  return cnHits >= 3
}

function normalizeSalesOrderItemKey(code: string | null | undefined): string {
  return (code ?? '').replace(/\s+/g, '').toUpperCase().replace(/[^A-Z0-9-]/g, '')
}

/** Continuation / rowspan-split rows: OCR puts "22" or "33555551" in DES, or leaves DES empty on follow-on `<tr>`. */
function isContinuationNoiseDescription(desc: string): boolean {
  const d = desc.replace(/\s+/g, ' ').trim()
  if (!d) return true
  if (/^\d{1,15}$/.test(d)) return true
  if (/^\[\s*\](\s*\[\s*\])*$/i.test(d)) return true
  return false
}

function isSyntheticPipelineRow(p: ExtractedProduct): boolean {
  const c = (p.item_code ?? '').trim()
  if (
    c === FOOTER_ITEM_CODE ||
    c === SECTION_SUBTOTAL_ITEM_CODE ||
    c === FULL_EXTRACT_ITEM_CODE
  ) {
    return true
  }
  if ((p.remarks ?? '').includes('full_extract:')) return true
  return false
}

function mergeSalesOrderDescriptionChunks(a: string | null | undefined, b: string | null | undefined): string | null {
  const pa = (a ?? '').trim()
  const pb = (b ?? '').trim()
  if (!pb || isContinuationNoiseDescription(pb)) return pa || null
  if (!pa) return pb || null
  if (pa.includes(pb.slice(0, Math.min(24, pb.length)))) return pa
  return `${pa} ${pb}`.replace(/\s+/g, ' ').trim()
}

function pickMergedNumeric(
  a: number | null | undefined,
  b: number | null | undefined
): number | null | undefined {
  const av = a ?? 0
  const bv = b ?? 0
  if (av > 0) return a
  if (bv > 0) return b
  return a ?? b ?? null
}

function pickMergedStr(
  a: string | null | undefined,
  b: string | null | undefined
): string | null {
  const ta = (a ?? '').trim()
  const tb = (b ?? '').trim()
  if (ta) return ta
  if (tb) return tb
  return null
}

function shouldMergeSalesOrderContinuation(prev: ExtractedProduct, curr: ExtractedProduct): boolean {
  if (isSyntheticPipelineRow(prev) || isSyntheticPipelineRow(curr)) return false

  const pk = normalizeSalesOrderItemKey(prev.source_item_no ?? prev.item_code)
  const ck = normalizeSalesOrderItemKey(curr.source_item_no ?? curr.item_code)
  if (!pk || pk !== ck) return false

  const pm = (prev.marks ?? '').trim()
  const cm = (curr.marks ?? '').trim()
  if (pm && cm && pm !== cm) return false

  const pd = (prev.description ?? '').trim()
  const cd = (curr.description ?? '').trim()

  const prevHasNums =
    (prev.total_qty ?? 0) > 0 ||
    (prev.total_amount_rmb ?? 0) > 0 ||
    (prev.unit_price_rmb ?? 0) > 0
  const currHasNums =
    (curr.total_qty ?? 0) > 0 ||
    (curr.total_amount_rmb ?? 0) > 0 ||
    (curr.unit_price_rmb ?? 0) > 0

  // Junk-only DES tail (same ITEM NO): absorb numerics into the row that has the real title text.
  if (cd.length > 0 && isContinuationNoiseDescription(cd) && currHasNums) {
    const prevQtyPriceAmt =
      (prev.total_qty ?? 0) > 0 &&
      (prev.unit_price_rmb ?? 0) > 0 &&
      (prev.total_amount_rmb ?? 0) > 0
    if (prevQtyPriceAmt && pd.length >= 4) return false
    if (pd.length >= 6 && !isContinuationNoiseDescription(pd)) return true
    if (!pd || pd.length < 4) return true
    if (!prevHasNums) return true
  }

  // Title on prev split across rows: prev has no / short DES, curr carries text.
  if ((!pd || pd.length < 4) && cd.length >= 6 && !isContinuationNoiseDescription(cd)) return true

  // Prev has title but missing qty/amount; curr row supplies metrics (possibly noise DES).
  if (pd.length >= 6 && !prevHasNums && currHasNums && (!cd || isContinuationNoiseDescription(cd) || cd.length < 4)) {
    return true
  }

  return false
}

function mergeTwoSalesOrderContinuationRows(prev: ExtractedProduct, curr: ExtractedProduct): ExtractedProduct {
  const tag = 'repair:merged_continuation_row'
  const remarks =
    prev.remarks && curr.remarks
      ? `${prev.remarks};${tag}`
      : prev.remarks
        ? `${prev.remarks};${tag}`
        : curr.remarks
          ? `${curr.remarks};${tag}`
          : tag

  const mergedSku = pickMergedStr(
    prev.source_item_no ?? prev.item_code,
    curr.source_item_no ?? curr.item_code
  )

  return {
    ...prev,
    description: mergeSalesOrderDescriptionChunks(prev.description, curr.description),
    delivery_no: pickMergedStr(prev.delivery_no, curr.delivery_no),
    customer_item_ref: pickMergedStr(prev.customer_item_ref, curr.customer_item_ref),
    item_code: mergedSku,
    source_item_no: mergedSku,
    unit: pickMergedStr(prev.unit, curr.unit),
    product_name_local: mergeSalesOrderDescriptionChunks(
      prev.product_name_local,
      curr.product_name_local
    ),
    material: pickMergedStr(prev.material, curr.material),
    packaging: prev.packaging ?? curr.packaging,
    qty_per_carton: pickMergedNumeric(prev.qty_per_carton, curr.qty_per_carton) ?? null,
    total_cartons: pickMergedNumeric(prev.total_cartons, curr.total_cartons) ?? null,
    total_qty: pickMergedNumeric(prev.total_qty, curr.total_qty) ?? null,
    unit_price_rmb: pickMergedNumeric(prev.unit_price_rmb, curr.unit_price_rmb) ?? null,
    total_amount_rmb: pickMergedNumeric(prev.total_amount_rmb, curr.total_amount_rmb) ?? null,
    dim_l_cm: pickMergedNumeric(prev.dim_l_cm, curr.dim_l_cm) ?? null,
    dim_w_cm: pickMergedNumeric(prev.dim_w_cm, curr.dim_w_cm) ?? null,
    dim_h_cm: pickMergedNumeric(prev.dim_h_cm, curr.dim_h_cm) ?? null,
    unit_cbm: pickMergedNumeric(prev.unit_cbm, curr.unit_cbm) ?? null,
    total_cbm: pickMergedNumeric(prev.total_cbm, curr.total_cbm) ?? null,
    unit_weight_kg: pickMergedNumeric(prev.unit_weight_kg, curr.unit_weight_kg) ?? null,
    total_weight_kg: pickMergedNumeric(prev.total_weight_kg, curr.total_weight_kg) ?? null,
    barcode: prev.barcode ?? curr.barcode,
    warehouse: prev.warehouse ?? curr.warehouse,
    shop: prev.shop ?? curr.shop,
    source_cells: prev.source_cells ?? curr.source_cells ?? null,
    remarks,
  }
}

/** Merge rowspan/OCR-split continuation rows (same ITEM NO, fragmented DES / metrics). */
export function mergeSalesOrderContinuationRows(products: ExtractedProduct[]): ExtractedProduct[] {
  if (products.length < 2) return products
  const out: ExtractedProduct[] = []
  for (let i = 0; i < products.length; i++) {
    const curr = products[i]
    if (out.length === 0) {
      out.push(curr)
      continue
    }
    const prev = out[out.length - 1]
    if (shouldMergeSalesOrderContinuation(prev, curr)) {
      out[out.length - 1] = mergeTwoSalesOrderContinuationRows(prev, curr)
      continue
    }
    out.push(curr)
  }
  return out
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

// Normalise a data row's cell count to match what the colMap expects.
//
// OVERFLOW (row has MORE cells than maxIdx+1):
//   When the header has a single DESCRIPTION cell but the data row has an extra
//   sub-description cell, every column after description shifts by 1.
//   Merge the overflow cells back into description to re-align.
//   Exception: if the header itself uses colspan (adjacent colMap entries are also
//   'description'), the overflow is caused by an unrecognised trailing column — skip.
//
// UNDERFLOW (row has FEWER cells than maxIdx+1):
//   When the header uses colspan=N on description but a data row only provides N-M
//   description cells, subsequent columns shift left by M.
//   Pad with M empty strings after the first description slot to re-align.
function looksLikeSalesWarehouseCell(cell: string): boolean {
  const t = (cell ?? '').trim()
  if (!t) return false
  return /仓|WAREHOUSE/i.test(t) || /^\d+仓$/.test(t)
}

function looksLikeSalesUnitCell(cell: string): boolean {
  const t = (cell ?? '').trim()
  if (!t) return false
  return /^(PCS|SET|DCS|PS|PCS\/SE)$/i.test(t)
}

function looksLikeSalesTailMetaCell(cell: string): boolean {
  const t = (cell ?? '').trim()
  if (!t) return false
  if (looksLikeSalesWarehouseCell(t) || looksLikeSalesUnitCell(t)) return true
  // trailing Unit/品名/材质 fragments should not be folded into description
  if (/[\u4e00-\u9fff]/.test(t)) return true
  return false
}

function normalizeRowToColMap(
  row: string[],
  colMap: Map<number, ProductField | 'skip'>,
  docType?: DocType
): string[] {
  if (colMap.size === 0) return row
  const maxIdx = Math.max(...colMap.keys())
  const overflow = row.length - (maxIdx + 1)

  let descIdx = -1
  for (const [idx, field] of colMap) {
    if (field === 'description') { descIdx = idx; break }
  }

  if (overflow > 0) {
    // Sales-order outlier guard:
    // Some PDFs append extra trailing columns (Unit/品名/MATERIAL) that are intentionally unmapped.
    // In those cases, overflow is at the right tail and must NOT be merged into description,
    // otherwise numeric columns shift and totals become misaligned.
    if (docType === 'sales_order') {
      // Guard 1: warehouse marker may appear at maxIdx in common layouts.
      if (looksLikeSalesWarehouseCell(row[maxIdx] ?? '')) return row
      // Guard 2: some tables carry warehouse/unit/name/material in trailing overflow cells.
      const trailing = row.slice(maxIdx + 1)
      if (trailing.some(looksLikeSalesTailMetaCell)) return row
      // Guard 3: if row already contains explicit warehouse/unit tokens near the tail,
      // the overflow is usually unmapped tail metadata, not description split cells.
      const tailWindow = row.slice(Math.max(0, row.length - 6))
      if (tailWindow.some(looksLikeSalesTailMetaCell)) return row
    }
    if (descIdx < 0) return row
    if (colMap.get(descIdx + 1) === 'description') return row
    const normalized = [...row]
    for (let i = 0; i < overflow; i++) {
      const extra = (normalized[descIdx + 1] ?? '').trim()
      if (extra) normalized[descIdx] = normalized[descIdx] ? `${normalized[descIdx]} ${extra}` : extra
      normalized.splice(descIdx + 1, 1)
    }
    return normalized
  }

  // UNDERFLOW: row is shorter than the header colMap expects.
  // When the header spans description across multiple colMap entries (colspan),
  // data rows may provide fewer description cells than the header spans.
  // Insert blank cells after descIdx to re-align subsequent numeric columns.
  if (overflow < 0 && descIdx >= 0 && colMap.get(descIdx + 1) === 'description') {
    const missing = -overflow
    let descSpan = 1
    for (let i = descIdx + 1; colMap.get(i) === 'description'; i++) descSpan++
    if (missing > 0 && missing < descSpan) {
      const normalized = [...row]
      for (let i = 0; i < missing; i++) {
        normalized.splice(descIdx + 1, 0, '')
      }
      return normalized
    }
  }

  return row
}

/** Extract CTN / CBM / KGS / amount from a yellow subtotal bar row for section-level reconciliation. */
function extractSubtotalRowValues(row: string[], raw: Record<string, string>): {
  total_cartons: number | null
  total_cbm: number | null
  total_weight_kg: number | null
  total_amount_rmb: number | null
} {
  const joined = row.filter(Boolean).join(' ').replace(/\s+/g, ' ').replace(/,/g, '')
  const cartons =
    parseNum(joined.match(/(\d+(?:\.\d+)?)\s*CTNS?\b/i)?.[1]) ??
    parseNum(raw['total_cartons'])
  const cbm =
    parseNum(joined.match(/(\d+(?:\.\d+)?)\s*CBM\b/i)?.[1]) ??
    parseNum(raw['total_cbm'])
  const weight =
    parseNum(joined.match(/(\d+(?:\.\d+)?)\s*KGS?\b/i)?.[1]) ??
    parseNum(raw['total_weight_kg'])
  const amount =
    parseNum(joined.match(/[¥￥]\s*([\d.]+)/)?.[1]) ??
    parseNum(raw['total_amount_rmb'])
  return { total_cartons: cartons, total_cbm: cbm, total_weight_kg: weight, total_amount_rmb: amount }
}

/**
 * Recover rows where T.QTY ended up in the H dimension column due to a single-column
 * undershift (blank packing + blank T.CTN row where the quantity maps to dim_h).
 * Detection: total_qty is null, dim_h is a positive integer, and dim_h ≈ total_amount / unit_price.
 */
function fixSparseQtyInDimRow(p: ExtractedProduct): ExtractedProduct {
  if ((p.total_qty ?? 0) > 0) return p
  const dimH = p.dim_h_cm ?? 0
  const price = p.unit_price_rmb ?? 0
  const amount = p.total_amount_rmb ?? 0
  if (dimH <= 0 || price <= 0 || amount <= 0) return p
  if (dimH !== Math.round(dimH) || dimH > 5000) return p
  const impliedQty = Math.round(amount / price)
  if (impliedQty <= 0) return p
  if (Math.abs(dimH - impliedQty) > 1) return p
  return {
    ...p,
    total_qty: impliedQty,
    dim_h_cm: null,
    remarks: p.remarks ? `${p.remarks};repair:sparse_qty_in_dim` : 'repair:sparse_qty_in_dim',
  }
}

/**
 * Sales-order outlier recovery:
 * Some rows collapse CTN/QTY/AMOUNT/dimensions/weights into the description string while keeping item_code.
 * Recover only when core numeric fields are all missing to avoid altering healthy rows.
 */
function fixCollapsedSalesMetricsFromDescription(p: ExtractedProduct): ExtractedProduct {
  if (!p.description) return p
  const desc = p.description.replace(/\s+/g, ' ').trim()
  if (!desc) return p

  const warehouseMatch = desc.match(/((?:浙江|东阳|浦江)\s*仓(?:\s*(?:PCS|SET|DCS|PCS\/SE|PS))?|\d+\s*仓|刀叉勺)/i)
  const warehouseIdx = warehouseMatch?.index ?? desc.length
  const beforeWarehouse = desc.slice(0, warehouseIdx).trim()
  const numMatches = [...beforeWarehouse.matchAll(/\d+(?:\.\d+)?/g)]

  const fieldsToCheck = [
    p.total_cartons,
    p.qty_per_carton,
    p.total_qty,
    p.unit_price_rmb,
    p.total_amount_rmb,
    p.dim_l_cm,
    p.dim_w_cm,
    p.dim_h_cm,
    p.total_cbm,
    p.total_weight_kg,
    p.warehouse ? 1 : null,
  ]
  const missingCount = fieldsToCheck.filter(v => v === null || v === undefined).length
  const collapsedTailSignature = !!warehouseMatch && numMatches.length >= 10
  const severeMisalign =
    missingCount >= 4 ||
    collapsedTailSignature
  if (!severeMisalign) return p
  if (numMatches.length < 10) return p

  let nums = numMatches.map(m => Number(m[0]))
  nums = normalizeSwappedTqtyAmtUnit(nums)
  let ctn: number | null = null
  let qtyPer: number | null = null
  let tQty: number | null = null
  let unitPrice: number | null = null
  let amount: number | null = null
  let l: number | null = null
  let w: number | null = null
  let h: number | null = null
  let unitCbm: number | null = null
  let unitW: number | null = null
  let tCbm: number | null = null
  let tKgs: number | null = null
  let firstTailMatchIdx = numMatches.length

  if (nums.length >= 12) {
    // Pick best 12-number window to avoid noisy prefixes (e.g. "12.7cm 304# ...").
    let best:
      | {
          start: number
          score: number
          values: [number, number, number, number, number, number, number, number, number, number, number, number]
        }
      | null = null

    for (let start = 0; start <= nums.length - 12; start++) {
      const window = nums.slice(start, start + 12)
      const [c, q, tq, up, am, ll, ww, hh, ucbm, uw, tcbm, tk] = window
      if (!(tq > 0 && up > 0 && am > 0)) continue
      if (!(tq <= SALES_ORDER_MAX_LINE_QTY && up <= SALES_ORDER_MAX_UNIT_PRICE && am <= SALES_ORDER_MAX_LINE_AMOUNT))
        continue
      if (!(q > 0 && q <= 200)) continue
      if (!(c > 0 && c <= 400)) continue
      if (!(ll > 0 && ww > 0 && hh > 0 && ll < 300 && ww < 300 && hh < 300)) continue
      if (!(ucbm > 0 && ucbm < 5 && uw > 0 && uw < 500 && tcbm > 0 && tcbm < 30 && tk > 0 && tk < 5000)) continue

      const amountDelta = Math.abs(tq * up - am)
      if (amountDelta > Math.max(2, am * 0.06)) continue

      const inferredCtn = tq / q
      const ctnDelta = Math.abs(c - inferredCtn)
      const nearInteger = Math.abs(inferredCtn - Math.round(inferredCtn))
      const score = 1000 - amountDelta * 10 - ctnDelta * 20 - nearInteger * 5 - start * 0.1

      if (!best || score > best.score) {
        best = { start, score, values: [c, q, tq, up, am, ll, ww, hh, ucbm, uw, tcbm, tk] }
      }
    }

    if (best) {
      ;[ctn, qtyPer, tQty, unitPrice, amount, l, w, h, unitCbm, unitW, tCbm, tKgs] = best.values
      firstTailMatchIdx = best.start
    } else {
      const tail = nums.slice(-12)
      const [, , tq0, up0, am0] = tail
      if (
        tq0 > 0 &&
        tq0 <= SALES_ORDER_MAX_LINE_QTY &&
        up0 > 0 &&
        up0 <= SALES_ORDER_MAX_UNIT_PRICE &&
        am0 > 0 &&
        am0 <= SALES_ORDER_MAX_LINE_AMOUNT
      ) {
        ;[ctn, qtyPer, tQty, unitPrice, amount, l, w, h, unitCbm, unitW, tCbm, tKgs] = tail
        firstTailMatchIdx = numMatches.length - 12
      }
    }
  } else if (nums.length === 11) {
    // Missing CTN is common in this outlier table; keep it null and recover the rest.
    const tail = nums.slice(-11)
    const [q, tq, up, am] = tail
    if (
      tq > 0 &&
      tq <= SALES_ORDER_MAX_LINE_QTY &&
      up > 0 &&
      up <= SALES_ORDER_MAX_UNIT_PRICE &&
      am > 0 &&
      am <= SALES_ORDER_MAX_LINE_AMOUNT &&
      q > 0 &&
      q <= 200
    ) {
      ;[qtyPer, tQty, unitPrice, amount, l, w, h, unitCbm, unitW, tCbm, tKgs] = tail
      firstTailMatchIdx = numMatches.length - 11
    }
  } else {
    // Last-ditch narrow recovery for badly collapsed rows: keep only critical metrics.
    const tail = nums.slice(-10)
    const [tq, up, am] = tail
    if (
      tq > 0 &&
      tq <= SALES_ORDER_MAX_LINE_QTY &&
      up > 0 &&
      up <= SALES_ORDER_MAX_UNIT_PRICE &&
      am > 0 &&
      am <= SALES_ORDER_MAX_LINE_AMOUNT
    ) {
      ;[tQty, unitPrice, amount, l, w, h, unitCbm, unitW, tCbm, tKgs] = tail
      firstTailMatchIdx = numMatches.length - 10
    }
  }

  if (tQty === null || amount === null || unitPrice === null) return p
  if (!isFinite(tQty) || !isFinite(amount) || !isFinite(unitPrice) || tQty <= 0 || amount <= 0 || unitPrice <= 0) return p
  if (ctn !== null && tQty < ctn) return p

  const firstTailIdx = numMatches[firstTailMatchIdx]?.index ?? beforeWarehouse.length
  const recoveredDesc = beforeWarehouse.slice(0, firstTailIdx).trim() || p.description

  return {
    ...p,
    description: recoveredDesc,
    qty_per_carton: (p.qty_per_carton ?? null) === null && (qtyPer !== null && qtyPer > 0) ? qtyPer : p.qty_per_carton,
    packaging: (p.packaging ?? null) === null && (qtyPer !== null && qtyPer > 0) ? `${qtyPer}pcs` : p.packaging,
    total_cartons: ((p.total_cartons ?? null) === null || ((p.total_qty ?? 0) > 0 && (p.total_cartons ?? 0) > (p.total_qty ?? 0)))
      ? ((ctn !== null && ctn > 0) ? ctn : p.total_cartons)
      : p.total_cartons,
    total_qty: (p.total_qty ?? null) === null ? tQty : p.total_qty,
    unit_price_rmb: (p.unit_price_rmb ?? null) === null ? unitPrice : p.unit_price_rmb,
    total_amount_rmb: (p.total_amount_rmb ?? null) === null ? amount : p.total_amount_rmb,
    dim_l_cm: (p.dim_l_cm ?? null) === null && (l !== null && l > 0) ? l : p.dim_l_cm,
    dim_w_cm: (p.dim_w_cm ?? null) === null && (w !== null && w > 0) ? w : p.dim_w_cm,
    dim_h_cm: (p.dim_h_cm ?? null) === null && (h !== null && h > 0) ? h : p.dim_h_cm,
    unit_cbm: (unitCbm !== null && unitCbm > 0) ? unitCbm : p.unit_cbm,
    unit_weight_kg: (p.unit_weight_kg ?? null) === null && (unitW !== null && unitW > 0) ? unitW : p.unit_weight_kg,
    total_cbm: (p.total_cbm ?? null) === null && (tCbm !== null && tCbm > 0) ? tCbm : p.total_cbm,
    total_weight_kg: (p.total_weight_kg ?? null) === null && (tKgs !== null && tKgs > 0) ? tKgs : p.total_weight_kg,
    warehouse: p.warehouse ?? (warehouseMatch ? warehouseMatch[1].replace(/\s+/g, ' ').trim() : null),
    remarks: p.remarks ? `${p.remarks};repair:collapsed_sales_metrics` : 'repair:collapsed_sales_metrics',
  }
}

/** Pull warehouse token from anywhere in the cell (continuation rows omit it from the prefix). */
function extractSalesWarehouseToken(desc: string): string | null {
  const m = desc.match(
    /((?:浙江|东阳|浦江)\s*仓(?:\s*(?:PCS|SET|DCS|PCS\/SE|PS))?|\d+\s*仓|刀叉勺)/i
  )
  return m ? m[1].replace(/\s+/g, ' ').trim() : null
}

/**
 * Reducto flattened rows sometimes emit **tqty, AMOUNT, unitPrice** when our templates expect
 * **tqty, unitPrice, AMOUNT** (because AMOUNT is wider / middle column in the PDF).
 * When `tqty * unitPrice === amount`, rewrite the triple in place so sliding-window recovery works.
 */
function normalizeSwappedTqtyAmtUnit(nums: number[]): number[] {
  const out = [...nums]
  for (let i = 0; i <= out.length - 3; i++) {
    const tq = out[i]
    const mid = out[i + 1]
    const up = out[i + 2]
    if (
      tq > 0 &&
      tq <= 100_000 &&
      up > 0 &&
      up < 500 &&
      mid > 0 &&
      mid < 10_000_000 &&
      Math.abs(tq * up - mid) <= Math.max(2, mid * 0.06)
    ) {
      out[i + 1] = up
      out[i + 2] = mid
      break
    }
  }
  return out
}

/**
 * Second-pass sales outlier: continuation / narrow tables often put the entire metric tail inside
 * `description` while `fixCollapsedSalesMetricsFromDescription` only scans *before* the first warehouse
 * token (or bails when that prefix has fewer than 10 numbers). Parse **full** description numbers with
 * the same 12/11/10 tail semantics and only fill still-null numeric fields.
 */
function fixContinuationSalesMetricsFromDescription(p: ExtractedProduct): ExtractedProduct {
  if (!p.description?.trim()) return p
  if (isFullExtractBanner(p) || isSubtotalBanner(p) || isFooterBanner(p)) return p

  /** Primary failure mode for this outlier: money/qty still stuck in the description blob. */
  const missingQtyOrAmount = p.total_amount_rmb == null || p.total_qty == null
  if (!missingQtyOrAmount) return p

  const desc = p.description.replace(/\s+/g, ' ').trim()
  const numMatches = [...desc.matchAll(/\d+(?:\.\d+)?/g)]
  let nums = numMatches.map(m => Number(m[0]))
  nums = normalizeSwappedTqtyAmtUnit(nums)
  if (nums.length < 10) return p

  const maxCtn = 600

  const scoreWindow12 = (window: number[], startIdx: number): number | null => {
    const [c, q, tq, up, am, ll, ww, hh, ucbm, uw, tcbm, tk] = window
    if (!(tq > 0 && up > 0 && am > 0)) return null
    if (!(tq <= SALES_ORDER_MAX_LINE_QTY && up <= SALES_ORDER_MAX_UNIT_PRICE && am <= SALES_ORDER_MAX_LINE_AMOUNT))
      return null
    if (!(q > 0 && q <= 200)) return null
    if (!(c > 0 && c <= maxCtn)) return null
    if (!(ll > 0 && ww > 0 && hh > 0 && ll < 300 && ww < 300 && hh < 300)) return null
    if (!(ucbm > 0 && ucbm < 5 && uw > 0 && uw < 500 && tcbm > 0 && tcbm < 30 && tk > 0 && tk < 5000))
      return null
    const amountDelta = Math.abs(tq * up - am)
    if (amountDelta > Math.max(2, am * 0.06)) return null
    const inferredCtn = tq / q
    const ctnDelta = Math.abs(c - inferredCtn)
    const nearInteger = Math.abs(inferredCtn - Math.round(inferredCtn))
    return 1000 - amountDelta * 10 - ctnDelta * 20 - nearInteger * 5 - startIdx * 0.1
  }

  let ctn: number | null = null
  let qtyPer: number | null = null
  let tQty: number | null = null
  let unitPrice: number | null = null
  let amount: number | null = null
  let l: number | null = null
  let w: number | null = null
  let h: number | null = null
  let unitCbm: number | null = null
  let unitW: number | null = null
  let tCbm: number | null = null
  let tKgs: number | null = null
  let firstTailMatchIdx = numMatches.length

  if (nums.length >= 12) {
    let best: { start: number; score: number; values: number[] } | null = null
    for (let start = 0; start <= nums.length - 12; start++) {
      const window = nums.slice(start, start + 12)
      const sc = scoreWindow12(window, start)
      if (sc === null) continue
      if (!best || sc > best.score) best = { start, score: sc, values: window }
    }
    if (!best) {
      const start = nums.length - 12
      const tail = nums.slice(-12)
      const sc = scoreWindow12(tail, start)
      if (sc !== null) best = { start, score: sc, values: tail }
    }
    if (best) {
      ;[ctn, qtyPer, tQty, unitPrice, amount, l, w, h, unitCbm, unitW, tCbm, tKgs] = best.values as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ]
      firstTailMatchIdx = best.start
    }
  }

  if (tQty === null && nums.length >= 11) {
    const tail = nums.slice(-11)
    const [q, tq, up, am, ll, ww, hh, ucbm, uw, tcbm, tk] = tail
    if (
      tq > 0 &&
      tq <= SALES_ORDER_MAX_LINE_QTY &&
      up > 0 &&
      up <= SALES_ORDER_MAX_UNIT_PRICE &&
      am > 0 &&
      am <= SALES_ORDER_MAX_LINE_AMOUNT &&
      q > 0 &&
      q <= 200 &&
      ll > 0 &&
      ww > 0 &&
      hh > 0 &&
      ll < 300 &&
      ww < 300 &&
      hh < 300 &&
      ucbm > 0 &&
      ucbm < 5 &&
      uw > 0 &&
      uw < 500 &&
      tcbm > 0 &&
      tcbm < 30 &&
      tk > 0 &&
      tk < 5000 &&
      Math.abs(tq * up - am) <= Math.max(2, am * 0.06)
    ) {
      qtyPer = q
      tQty = tq
      unitPrice = up
      amount = am
      l = ll
      w = ww
      h = hh
      unitCbm = ucbm
      unitW = uw
      tCbm = tcbm
      tKgs = tk
      firstTailMatchIdx = numMatches.length - 11
    }
  }

  if (tQty === null && nums.length >= 10) {
    const tail = nums.slice(-10)
    const [tq, up, am, ll, ww, hh, ucbm, uw, tcbm, tk] = tail
    if (
      tq > 0 &&
      tq <= SALES_ORDER_MAX_LINE_QTY &&
      up > 0 &&
      up <= SALES_ORDER_MAX_UNIT_PRICE &&
      am > 0 &&
      am <= SALES_ORDER_MAX_LINE_AMOUNT &&
      ll > 0 &&
      ww > 0 &&
      hh > 0 &&
      ll < 300 &&
      ww < 300 &&
      hh < 300 &&
      ucbm > 0 &&
      ucbm < 5 &&
      uw > 0 &&
      uw < 500 &&
      tcbm > 0 &&
      tcbm < 30 &&
      tk > 0 &&
      tk < 5000 &&
      Math.abs(tq * up - am) <= Math.max(2, am * 0.06)
    ) {
      tQty = tq
      unitPrice = up
      amount = am
      l = ll
      w = ww
      h = hh
      unitCbm = ucbm
      unitW = uw
      tCbm = tcbm
      tKgs = tk
      firstTailMatchIdx = numMatches.length - 10
    }
  }

  if (tQty === null || amount === null || unitPrice === null) return p
  if (!isFinite(tQty) || !isFinite(amount) || !isFinite(unitPrice) || tQty <= 0 || amount <= 0 || unitPrice <= 0)
    return p
  if (ctn !== null && tQty < ctn) return p

  const firstTailIdx = numMatches[firstTailMatchIdx]?.index ?? 0
  const recoveredDesc = desc.slice(0, firstTailIdx).trim() || p.description
  const warehouseToken = extractSalesWarehouseToken(desc)

  return {
    ...p,
    description: recoveredDesc,
    qty_per_carton:
      (p.qty_per_carton ?? null) === null && qtyPer !== null && qtyPer > 0 ? qtyPer : p.qty_per_carton,
    packaging:
      (p.packaging ?? null) === null && qtyPer !== null && qtyPer > 0 ? `${qtyPer}pcs` : p.packaging,
    total_cartons:
      ((p.total_cartons ?? null) === null ||
        ((p.total_qty ?? 0) > 0 && (p.total_cartons ?? 0) > (p.total_qty ?? 0))) &&
      ctn !== null &&
      ctn > 0
        ? ctn
        : p.total_cartons,
    total_qty: (p.total_qty ?? null) === null ? tQty : p.total_qty,
    unit_price_rmb: (p.unit_price_rmb ?? null) === null ? unitPrice : p.unit_price_rmb,
    total_amount_rmb: (p.total_amount_rmb ?? null) === null ? amount : p.total_amount_rmb,
    dim_l_cm: (p.dim_l_cm ?? null) === null && l !== null && l > 0 ? l : p.dim_l_cm,
    dim_w_cm: (p.dim_w_cm ?? null) === null && w !== null && w > 0 ? w : p.dim_w_cm,
    dim_h_cm: (p.dim_h_cm ?? null) === null && h !== null && h > 0 ? h : p.dim_h_cm,
    unit_cbm: (p.unit_cbm ?? null) === null && unitCbm !== null && unitCbm > 0 ? unitCbm : p.unit_cbm,
    unit_weight_kg:
      (p.unit_weight_kg ?? null) === null && unitW !== null && unitW > 0 ? unitW : p.unit_weight_kg,
    total_cbm: (p.total_cbm ?? null) === null && tCbm !== null && tCbm > 0 ? tCbm : p.total_cbm,
    total_weight_kg:
      (p.total_weight_kg ?? null) === null && tKgs !== null && tKgs > 0 ? tKgs : p.total_weight_kg,
    warehouse: p.warehouse ?? warehouseToken,
    remarks: p.remarks
      ? `${p.remarks};repair:continuation_sales_metrics`
      : 'repair:continuation_sales_metrics',
  }
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

function buildSalesOrderSourceCells(
  alignedRow: string[],
  colMap: Map<number, ProductField | 'skip'>
): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const [idx, field] of colMap) {
    if (field === 'skip') continue
    const cell = (alignedRow[idx] ?? '').trim()
    if (!cell) continue
    out[field] = cell
  }
  return Object.keys(out).length > 0 ? out : null
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

function isAnonymousPartsRow(raw: Record<string, string>): boolean {
  const marks = (raw['marks'] ?? '').trim()
  const item = (raw['item_code'] ?? '').trim()
  const shop = (raw['shop'] ?? '').trim()
  const desc = (raw['description'] ?? '').trim()
  if (marks || item || shop) return false
  return /FOOD\s+WARMER\s+PARTS/i.test(desc)
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

  // Only strip obvious barcode suffixes — do NOT strip long numeric metric tails here;
  // those are recovered by collapsed/continuation repairs (stripping first made rows unsalvageable).
  desc = desc.replace(/\s+\d{8,}\s*[\u4e00-\u9fffA-Za-z]{0,12}\s*$/, '').trim()
  if (!desc) return null

  let product: ExtractedProduct = {
    line_no: lineNo,
    marks: marks || inheritedMarks,
    shop: null,
    item_code: item,
    source_item_no: item,
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
    delivery_no: null,
    customer_item_ref: null,
    unit: null,
    product_name_local: null,
    material: null,
    source_cells: null,
  }
  product = fixCollapsedSalesMetricsFromDescription(product)
  product = fixContinuationSalesMetricsFromDescription(product)
  return product
}

function parseGridToProducts(
  grid: string[][],
  defaultSection: Section,
  docType: DocType,
  startLineNo: number,
  inheritedMarks: string | null,
  parseMode: ParseMode
): GridParseResult {
  const emptySubtotals: SectionSubtotal[] = []
  if (grid.length < 2) return { products: [], lastMarks: inheritedMarks, exitSection: defaultSection, sectionSubtotals: emptySubtotals }

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
      return { products, lastMarks: inheritedMarks, exitSection: defaultSection, sectionSubtotals: emptySubtotals }
    }
    return { products: [], lastMarks: inheritedMarks, exitSection: defaultSection, sectionSubtotals: emptySubtotals }
  }

  const nextRow = grid[headerRowIdx + 1]
  // Merge second row when it looks like sub-headers (U.PRICE, T.AMOUNT, …)
  const includeNextAsHeader = nextRow !== undefined && isLikelySubHeaderRow(nextRow, docType)

  const colMap = buildColMapFromHeaderRows(grid, headerRowIdx, includeNextAsHeader, docType)

  let dataStartRow = headerRowIdx + 1
  if (includeNextAsHeader) dataStartRow = headerRowIdx + 2

  let currentSection: Section = defaultSection
  let currentSectionLabel: string | null = null
  let inBeforeGoodsBlock = false
  const products: ExtractedProduct[] = []
  const sectionSubtotals: SectionSubtotal[] = []
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
      currentSectionLabel = rowText.replace(/\s+/g, ' ').trim()
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
      currentSectionLabel = rowText.replace(/\s+/g, ' ').trim()
      inBeforeGoodsBlock = true
      prevMarks = null
      if (parseMode === 'full') {
        products.push(syntheticFullExtractRow(lineNo++, rowText, currentSection, 'full_extract:before_goods'))
      }
      continue
    }
    if (isGoodsLeftHeader(rowText)) {
      currentSection = 'left_in_warehouse'
      currentSectionLabel = rowText.replace(/\s+/g, ' ').trim()
      inBeforeGoodsBlock = false
      prevMarks = null
      if (parseMode === 'full') {
        products.push(syntheticFullExtractRow(lineNo++, rowText, currentSection, 'full_extract:goods_left'))
      }
      continue
    }
    if (isRepackagedSectionHeader(rowText)) {
      currentSection = 'repacked'
      currentSectionLabel = rowText.replace(/\s+/g, ' ').trim()
      inBeforeGoodsBlock = false
      prevMarks = null
      if (parseMode === 'full') {
        products.push(syntheticFullExtractRow(lineNo++, rowText, currentSection, 'full_extract:repacked'))
      }
      continue
    }
    if (isStuffedContainerHeader(rowText)) {
      currentSection = 'shipped'
      currentSectionLabel = rowText.replace(/\s+/g, ' ').trim()
      inBeforeGoodsBlock = false
      prevMarks = null
      if (parseMode === 'full') {
        products.push(syntheticFullExtractRow(lineNo++, rowText, currentSection, 'full_extract:stuffed_container'))
      }
      continue
    }
    // Unknown section banners should not become product rows or silently force bad section flips.
    if (isUnknownSectionBanner(rowText)) {
      const bannerLabel = rowText.replace(/\s+/g, ' ').trim()
      currentSectionLabel = bannerLabel
      currentSection = normalizeDynamicSectionKey(bannerLabel)
      prevMarks = null
      if (parseMode === 'full') {
        products.push(syntheticFullExtractRow(lineNo++, rowText, currentSection, 'full_extract:unknown_section_banner'))
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

    // Build raw field map — normalize row length first.
    // Handles both overflow (extra desc cells) and underflow (missing desc cells when header
    // uses colspan, as in 新多 MAG-510-3 where colspan=3 header gets only 2 desc cells).
    const alignedRow = normalizeRowToColMap(row, colMap, docType)
    const raw = buildRawFromRow(alignedRow, colMap)
    if (docType === 'sales_order') {
      disambiguateYiwuSalesOrderRawFields(raw, alignedRow, colMap)
    }

    // Yellow / rolled section subtotal bars (CTNS+CBM+KGS+¥).
    // Capture their values for section-level reconciliation before skipping/emitting.
    if (
      isLikelyYellowSubtotalRow(row) ||
      isSubtotalAggregateRaw(raw) ||
      isRolledTotalsBlobInFields(raw, rowText)
    ) {
      if (isGoodsLeftHeader(rowText)) {
        currentSection = 'left_in_warehouse'
      }
      // Extract subtotal values for per-section reconciliation.
      // Skip BEFORE GOODS yellow bars — those items are deduped against GOODS LEFT entries
      // and would double-count the left_in_warehouse section total.
      const subVals = extractSubtotalRowValues(row, raw)
      if (!inBeforeGoodsBlock && (subVals.total_cartons !== null || subVals.total_amount_rmb !== null)) {
        sectionSubtotals.push({ section: currentSection, ...subVals })
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
    const anonymousParts = isAnonymousPartsRow(raw)
    if (!(raw['marks'] ?? '').trim() && inferredMarks) raw['marks'] = inferredMarks
    if (!(raw['marks'] ?? '').trim() && prevMarks && !anonymousParts) raw['marks'] = prevMarks
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
    if (docType === 'sales_order' && colMap.size > 0) {
      const snap = buildSalesOrderSourceCells(alignedRow, colMap)
      if (snap) product = { ...product, source_cells: snap }
    }
    if (docType === 'sales_order') {
      // When the HTML col-map path glues metrics into `description` (OCR/merged <td>), the same
      // `row[]` often still has 20+ cells — re-parse with the right-anchored 义乌 layout.
      const positional = parseSalesOrderRowPositional(row, currentSection, lineNo, prevMarks)
      if (positional) {
        const mappedCoherent =
          (product.total_qty ?? 0) > 0 &&
          (product.unit_price_rmb ?? 0) > 0 &&
          (product.total_amount_rmb ?? 0) > 0
        if (!mappedCoherent) {
          product = {
            ...positional,
            marks: product.marks ?? positional.marks ?? prevMarks,
            shop: positional.shop ?? product.shop,
            source_cells: product.source_cells ?? positional.source_cells,
            line_no: lineNo,
            section: currentSection,
            remarks: product.remarks
              ? `${product.remarks};repair:positional_row_override`
              : 'repair:positional_row_override',
          }
        }
      }
    }
    if (docType === 'sales_order') {
      product = fixCollapsedSalesMetricsFromDescription(product)
      product = fixContinuationSalesMetricsFromDescription(product)
    }
    if (docType === 'container_manifest' || docType === 'unknown') {
      product = fixShiftedManifestRowColumns(product)
      product = fixShiftedManifestPartsRowColumns(product)
      product = fixShiftedManifestCartonOnlyRowColumns(product)
      product = fixCtnPackedShiftedRowColumns(product)
      product = normalizeCartonsFromPackingWhenQtyAlreadyCorrect(product)
      // Recover rows where T.QTY landed in the H dimension column due to blank PACKING/CTN cells
      // (格雷特/food-warmer pattern: qty implied by amount ÷ price matches dim_h integer value).
      product = fixSparseQtyInDimRow(product)
    }
    if (inBeforeGoodsBlock) {
      product.section = 'left_in_warehouse'
      product.remarks = product.remarks
        ? `${product.remarks};${BEFORE_GOODS_REMARK}`
        : BEFORE_GOODS_REMARK
      product = fixBeforeGoodsCarryoverAmount(product, products)
    }
    product = withSectionLabelRemark(product, currentSectionLabel)
    if (product.marks) prevMarks = product.marks

    products.push(product)
    lineNo++
  }

  return { products, lastMarks: prevMarks, exitSection: currentSection, sectionSubtotals }
}

function fixBeforeGoodsCarryoverAmount(
  p: ExtractedProduct,
  parsedSoFar: ExtractedProduct[]
): ExtractedProduct {
  if ((p.total_amount_rmb ?? 0) <= 0) return p
  if ((p.remarks ?? '').toLowerCase().includes(BEFORE_GOODS_REMARK)) {
    return {
      ...p,
      total_amount_rmb: null,
      remarks: p.remarks
        ? `${p.remarks};repair:before_goods_amount_carryover_ignored`
        : 'repair:before_goods_amount_carryover_ignored',
    }
  }
  const marks = (p.marks ?? '').trim()
  const item = (p.item_code ?? '').trim()
  const duplicateInShipped = parsedSoFar.some(prev => {
    if ((prev.section ?? 'shipped') !== 'shipped') return false
    if ((prev.marks ?? '').trim() !== marks) return false
    if ((prev.item_code ?? '').trim() !== item) return false
    return Math.abs((prev.total_amount_rmb ?? 0) - (p.total_amount_rmb ?? 0)) < 0.01
  })
  if (!duplicateInShipped) return p
  return {
    ...p,
    total_amount_rmb: null,
    remarks: p.remarks
      ? `${p.remarks};repair:before_goods_amount_carryover_ignored`
      : 'repair:before_goods_amount_carryover_ignored',
  }
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
  const compactShiftSignature =
    unitPrice >= 500 &&
    totalAmount >= 0 &&
    totalAmount <= 20 &&
    (p.total_cbm ?? 0) >= 5 &&
    (p.total_cbm ?? 0) <= 80 &&
    (p.total_weight_kg ?? 0) >= 20 &&
    (p.total_weight_kg ?? 0) <= 600
  const pairedQtyCartonShiftSignature =
    cartons > 0 &&
    cartons <= 80 &&
    qty >= 20 &&
    qty <= 220 &&
    Math.abs(cartons - qty) <= 8 &&
    unitPrice >= 500 &&
    totalAmount >= 0 &&
    totalAmount <= 20 &&
    (p.unit_cbm ?? 0) > 0 &&
    (p.unit_cbm ?? 0) <= 2 &&
    (p.total_cbm ?? 0) >= 5 &&
    (p.total_cbm ?? 0) <= 80

  if (!cartonsLooksLikeQty && !pairedQtyCartonShiftSignature) return false
  if (!qtyLooksLikeDim && !compactShiftSignature) return false
  if (!unitPriceLooksLikeAmount) return false
  if (!dimLLooksLikeUnitCbm && !compactShiftSignature) return false
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

function fixShiftedManifestPartsRowColumns(p: ExtractedProduct): ExtractedProduct {
  const desc = (p.description ?? '').trim()
  const pack = (p.packaging ?? '').trim()
  if (!/^\d+(?:\.\d+)?\s*CTNS?$/i.test(pack)) return p
  const trailing = desc.match(/(\d+(?:\.\d+)?\s*pcs\/ctn)\s*$/i)
  if (!trailing) return p

  const unitFromDesc = parseNum(trailing[1]) ?? null
  const cartonsFromPack = parseNum(pack)
  const looksLikeParts =
    /FOOD\s+WARMER\s+PARTS/i.test(desc) &&
    (p.total_cbm ?? 0) >= 5 &&
    (p.unit_cbm ?? 0) > 0 &&
    (p.total_weight_kg ?? 0) === 0

  if (!looksLikeParts) return p

  const out: ExtractedProduct = { ...p }
  out.packaging = trailing[1]
  out.description = desc.slice(0, trailing.index).trim() || out.description
  out.total_cartons = cartonsFromPack
  if ((p.total_qty ?? 0) <= 0 && cartonsFromPack && unitFromDesc) {
    out.total_qty = cartonsFromPack * unitFromDesc
  } else if ((p.total_qty ?? 0) > 0 && (p.total_qty ?? 0) < 80 && cartonsFromPack && unitFromDesc) {
    // Shifted variant where total_qty captured H/W value (e.g. 66) instead of logical quantity.
    out.total_qty = cartonsFromPack * unitFromDesc
  }

  // Real column locations in this outlier variant.
  out.total_cbm = p.unit_cbm
  out.unit_cbm = p.dim_l_cm ?? p.unit_cbm
  out.unit_weight_kg = p.total_cbm
  out.total_weight_kg = p.unit_weight_kg

  // Parts lines in source PDF don't carry price/amount; avoid injecting bogus values.
  out.unit_price_rmb = null
  out.total_amount_rmb = null
  out.remarks = out.remarks
    ? `${out.remarks};repair:shifted_manifest_parts_row`
    : 'repair:shifted_manifest_parts_row'
  return out
}

function fixShiftedManifestCartonOnlyRowColumns(p: ExtractedProduct): ExtractedProduct {
  const pack = (p.packaging ?? '').trim()
  if (!/^\d+(?:\.\d+)?\s*CTNS?$/i.test(pack)) return p
  if ((p.total_cartons ?? 0) < 80) return p
  if ((p.unit_price_rmb ?? 0) < 1000) return p
  if (p.total_amount_rmb !== null && p.total_amount_rmb > 0) return p
  if ((p.total_qty ?? 0) < 20 || (p.total_qty ?? 0) > 220) return p

  const out: ExtractedProduct = { ...p }
  const cartonsFromPack = parseNum(pack)
  if (!cartonsFromPack || cartonsFromPack <= 0) return p

  const inferredQtyPerCarton = Math.round((p.total_cartons ?? 0) / cartonsFromPack)
  if (isFinite(inferredQtyPerCarton) && inferredQtyPerCarton > 0) {
    out.qty_per_carton = inferredQtyPerCarton
    out.packaging = `${inferredQtyPerCarton}pcs/ctn`
  }

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
  out.total_cartons = cartonsFromPack
  out.remarks = out.remarks
    ? `${out.remarks};repair:shifted_manifest_carton_only_row`
    : 'repair:shifted_manifest_carton_only_row'
  return out
}

function fixCtnPackedShiftedRowColumns(p: ExtractedProduct): ExtractedProduct {
  const pack = (p.packaging ?? '').trim()
  if (!/^\d+(?:\.\d+)?\s*CTNS?$/i.test(pack)) return p
  const packCtn = parseNum(pack)
  if (!packCtn || packCtn <= 0) return p
  if ((p.total_qty ?? 0) < 20 || (p.total_qty ?? 0) > 220) return p
  if ((p.dim_l_cm ?? 0) <= 0 || (p.dim_l_cm ?? 0) >= 1) return p
  if ((p.unit_cbm ?? 0) <= 0 || (p.unit_cbm ?? 0) > 2) return p
  if ((p.total_cbm ?? 0) < 5) return p
  if ((p.unit_weight_kg ?? 0) < 5) return p
  if (p.total_amount_rmb !== null && p.total_amount_rmb > 0) return p

  const out: ExtractedProduct = { ...p }
  out.total_cartons = packCtn
  out.total_qty = p.total_cartons
  out.dim_h_cm = p.total_qty
  out.dim_w_cm = p.dim_h_cm
  out.dim_l_cm = p.dim_w_cm
  out.unit_cbm = p.dim_l_cm
  out.total_cbm = p.unit_cbm
  out.unit_weight_kg = p.total_cbm
  out.total_weight_kg = p.unit_weight_kg
  if ((out.unit_price_rmb ?? 0) <= 0 && (p.total_weight_kg ?? 0) > 0) {
    out.unit_price_rmb = p.total_weight_kg
  }
  out.remarks = out.remarks
    ? `${out.remarks};repair:ctn_packed_shifted_row`
    : 'repair:ctn_packed_shifted_row'
  return out
}

function normalizeCartonsFromPackingWhenQtyAlreadyCorrect(p: ExtractedProduct): ExtractedProduct {
  const pack = (p.packaging ?? '').trim()
  if (!/^\d+(?:\.\d+)?\s*CTNS?$/i.test(pack)) return p
  const packCtn = parseNum(pack)
  if (!packCtn || packCtn <= 0) return p
  const desc = (p.description ?? '').trim()
  const pcs = desc.match(/(\d+(?:\.\d+)?)\s*pcs\/ctn/i)
  if (!pcs) return p
  const qpc = parseFloat(pcs[1])
  if (!isFinite(qpc) || qpc <= 0) return p
  if ((p.total_cartons ?? 0) !== packCtn * qpc) return p
  if ((p.total_qty ?? 0) !== (p.total_cartons ?? 0)) return p
  return {
    ...p,
    total_cartons: packCtn,
    remarks: p.remarks
      ? `${p.remarks};repair:cartons_from_pack_when_qty_correct`
      : 'repair:cartons_from_pack_when_qty_correct',
  }
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

  const source_item_no = parseStr(raw['source_item_no'])
  const item_code_raw = parseStr(raw['item_code'])
  const sku = resolveSalesOrderSkuFields(source_item_no, item_code_raw)

  return {
    line_no: lineNo,
    marks,
    shop: parseStr(raw['shop']),
    item_code: sku.item_code,
    source_item_no: sku.source_item_no,
    delivery_no: parseStr(raw['delivery_no']) ?? (
      marks && looksLikeYiwuDeliveryNoRef(marks) ? marks : null
    ),
    customer_item_ref: parseStr(raw['customer_item_ref']),
    unit: parseStr(raw['unit']),
    product_name_local: parseStr(raw['product_name_local']),
    material: parseStr(raw['material']),
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
    source_cells: null,
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
    total_amount_usd: extractTotalAmountUsd(allText),
    exchange_rate: extractUnit(flat, /(?:EXCHANGE\s+RATE|RATE)\s*[:\s]+([\d.]+)/i),
    goods_balance_usd: null,
    freight_usd: extractUnit(flat.replace(/,/g, ''), /FREIGHT.*?USD\s+([\d.]+)/i),
    total_balance_usd:
      extractUnit(flat.replace(/,/g, ''), /(?:TOTAL\s+BALANCE|BALANCE\s+TOTAL).*?USD\s+([\d.]+)/i),
  }

  const linePayments = extractPayments(allText)
  const payments = linePayments.length > 0 ? linePayments : extractPaymentsFromFlatText(allText)

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
    if (!/\bPAYMENT\b/i.test(line)) continue
    const amountMatch = extractUsdNearAnchor(line, 'PAYMENT', 60)
    if (!amountMatch) continue
    const amount_usd = amountMatch
    if (!isFinite(amount_usd) || amount_usd <= 0) continue

    const payment_date = extractPaymentDate(line)

    const isBalance = /BALANCE|SECOND|REMAINING/i.test(line)
    // Only mark as freight when freight appears in close payment context.
    const isFreight = /\b(?:FREIGHT\s+PAYMENT|PAYMENT\s+FOR\s+FREIGHT|PAYMENT[^\n]{0,32}FREIGHT)\b/i.test(line)
    payments.push({
      payment_date,
      amount_usd,
      payment_type: isFreight ? 'freight' : isBalance ? 'balance' : 'deposit',
    })
  }
  return payments
}

function extractPaymentDate(line: string): string | null {
  const ymd = line.match(/\b(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})\b/)
  if (ymd) {
    const y = parseInt(ymd[1], 10)
    const m = parseInt(ymd[2], 10)
    const d = parseInt(ymd[3], 10)
    if (y >= 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    }
  }
  const dmy = line.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/)
  if (dmy) {
    const d = parseInt(dmy[1], 10)
    const m = parseInt(dmy[2], 10)
    const y = parseInt(dmy[3], 10)
    if (y >= 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    }
  }
  return null
}

function extractTotalAmountUsd(text: string): number | null {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/,/g, ' ')
    if (!/TOTAL\s+COST/i.test(line) || !/USD/i.test(line)) continue
    const near = extractUsdNearAnchor(line, 'TOTAL COST', 90)
    if (near && near >= 1000) return near
  }
  // Flat-text fallback across merged OCR lines.
  const flat = text.replace(/\s+/g, ' ')
  const nearFlat = extractUsdNearAnchor(flat, 'TOTAL COST', 140)
  if (nearFlat && nearFlat >= 1000) return nearFlat
  return null
}

function extractUsdNearAnchor(text: string, anchor: string, windowChars: number): number | null {
  const up = text.toUpperCase()
  const idx = up.indexOf(anchor.toUpperCase())
  if (idx < 0) return null
  const win = text.slice(idx, Math.min(text.length, idx + windowChars))
  const m = win.replace(/,/g, '').match(/\$\s*([\d.]+)|USD\s*[:\-]?\s*([\d.]+)/i)
  if (!m) return null
  const n = parseFloat(m[1] ?? m[2] ?? '')
  if (!isFinite(n) || n <= 0) return null
  return n
}

function extractPaymentsFromFlatText(text: string): ExtractedDocument['payments'] {
  const out: ExtractedDocument['payments'] = []
  const flat = text.replace(/\s+/g, ' ')
  const re = /(\d{1,2}[\/-]\d{1,2}[\/-]\d{4}|\d{4}[\/-]\d{1,2}[\/-]\d{1,2})\s*PAYMENT[\s\S]{0,60}?\$\s*([\d,]+(?:\.\d+)?)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(flat)) !== null) {
    const dateRaw = m[1]
    const amountRaw = m[2]
    const payment_date = extractPaymentDate(dateRaw)
    const amount_usd = parseFloat(amountRaw.replace(/,/g, ''))
    if (!isFinite(amount_usd) || amount_usd <= 0) continue
    out.push({
      payment_date,
      amount_usd,
      payment_type: 'deposit',
    })
  }
  return out
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
