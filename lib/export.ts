'use client'

import * as XLSX from 'xlsx'
import type { Product, StockMovement } from './types'
import type { ImportMeta } from './types'
import type { ExtractedProduct, ExtractedDocument } from './claude-extractor'
import { parseCsvRows } from './csv-parse'
import { formatDateTime } from './utils'
import { extractStageSectionHeader, isGoodsLeftHeader, makeStageSectionSku, makeStageTotalSku, STAGE_SECTION_MARKER_PREFIX, STAGE_TOTAL_MARKER_PREFIX } from './sections'
import { supabase } from './supabase'
import { extractPdfText } from './pdf-text-extractor'

export interface PdfExtractResult {
  products: ExtractedProduct[]
  document: ExtractedDocument
  document_id: string | null
  rows_extracted: number
  rows_pass: number
  rows_flagged: number
  totals_match: boolean
  totals_diff: Record<string, number>
  validation_flags: string[]
  metrics: { duration_ms: number; input_tokens: number; output_tokens: number; lines: number }
}

/**
 * Fast synchronous PDF import:
 *   1. Extract text client-side with pdfjs-dist  (< 1 s — serves as fallback text)
 *   2. POST file + fallback_text to /api/extract
 *        → server uses Reducto if configured (2–5 s, handles merged cells)
 *        → falls back to pdfjs text → Claude if Reducto is not set
 *   3. Return structured r esult directly (no job queue, no Realtime)
 */
export async function importPdfDirect(
  file: File,
  onProgress?: (pct: number, stage: string) => void,
  options?: { fullExtract?: boolean }
): Promise<PdfExtractResult> {
  onProgress?.(5, 'Reading PDF…')
  const { text: fallbackText, pageCount } = await extractPdfText(file)
  logImport(`pdf text extracted — pages: ${pageCount} chars: ${fallbackText.length}`)

  onProgress?.(15, 'Extracting with AI…')

  // Send the file (for Reducto) and the pdfjs text (as fallback) together.
  // The server picks Reducto when REDUCTO_API_KEY is configured; otherwise
  // it uses the fallback_text directly — no code change needed on the client.
  const formData = new FormData()
  formData.append('file', file, file.name)
  formData.append('file_name', file.name)
  formData.append('fallback_text', fallbackText)
  if (options?.fullExtract) {
    formData.append('full_extract', 'true')
  }

  const res = await fetch('/api/extract', {
    method: 'POST',
    body: formData,
  })

  onProgress?.(90, 'Processing response…')

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Extraction failed (HTTP ${res.status})`)
  }

  const data = await res.json()
  if (!data.success) throw new Error(data.error ?? 'Extraction returned unsuccessful')

  onProgress?.(100, 'Done!')
  logImport('importPdfDirect complete', {
    rows: data.rows_extracted,
    method: data.extraction_method,
    duration_ms: data.metrics?.duration_ms,
  })
  return data as PdfExtractResult
}

/** Browser console + optional prod: set NEXT_PUBLIC_DEBUG_PRODUCT_IMPORT=1 */
function importDebug(): boolean {
  return (
    process.env.NODE_ENV === 'development' ||
    process.env.NEXT_PUBLIC_DEBUG_PRODUCT_IMPORT === '1'
  )
}

function logImport(...args: unknown[]) {
  if (importDebug()) console.log('[product-import]', ...args)
}

function cleanNum(raw: string | undefined): number | null {
  if (!raw) return null
  const n = parseFloat(raw.replace(/,/g, '').replace(/[^\d.-]/g, ''))
  return isNaN(n) ? null : n
}

function extractImportMetaFromText(text: string, fileName: string, sourceType: 'pdf' | 'excel_or_csv'): ImportMeta {
  const normalized = text.replace(/\r/g, ' ').replace(/\s+/g, ' ').trim()

  const clientMatch = normalized.match(/CLIENT DETAILS\s*:?\s*([^\n:]+?)\s+CONTAINER NO/i)
  const containerMatch = normalized.match(/CONTAINER NO\s*:?\s*([A-Z0-9-]+)/i)

  const totalWeightKgs = cleanNum(normalized.match(/TOTAL WEIGHT\s*([\d,]+(?:\.\d+)?)/i)?.[1])
  const totalCbm = cleanNum(normalized.match(/TOTAL CBM\s*([\d,]+(?:\.\d+)?)/i)?.[1])
  const totalCarton = cleanNum(normalized.match(/TOTAL CARTON\s*([\d,]+(?:\.\d+)?)/i)?.[1])

  const totalCostRmb = cleanNum(
    normalized.match(/TOTAL COST\s*[¥￥]?\s*([\d,]+(?:\.\d+)?)/i)?.[1]
  )
  const totalCostUsd = cleanNum(
    normalized.match(/TOTAL COST[\s\S]*?\$\s*([\d,]+(?:\.\d+)?)/i)?.[1]
  )
  const paymentDateMatch = normalized.match(/(\d{2}\/\d{2}\/\d{4})\s+PAYMENT/i)
  const paymentDate = paymentDateMatch?.[1] ?? null
  const paymentUsd = cleanNum(
    normalized.match(/\d{2}\/\d{2}\/\d{4}\s+PAYMENT\s*\$?\s*([\d,]+(?:\.\d+)?)/i)?.[1]
  )
  const goodsBalanceUsd = cleanNum(
    normalized.match(/GOODS BALANCE\s*\$?\s*([\d,]+(?:\.\d+)?)/i)?.[1]
  )
  const creditSupportUsd = cleanNum(
    normalized.match(/CREDIT SUPPORT TO MOMBASA\s*\$?\s*([\d,]+(?:\.\d+)?)/i)?.[1]
  )
  const pivocUsd = cleanNum(
    normalized.match(/PIVOC\s*\$?\s*([\d,]+(?:\.\d+)?)/i)?.[1]
  )
  const freightUsd = cleanNum(
    normalized.match(/YIWU[- ]MOMBASA FREIGHT\s*\$?\s*([\d,]+(?:\.\d+)?)/i)?.[1]
  )
  const totalBalanceUsd = cleanNum(
    normalized.match(/TOTAL BALANCE\s*\$?\s*([\d,]+(?:\.\d+)?)/i)?.[1]
  )
  const exchangeRate = cleanNum(
    normalized.match(/EXCHANGE RATE\s*[:=]?\s*[¥]?\s*([\d.]+)\s*(?:RMB)?/i)?.[1]
  )

  return {
    source_file_name: fileName,
    source_file_type: sourceType,
    document_type: inferDocumentType(fileName, normalized),
    client_details: clientMatch?.[1]?.trim() ?? null,
    container_no: containerMatch?.[1]?.trim() ?? null,
    total_weight_kgs: totalWeightKgs,
    total_cbm: totalCbm,
    total_carton: totalCarton,
    total_cost_rmb: totalCostRmb,
    total_cost_usd: totalCostUsd,
    payment_date: paymentDate,
    payment_usd: paymentUsd,
    goods_balance_usd: goodsBalanceUsd,
    credit_support_usd: creditSupportUsd,
    pivoc_usd: pivocUsd,
    freight_usd: freightUsd,
    total_balance_usd: totalBalanceUsd,
    exchange_rate: exchangeRate,
  }
}

function inferDocumentType(fileName: string, normalizedText: string): 'sales_order' | 'container_manifest' {
  const name = fileName.toLowerCase()
  const text = normalizedText.toLowerCase()
  if (
    name.includes('销售单') ||
    text.includes('销售单') ||
    text.includes('warehouse') ||
    text.includes('仓位') ||
    text.includes('box.no')
  ) {
    return 'sales_order'
  }
  return 'container_manifest'
}

function isSalesOrderText(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('销售单') ||
    (t.includes('no.') && t.includes('u/p') && t.includes('amount') && t.includes('t.qty')) ||
    (t.includes('序号') && t.includes('总箱数') && t.includes('单价'))
  )
}

export function exportProductsToExcel(products: Product[]) {
  const rows = products.map(p => ({
    'MARKS / SKU': p.sku ?? '',
    Name: p.name ?? '',
    'SHOP#': p.shop_name ?? '',
    Description: p.description ?? '',
    Supplier: p.suppliers?.name ?? '',
    Packing: p.packing ?? '',
    'T.CTN': p.cartons ?? '',
    Unit: p.unit,
    'T.QTY': p.quantity,
    'T.CBM': p.cbm ?? '',
    'UNIT WEIGHT': p.unit_weight ?? '',
    'T.WEIGHT': p.total_weight ?? '',
    'U.PRICE (RMB)': p.cost_price || '',
    'T.AMOUNT (RMB)': p.total_amount_rmb ?? '',
    'Selling Price': p.selling_price || '',
    'Reorder Level': p.reorder_level || '',
  }))
  const ws = XLSX.utils.json_to_sheet(rows)
  // Column widths
  ws['!cols'] = [
    { wch: 16 }, { wch: 28 }, { wch: 14 }, { wch: 30 }, { wch: 16 },
    { wch: 14 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 12 },
    { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 12 },
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Products')
  XLSX.writeFile(wb, `products_${Date.now()}.xlsx`)
}

export function exportMovementsToExcel(movements: StockMovement[]) {
  const rows = movements.map(m => ({
    Date: formatDateTime(m.created_at),
    Product: m.products?.name ?? '',
    SKU: m.products?.sku ?? '',
    Type: m.movement_type,
    Quantity: m.quantity,
    Unit: m.products?.unit ?? '',
    Reference: m.reference ?? '',
    Notes: m.notes ?? '',
  }))
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Stock Movements')
  XLSX.writeFile(wb, `stock_movements_${Date.now()}.xlsx`)
}

export function exportProductsToPdf(products: Product[]) {
  const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const totalCbm = products.reduce((s, p) => s + (p.cbm ?? 0), 0)
  const totalWeight = products.reduce((s, p) => s + parseFloat(String(p.total_weight ?? '0').replace(/[^\d.]/g, '') || '0'), 0)
  const totalCartons = products.reduce((s, p) => s + (p.cartons ?? 0), 0)
  const totalAmount = products.reduce((s, p) => s + (p.total_amount_rmb ?? 0), 0)

  const headers = ['MARKS / SKU', 'Name', 'Description', 'SHOP#', 'Packing', 'CTN', 'Qty', 'CBM', 'U.Wt', 'T.Wt', 'Unit Price ¥', 'T.Amount ¥']
  const headerRow = headers.map(h => `<th>${esc(h)}</th>`).join('')

  const bodyRows = products.map((p, i) => {
    const cells = [
      p.sku ?? '-',
      p.name ?? '-',
      p.description ?? '-',
      p.shop_name ?? p.suppliers?.name ?? '-',
      p.packing ?? '-',
      p.cartons ?? '-',
      `${p.quantity} ${p.unit}`,
      p.cbm != null ? p.cbm.toFixed(3) : '-',
      p.unit_weight ?? '-',
      p.total_weight ?? '-',
      p.cost_price > 0 ? `¥${p.cost_price.toLocaleString()}` : '-',
      p.total_amount_rmb != null ? `¥${p.total_amount_rmb.toLocaleString()}` : '-',
    ].map(c => `<td>${esc(String(c))}</td>`).join('')
    return `<tr class="${i % 2 === 1 ? 'alt' : ''}">${cells}</tr>`
  }).join('')

  const totalsRow = [
    '<td class="bold">TOTALS</td>',
    '<td></td><td></td><td></td><td></td>',
    `<td class="bold">${totalCartons || '-'}</td>`,
    '<td></td>',
    `<td class="bold">${totalCbm > 0 ? totalCbm.toFixed(3) : '-'}</td>`,
    '<td></td>',
    `<td class="bold">${totalWeight > 0 ? `${totalWeight.toFixed(1)} KGS` : '-'}</td>`,
    '<td></td>',
    `<td class="bold">${totalAmount > 0 ? `¥${totalAmount.toLocaleString()}` : '-'}</td>`,
  ].join('')

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Product Inventory Report</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 8pt; margin: 0; padding: 8mm; color: #111; }
  h2 { margin: 0 0 1mm; font-size: 11pt; }
  p  { margin: 0 0 4mm; font-size: 7.5pt; color: #555; }
  table { border-collapse: collapse; width: 100%; table-layout: auto; }
  th { background: #1e293b; color: #fff; padding: 2px 4px; font-size: 7pt; text-align: left; white-space: nowrap; }
  td { border: 1px solid #d1d5db; padding: 2px 4px; font-size: 7.5pt; vertical-align: top; word-break: break-word; }
  tr.alt td { background: #f8fafc; }
  tr.totals td { background: #e2e8f0; }
  .bold { font-weight: bold; }
  @media print { @page { size: A3 landscape; margin: 8mm; } }
</style>
</head>
<body>
<h2>Product Inventory Report</h2>
<p>Generated: ${new Date().toLocaleString()} &nbsp;|&nbsp; ${products.length} items</p>
<table>
  <thead><tr>${headerRow}</tr></thead>
  <tbody>
    ${bodyRows}
    <tr class="totals">${totalsRow}</tr>
  </tbody>
</table>
<script>window.onload = () => { window.print(); }</script>
</body>
</html>`

  const win = window.open('', '_blank', 'width=1400,height=900')
  if (win) {
    win.document.write(html)
    win.document.close()
  }
}

export function exportMovementsToPdf(movements: StockMovement[]) {
  const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const headers = ['Date', 'Product', 'SKU', 'Type', 'Qty', 'Unit', 'Reference', 'Notes']
  const headerRow = headers.map(h => `<th>${esc(h)}</th>`).join('')
  const bodyRows = movements.map((m, i) => {
    const cells = [
      formatDateTime(m.created_at),
      m.products?.name ?? '-',
      m.products?.sku ?? '-',
      m.movement_type,
      m.quantity,
      m.products?.unit ?? '-',
      m.reference ?? '-',
      m.notes ?? '-',
    ].map(c => `<td>${esc(String(c))}</td>`).join('')
    return `<tr class="${i % 2 === 1 ? 'alt' : ''}">${cells}</tr>`
  }).join('')

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Stock Movements Report</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 8pt; margin: 0; padding: 8mm; color: #111; }
  h2 { margin: 0 0 1mm; font-size: 11pt; }
  p  { margin: 0 0 4mm; font-size: 7.5pt; color: #555; }
  table { border-collapse: collapse; width: 100%; }
  th { background: #1e293b; color: #fff; padding: 3px 5px; font-size: 7.5pt; text-align: left; white-space: nowrap; }
  td { border: 1px solid #d1d5db; padding: 3px 5px; font-size: 8pt; vertical-align: top; word-break: break-word; }
  tr.alt td { background: #f8fafc; }
  @media print { @page { size: A3 landscape; margin: 8mm; } }
</style>
</head>
<body>
<h2>Stock Movements Report</h2>
<p>Generated: ${new Date().toLocaleString()}</p>
<table>
  <thead><tr>${headerRow}</tr></thead>
  <tbody>${bodyRows}</tbody>
</table>
<script>window.onload = () => { window.print(); }</script>
</body>
</html>`

  const win = window.open('', '_blank', 'width=1200,height=800')
  if (win) {
    win.document.write(html)
    win.document.close()
  }
}

function isPdfFile(file: File): boolean {
  const name = file.name.trim().toLowerCase()
  const type = (file.type ?? '').toLowerCase()
  return name.endsWith('.pdf') || type === 'application/pdf'
}

function isCsvFile(file: File): boolean {
  const name = file.name.trim().toLowerCase()
  const type = (file.type ?? '').toLowerCase()
  return name.endsWith('.csv') || type === 'text/csv'
}

function isLikelyMarksCell(raw: string): boolean {
  const v = raw.split('\n')[0].trim()
  if (!v) return false
  if (v.length < 3) return false
  if (/\s/.test(v)) return false
  const u = v.toUpperCase()
  if (/[¥￥]/.test(v)) return false
  if (/[\\/]/.test(v)) return false
  return !(
    u.includes('MARKS') ||
    u.includes('PACKING') ||
    u.includes('ITEM') ||
    u.includes('SHOP') ||
    u.includes('CLIENT DETAILS') ||
    u.includes('CONTAINER NO') ||
    u.includes('NEW ORDER') ||
    u.includes('GOODS LEFT') ||
    u.includes('GOODS BALANCE') ||
    u.includes('TOTAL ') ||
    u.includes('PCS') ||
    u.includes('CTN') ||
    u.includes('CBM') ||
    u.includes('KGS')
  )
}

/**
 * Packing-list rows arrive with varying column alignments across pages
 * (the source PDF repeats its header on every page with a different number of
 * merged/blank padding cells, and some rows have item-no+description merged
 * into a single cell). Extract fields by *pattern* from each cell, so we
 * don't depend on a single positional header map.
 *
 * Returns null for non-product rows (headers, totals, payment lines, blanks).
 */
function extractPackingListRow(cells: unknown[]): Record<string, unknown> | null {
  const txt = cells.map(c => String(c ?? '').trim())
  const marks = txt[0] ?? ''
  if (!isLikelyMarksCell(marks)) return null

  const shop = txt[1] ?? ''
  const used = new Set<number>([0, 1])

  let packing = ''
  let tCtn = ''
  let tQty = ''
  let unitCbm = ''
  let tCbm = ''
  let uWt = ''
  let tWt = ''
  let uPrice = ''
  let tAmount = ''

  for (let i = 2; i < txt.length; i++) {
    const t = txt[i]
    if (!t) continue
    if (!packing && /\d+\s*[A-Za-z]+\s*\/\s*ctn/i.test(t)) { packing = t; used.add(i); continue }
    if (!tCtn && /^\s*\d+\s*CTNS?\s*$/i.test(t))            { tCtn = t;    used.add(i); continue }
    if (!tQty && /^\s*\d+\s*pcs\s*$/i.test(t))              { tQty = t;    used.add(i); continue }
    if (/^\s*[\d.]+\s*CBM\s*$/i.test(t)) {
      if (!unitCbm) { unitCbm = t; used.add(i); continue }
      if (!tCbm) { tCbm = t; used.add(i); continue }
    }
    if (/^\s*[\d.]+\s*KGS\s*$/i.test(t)) {
      if (!uWt) { uWt = t; used.add(i); continue }
      if (!tWt) { tWt = t; used.add(i); continue }
    }
    if (/^\s*[¥￥]\s*[\d,]+(?:\.\d+)?\s*$/.test(t)) {
      if (!uPrice)  { uPrice = t;  used.add(i); continue }
      if (!tAmount) { tAmount = t; used.add(i); continue }
    }
  }

  // Worst-case: the matched PACKING cell is a multi-line blob that also
  // contains item no., description, and Chinese detail (PDF merged them into
  // a single cell). Split out the real "NNpcs/ctn" token and feed the
  // surrounding text through the leftovers pipeline below.
  const extraLeftovers: string[] = []
  if (packing && (/[\n\r]/.test(packing) || !/^\s*\d+\s*[A-Za-z]+\s*\/\s*ctn\s*$/i.test(packing))) {
    const lines = packing.split(/[\n\r]+/).map(s => s.trim()).filter(Boolean)
    const packingLine = lines.find(l => /\d+\s*[A-Za-z]+\s*\/\s*ctn/i.test(l)) ?? packing
    const pToken = packingLine.match(/\d+\s*[A-Za-z]+\s*\/\s*ctn/i)?.[0]
    if (pToken) {
      const prefix = packingLine.replace(pToken, '').trim()
      packing = pToken.replace(/\s+/g, '')
      for (const l of lines) if (l !== packingLine) extraLeftovers.push(l)
      if (prefix) extraLeftovers.push(prefix)
    }
  }

  // Cells between index 2 and the first matched data column usually hold
  // item-no. (pure digits), English description, and a Chinese detail blob.
  const matchedIdxs = [...used].filter(i => i >= 2)
  const firstMatched = matchedIdxs.length ? Math.min(...matchedIdxs) : txt.length
  const leftovers = [...txt.slice(2, firstMatched).filter(Boolean), ...extraLeftovers]

  let itemNo = ''
  let desc = ''
  let detail = ''

  const assignMerged = (c: string): boolean => {
    const m = c.match(/^(\d+)?\s*([A-Za-z][A-Za-z0-9\s.()\/-]*?)?\s*([\u4e00-\u9fff][\s\S]*)?$/)
    if (!m || (!m[1] && !m[2] && !m[3])) return false
    // Require at least two of {digits, english, chinese} to consider it "merged"
    const parts = [m[1], m[2]?.trim(), m[3]?.trim()].filter(Boolean).length
    if (parts < 2) return false
    if (!itemNo && m[1]) itemNo = m[1]
    if (!desc && m[2]) desc = m[2].trim()
    if (m[3]) detail = detail ? `${detail} ${m[3].trim()}` : m[3].trim()
    return true
  }

  for (const c of leftovers) {
    if (!itemNo && /^\s*\d+\s*$/.test(c)) { itemNo = c.trim(); continue }
    if (!desc && /^[A-Za-z][A-Za-z0-9\s.()\/-]*$/.test(c)) { desc = c; continue }
    if (assignMerged(c)) continue
    detail = detail ? `${detail} ${c}` : c
  }

  return {
    MARKS: marks,
    'SHOP#': shop,
    'ITEM NO.': itemNo,
    'DESCRIPTION OF GOODS': desc,
    __col6: detail,
    PACKING: packing,
    'T.CTN': tCtn,
    'T.QTY': tQty,
    'UNIT CBM': unitCbm,
    'T.CBM': tCbm,
    'UNIT WEIGHT': uWt,
    'T.WEIGHT': tWt,
    'U.PRICE (RMB)': uPrice,
    'T.AMOUNT': tAmount,
  }
}

export async function parseExcelFile(file: File): Promise<Record<string, unknown>[]> {
  let allRows: unknown[][]
  /** Only set for binary .xlsx/.xls — used if header detection fails */
  let wsFallback: XLSX.WorkSheet | undefined

  if (isCsvFile(file)) {
    // RFC 4180 CSV with quoted newlines (MARKS cell, headers). SheetJS splits those rows wrong.
    const text = await file.text()
    allRows = parseCsvRows(text)
    logImport(
      'CSV (RFC4180 parser): rows=',
      allRows.length,
      'first logical row columns=',
      allRows[0]?.length ?? 0
    )
  } else {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const wb = XLSX.read(bytes, { type: 'array' })
    logImport('Excel/CSV', file.name, 'sheets:', wb.SheetNames.join(', '))
    wsFallback = wb.Sheets[wb.SheetNames[0]]
    allRows = XLSX.utils.sheet_to_json(wsFallback, { header: 1, defval: '' })
  }

  // Packing-list fast path: if any row's first cell starts with a valid MARKS
  // SKU (e.g. "MS-T-201-1"), this is a packing list. These files repeat the
  // header across pages with inconsistent column padding, so we bypass the
  // positional header map and extract every field by pattern per row.
  const packingCandidates = allRows.filter(r => {
    const first = String(((r as unknown[])?.[0]) ?? '').split('\n')[0].trim()
    return isLikelyMarksCell(first)
  })
  if (packingCandidates.length >= 2) {
    const isExcelBinary = /\.xlsx?$/i.test(file.name)
    const maxCols = Math.max(0, ...allRows.map(r => (r as unknown[])?.length ?? 0))
    if (isExcelBinary && maxCols <= 2) {
      const textBlob = allRows
        .flatMap(r => (r as unknown[]).map(c => String(c ?? '').trim()))
        .filter(Boolean)
        .join('\n')
      const recovered = parsePackingRowsFromTextBlob(textBlob)
      if (recovered.length) {
        logImport(
          'packing-list 2-column excel recovery:',
          recovered.length,
          'rows recovered from text blob'
        )
        return recovered
      }
      const sheetRef = wsFallback?.['!ref'] ?? 'unknown'
      throw new Error(
        `This Excel workbook only stores two columns (${sheetRef}) and no recoverable packing-list rows were found. Import the full .csv packing list instead, or re-export the spreadsheet so all columns (through T.AMOUNT) are saved in Excel.`
      )
    }
    logImport(
      'packing-list mode: detected',
      packingCandidates.length,
      'MARKS rows — extracting fields per-row by pattern'
    )
    const extracted: Record<string, unknown>[] = []
    for (const row of allRows) {
      const r = extractPackingListRow(row as unknown[])
      if (r) extracted.push(r)
    }
    if (extracted[0]) {
      logImport('packing-list first extracted row:', {
        MARKS: String(extracted[0].MARKS).slice(0, 40),
        'DESCRIPTION OF GOODS': extracted[0]['DESCRIPTION OF GOODS'],
        PACKING: extracted[0].PACKING,
        'T.CTN': extracted[0]['T.CTN'],
        'T.QTY': extracted[0]['T.QTY'],
        'U.PRICE (RMB)': extracted[0]['U.PRICE (RMB)'],
        'T.AMOUNT': extracted[0]['T.AMOUNT'],
      })
    }
    logImport('packing-list extracted rows:', extracted.length)
    return extracted
  }

  // Find the header row: any cell equals "MARKS" (handles merged cells / shifted export)
  // or standard inventory column names from our Excel export
  const headerIdx = allRows.findIndex(row => {
    const cells = (row ?? []).map(c =>
      String(c ?? '')
        .trim()
        .replace(/\n/g, ' ')
    )
    if (cells.some(c => /^MARKS$/i.test(c))) return true
    // Template from exportProductsToExcel uses "MARKS / SKU"
    if (cells.some(c => /MARKS\s*\/\s*SKU/i.test(String(c)))) return true
    const lower = cells.map(c => c.toLowerCase())
    return lower.some(c => c === 'sku' || c === 'name')
  })

  if (headerIdx === -1) {
    logImport(
      'parseExcelFile: no MARKS/SKU header row — using fallback if possible'
    )
    if (wsFallback) {
      const fallback = XLSX.utils.sheet_to_json(wsFallback, { defval: '' }) as Record<
        string,
        unknown
      >[]
      logImport('xlsx fallback row count:', fallback.length, 'first keys:', Object.keys(fallback[0] ?? {}))
      return fallback
    }
    // CSV without a MARKS row: treat first row as headers
    if (allRows.length === 0) return []
    const hdr = allRows[0].map((h, i) =>
      String(h ?? '')
        .trim()
        .replace(/\n/g, ' ') || `__col${i}`
    )
    const out: Record<string, unknown>[] = []
    for (let i = 1; i < allRows.length; i++) {
      const row = allRows[i] as unknown[]
      const obj: Record<string, unknown> = {}
      hdr.forEach((h, idx) => {
        obj[h] = row[idx] ?? ''
      })
      out.push(obj)
    }
    logImport('CSV generic fallback rows:', out.length)
    return out
  }

  logImport(
    'parseExcelFile: header row index:',
    headerIdx,
    'columns in header row:',
    (allRows[headerIdx] as unknown[])?.length ?? 0
  )
  const rawHeaders = (allRows[headerIdx] as unknown[]).map(h =>
    String(h ?? '').trim().replace(/\n/g, ' ')
  )
  // Give unnamed columns a stable placeholder so their data isn't lost
  const headers = rawHeaders.map((h, i) => h || `__col${i}`)

  // Some "packing list" .xlsx files on disk only have columns A–B (MARKS, SHOP#) — the rest
  // of the table was never written to the workbook. Nothing to import for qty/price.
  const isExcelBinary = /\.xlsx$/i.test(file.name) || /\.xls$/i.test(file.name)
  const marksLike = headers.some(h => /^MARKS$/i.test(String(h)))
  const hasPackingListQtyColumns =
    headers.includes('PACKING') ||
    headers.some(h => /PACKING/i.test(String(h))) ||
    headers.includes('T.QTY')
  if (isExcelBinary && marksLike && !hasPackingListQtyColumns) {
    const textBlob = allRows
      .flatMap(r => (r as unknown[]).map(c => String(c ?? '').trim()))
      .filter(Boolean)
      .join('\n')
    const recovered = parsePackingRowsFromTextBlob(textBlob)
    if (recovered.length) {
      logImport(
        'header-mode 2-column excel recovery:',
        recovered.length,
        'rows recovered from text blob'
      )
      return recovered
    }
    const sheetRef = wsFallback?.['!ref'] ?? 'unknown'
    throw new Error(
      `This Excel workbook only stores two columns (${sheetRef}) and no recoverable packing-list rows were found. Import the full .csv packing list instead, or re-export the spreadsheet so all columns (through T.AMOUNT) are saved in Excel.`
    )
  }

  const result: Record<string, unknown>[] = []
  for (let i = headerIdx + 1; i < allRows.length; i++) {
    const row = allRows[i] as unknown[]
    // Skip completely empty rows
    const nonEmpty = row.filter(c => String(c ?? '').trim())
    if (nonEmpty.length === 0) continue
    // Skip section-header rows like "NEW ORDER" (single non-MARKS cell in col 0)
    if (nonEmpty.length === 1 && !isLikelyMarksCell(String(row[0] ?? ''))) continue

    const obj: Record<string, unknown> = {}
    headers.forEach((h, idx) => {
      obj[h] = row[idx] ?? ''
    })
    result.push(obj)
  }

  const sample = result[0]
  logImport('parseExcelFile: data rows:', result.length, 'headers (first 18):', headers.slice(0, 18))
  if (sample) {
    logImport('parseExcelFile: first row snapshot:', {
      MARKS: String(sample.MARKS ?? '').slice(0, 50),
      PACKING: sample.PACKING,
      'T.QTY': sample['T.QTY'],
      'U.PRICE (RMB)': sample['U.PRICE (RMB)'],
      isShiftedHint: !!String(sample.PACKING ?? '').trim() && !/\//.test(String(sample.PACKING)),
    })
  }

  return result
}

function extractMarksFromPdfLine(line: string): string | null {
  const m = line.match(/^\s*(.+?)\s*SANCARGO\b/i)
  if (m && isLikelyMarksCell(m[1])) return m[1].trim()
  const first = line.split(/\s+/)[0]?.trim() ?? ''
  return isLikelyMarksCell(first) ? first : null
}

function extractPackingTextBlocks(text: string): string[] {
  const compact = text.replace(/\r/g, '')
  const blocks: string[] = []
  const re = /([^\s\n]{3,})\s*SANCARGO([\s\S]*?)(?=(?:[^\s\n]{3,}\s*SANCARGO)|$)/gi
  for (const m of compact.matchAll(re)) {
    const marks = (m[1] ?? '').trim()
    let body = (m[2] ?? '').trim()
    if (!isLikelyMarksCell(marks)) continue
    // Trim body at the first document-summary keyword so the grand-total values
    // (e.g. "70.125CBM" for the whole document) can't leak into the last product chunk.
    const summaryIdx = body.search(/\bTOTAL\s+(?:WEIGHT|CBM|CARTON|COST)\b/i)
    if (summaryIdx !== -1) body = body.slice(0, summaryIdx).trim()
    const joined = `${marks} SANCARGO ${body}`.replace(/\s+/g, ' ').trim()
    if (joined) blocks.push(joined)
  }
  return blocks
}

/** Skip PDF boilerplate / totals (not product rows) */
function shouldSkipPdfLine(joined: string): boolean {
  const j = joined.toUpperCase()
  return (
    j.includes('MARKS') ||
    j.includes('DESCRIPTION OF GOODS') ||
    j.includes('CLIENT DETAILS') ||
    j.includes('CONTAINER NO') ||
    j.includes('CUSTOMER CARE') ||
    j.includes('COMPLAINTS LINE') ||
    j.includes('NEW ORDER') ||
    j.includes('GOODS LEFT IN SANCARGO') ||
    j.includes('GOODS BALANCE') ||
    j.includes('TOTAL WEIGHT') ||
    j.includes('TOTAL CBM') ||
    j.includes('TOTAL CARTON') ||
    j.includes('TOTAL COST') ||
    j.includes('BALANCE PAYMENT') ||
    j.includes('PAGE:') ||
    /PAYMENT|USD|RMB|EXCHANGE RATE/i.test(joined)
  )
}

type PdfLineResult =
  | { ok: true; row: Record<string, unknown> }
  | { ok: false; skip: string; preview?: string }

/**
 * Parse one horizontal text line from a packing-list PDF into the same column
 * shape as CSV/Excel import (so importProducts packing-list logic runs).
 */
function parsePdfTableLine(joined: string): Record<string, unknown> | null {
  const r = parsePdfTableLineResult(joined)
  return r.ok ? r.row : null
}

function parsePdfTableLineResult(joined: string, skipKeywordCheck = false): PdfLineResult {
  const line = joined.replace(/\s+/g, ' ').trim()
  if (!line) return { ok: false, skip: 'empty line' }
  if (!skipKeywordCheck && shouldSkipPdfLine(line)) return { ok: false, skip: 'skipped (header/footer keyword)' }

  const hasSancargo = /\bSANCARGO\b/i.test(line)
  // Require SANCARGO as the anchor for regular rows.
  // Exception: rows with a bare MARKS token + packing + CTN (e.g. "MOSES 丰锦 1pcs/ctn 4CTNS")
  // are client-sourced items that don't go through SANCARGO but still belong to the shipment.
  if (!hasSancargo) {
    const hasPacking = /\d+\s*[A-Za-z]+\s*\/\s*ctn/i.test(line)
    const hasCtn = /\d+\s*CTNS?/i.test(line)
    if (!hasPacking || !hasCtn) return { ok: false, skip: 'no SANCARGO anchor' }
  }

  const marks = extractMarksFromPdfLine(line)
  if (!marks) return { ok: false, skip: 'no MARKS token' }
  const marksDisplay = hasSancargo ? `${marks}\nSANCARGO` : marks

  const packingM = line.match(/(\d+\s*[A-Za-z]+\s*\/\s*ctn)/i)
  const tCtnM = line.match(/(\d+)\s*CTNS?/i)
  // Rows in this PDF often omit packing when it repeats from a prior row.
  // Accept rows that have explicit carton count + a ¥ price; LLM alignment fills packing.
  // Also accept non-SANCARGO rows (e.g. "MOSES") if they have CTNs + packing — these are
  // client-sourced items billed separately that still count toward the container total.
  if (!packingM && !(tCtnM && /[¥￥]/.test(line))) {
    return { ok: false, skip: 'no PACKING and insufficient row data', preview: line.slice(0, 120) }
  }

  const packing = packingM ? packingM[1].replace(/\s+/g, '') : ''
  const cartonsStr = tCtnM ? `${tCtnM[1]}CTNS` : ''
  const cartonsNum = parseInt(tCtnM?.[1] ?? '0') || 0

  const afterCtn = line.match(/(\d+)\s*CTNS?\s+(\d+)\s*([A-Za-z]+)/i)
  const qtyStr = afterCtn
    ? `${afterCtn[2]}${afterCtn[3]}`
    : (line.match(/(\d+)\s*(?:pcs?|sets?|prs?|nos?)(?!\/)/i)?.[1] ?? '')

  // Require at least one digit before the decimal so "T.CBM" header text never matches.
  // Filter against carton count: a single product's T.CBM can't exceed cartons × 10 CBM
  // (very generous — catches the document-total value that leaks into the last product chunk,
  // e.g. 70.125 CBM for a whole container attributed to a 3-carton product).
  const cbmMatches = [...line.matchAll(/(\d+\.?\d*)\s*CBM/gi)]
  const maxCbmForProduct = cartonsNum > 0 ? cartonsNum * 10 : Infinity
  const validCbmMatches = cbmMatches.filter(m => {
    const v = parseFloat(m[1])
    return !isNaN(v) && v <= maxCbmForProduct
  })
  // 2 valid matches → first = UNIT CBM, second = T.CBM (PDFs with both columns).
  // 1 valid match  → it's T.CBM; leave unit CBM empty (PDF has only T.CBM column).
  const unitCbmStr = validCbmMatches.length >= 2 ? `${validCbmMatches[0][1]}CBM` : ''
  const cbmStr = validCbmMatches.length >= 2 ? `${validCbmMatches[1][1]}CBM` : validCbmMatches[0] ? `${validCbmMatches[0][1]}CBM` : ''

  const kgsMatches = [...line.matchAll(/([\d.]+)\s*KGS/gi)]
  const unitWt = kgsMatches[0] ? `${kgsMatches[0][1]}KGS` : ''
  const totalWt = kgsMatches[1] ? `${kgsMatches[1][1]}KGS` : kgsMatches[0] ? `${kgsMatches[0][1]}KGS` : ''

  const yenMatches = [...line.matchAll(/[¥￥]\s*([\d,]+(?:\.\d+)?)/g)]
  const unitPriceStr = yenMatches[0] ? `¥${yenMatches[0][1]}` : ''
  const totalAmtStr = yenMatches[1] ? `¥${yenMatches[1][1]}` : ''

  // Shop + Description: PDF renderers sometimes insert spaces within Chinese
  // characters (e.g. "龙凤保温 瓶"), breaking the \S+ single-token approach.
  // Use Unicode CJK range to capture the full Chinese shop name, then extract
  // the English/mixed description that follows the optional item number.
  let shop = ''
  let descMain = ''
  let descDetail = ''

  // Allow an optional leading numeric shop code before the CJK shop name
  // e.g. "SANCARGO 49371 \u5929\u4e3d 4 Sleepwear \u51ac\u5b63\u5e26\u5e3d\u7761\u8863" where 49371 is a shop code
  const shopDescM = line.match(
    /\bSANCARGO\s+(?:\d+\s+)?((?:[\u4e00-\u9fff]\s*)+)\s*(?:\d+\s+)?(.+?)\s+\d+\s*[A-Za-z]+\s*\/\s*ctn/i
  )
  if (shopDescM) {
    shop = shopDescM[1].replace(/\s+/g, '').trim()
    const blob = shopDescM[2].trim()
    splitDesc(blob)
  } else {
    // Fallback for rows with non-Chinese shop names
    const shopPack = line.match(/\bSANCARGO\s+(.+?)\s+(\d+\s*[A-Za-z]+\s*\/\s*ctn)/i)
    if (shopPack) {
      shop = shopPack[1].replace(/\s+\d+\s*$/, '').trim()
    }
    const itemAndDesc = line.match(
      /\bSANCARGO\s+\S+\s+(\d+)\s+(.+?)\s+\d+\s*[A-Za-z]+\s*\/\s*ctn/i
    )
    if (itemAndDesc) splitDesc(itemAndDesc[2].trim())
  }

  function splitDesc(blob: string) {
    // Split English description from Chinese detail at the first CJK character
    const parts = blob.split(/\s+(?=[\u4e00-\u9fff])/)
    if (parts.length >= 2) {
      descMain = parts[0]
      descDetail = parts.slice(1).join(' ')
    } else {
      const cut = blob.search(/[\u4e00-\u9fff]/)
      if (cut > 0) {
        // English first, Chinese suffix
        descMain = blob.slice(0, cut).trim()
        descDetail = blob.slice(cut).trim()
      } else if (cut === 0) {
        // All-Chinese blob: store as detail and try to pull out an English model number
        descDetail = blob
        const modelMatch = blob.match(/\b([A-Z][\w\-./]+(?:\s+[\w\-./]+)*)\s*$/)
        descMain = modelMatch ? modelMatch[1].trim() : ''
      } else {
        // Pure English/numbers — no Chinese at all
        descMain = blob
      }
    }
  }

  return {
    ok: true,
    row: {
      MARKS: marksDisplay,
      'SHOP#': shop,
      'ITEM NO.': '',
      'DESCRIPTION OF GOODS': descMain || descDetail || '',
      __col6: descDetail || '',
      PACKING: packing,
      'T.CTN': cartonsStr,
      'T.QTY': qtyStr,
      'UNIT CBM': unitCbmStr,
      'T.CBM': cbmStr,
      'UNIT WEIGHT': unitWt,
      'T.WEIGHT': totalWt,
      'U.PRICE (RMB)': unitPriceStr,
      'T.AMOUNT': totalAmtStr,
    },
  }
}

/**
 * Recover packing-list rows from flattened text streams (common in some
 * 2-column .xlsx conversions where all detail cells were collapsed).
 */
function parsePackingRowsFromTextBlob(text: string): Record<string, unknown>[] {
  const chunks = extractPackingTextBlocks(text)
  const rows: Record<string, unknown>[] = []
  for (const chunk of chunks) {
    const result = parsePdfTableLineResult(chunk, true)
    if (result.ok) rows.push(result.row)
  }
  return rows
}

function parseSalesOrderRowsFromTextBlob(text: string): Record<string, unknown>[] {
  const lines = text
    .replace(/\r/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !/^--\s*\d+\s+of\s+\d+\s*--$/i.test(l))

  const rowStartIndexes: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/^\d+\s+\d{4}-\d{2}-\d{2}$/.test(lines[i])) rowStartIndexes.push(i)
  }
  if (!rowStartIndexes.length) return []

  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < rowStartIndexes.length; i++) {
    const start = rowStartIndexes[i]
    const end = i + 1 < rowStartIndexes.length ? rowStartIndexes[i + 1] : lines.length
    const chunk = lines.slice(start, end)
    const joined = chunk.join(' ').replace(/\s+/g, ' ').trim()
    if (!joined) continue

    const metrics = joined.match(
      /(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+([A-Za-z0-9]{8,})\s+(\S+)$/i
    )
    if (!metrics) continue

    const [
      metricsBlock,
      ctn,
      qtyPerCtn,
      totalQty,
      unitPrice,
      amount,
      l,
      w,
      h,
      unitCbm,
      unitGw,
      totalCbm,
      totalKgs,
      barcode,
      warehouse,
    ] = metrics

    const prefix = joined.slice(0, joined.length - metricsBlock.length).trim()
    const orderNo = prefix.match(/C\d{2,}-\d+/i)?.[0] ?? ''
    const codeMatches = prefix.match(/\b[A-Za-z][A-Za-z0-9]*(?:[-/][A-Za-z0-9]+)+\b/g) ?? []
    const itemCode = codeMatches.find(code => code.toUpperCase() !== orderNo.toUpperCase()) ?? ''
    const descSource = itemCode ? prefix.slice(prefix.indexOf(itemCode) + itemCode.length).trim() : prefix

    rows.push({
      MARKS: itemCode || `SO-${start}`,
      'SHOP#': warehouse,
      'ITEM NO.': orderNo,
      'DESCRIPTION OF GOODS': descSource || itemCode || orderNo || '',
      __col6: `barcode:${barcode} dims:${l}x${w}x${h}`,
      PACKING: `${qtyPerCtn}pcs/ctn`,
      'T.CTN': `${ctn}CTNS`,
      'T.QTY': `${totalQty}pcs`,
      'UNIT CBM': `${unitCbm}CBM`,
      'T.CBM': `${totalCbm}CBM`,
      'UNIT WEIGHT': `${unitGw}KGS`,
      'T.WEIGHT': `${totalKgs}KGS`,
      'U.PRICE (RMB)': `¥${unitPrice}`,
      'T.AMOUNT': `¥${amount}`,
    })
  }
  return rows
}

function isStageMarkerRow(row: Record<string, unknown>): boolean {
  const marks = String(row.MARKS ?? '')
  return marks.startsWith(STAGE_SECTION_MARKER_PREFIX) || marks.startsWith(STAGE_TOTAL_MARKER_PREFIX)
}

function extractStageTotalLine(line: string): string | null {
  const m = line.match(/(\d+\s*CTNS?).*?([\d.]+\s*CBM).*?([\d.]+\s*KGS)(?:.*?([¥￥]\s*[\d,]+(?:\.\d+)?))?/i)
  if (!m) return null
  const ctn = m[1].replace(/\s+/g, '').toUpperCase()
  const cbm = m[2].replace(/\s+/g, '').toUpperCase()
  const kgs = m[3].replace(/\s+/g, '').toUpperCase()
  const amount = m[4] ? m[4].replace(/\s+/g, '') : ''
  return [ctn, cbm, kgs, amount].filter(Boolean).join(' ')
}

/** Parse a packing-list PDF — output matches CSV column keys for importProducts */
export async function parsePdfFile(file: File): Promise<Record<string, unknown>[]> {
  logImport('PDF import:', file.name)
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise
  const rows: Record<string, unknown>[] = []
  let skipSamples = 0
  const MAX_SKIP_LOG = 25
  let pastSancargo = false
  let carryMarkLine: string | null = null

  const Y_BUCKET = 4

  const pageTextBlobs: string[] = []

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const content = await page.getTextContent()
    pageTextBlobs.push(
      content.items
        .map(item => ('str' in item ? String((item as { str?: string }).str ?? '') : ''))
        .join('\n')
    )

    const lineMap = new Map<number, { x: number; text: string }[]>()
    for (const item of content.items) {
      if (!('str' in item)) continue
      const ty = (item as { transform: number[] }).transform[5]
      const yKey = Math.round(ty / Y_BUCKET) * Y_BUCKET
      const x = (item as { transform: number[] }).transform[4]
      const text = String((item as { str?: string }).str ?? '').trim()
      if (!text) continue
      if (!lineMap.has(yKey)) lineMap.set(yKey, [])
      lineMap.get(yKey)!.push({ x, text })
    }

    const sortedYs = Array.from(lineMap.keys()).sort((a, b) => b - a)
    const rawLines: string[] = []
    for (const y of sortedYs) {
      const cells = lineMap.get(y)!.sort((a, b) => a.x - b.x)
      const joined = cells.map(c => c.text).join(' ').replace(/\s+/g, ' ').trim()
      if (joined) rawLines.push(joined)
    }

    // Merge a MARKS-only line with the following line when that line starts with
    // (or is exactly) "SANCARGO". pdfjs sometimes places the MARKS text at a
    // slightly different Y than SANCARGO+data, splitting what should be one row
    // into two separate Y-bucket lines.  We handle both:
    //   • "SANCARGO" alone  (original case)
    //   • "SANCARGO <shop> <desc> <packing> …"  (SANCARGO+data on same Y)
    //
    // Cross-page carry: if the previous page ended with an orphaned MARKS line
    // (no SANCARGO because the row was split across the page break), prepend it
    // so it can merge with this page's first SANCARGO line.
    const effectiveLines = carryMarkLine ? [carryMarkLine, ...rawLines] : rawLines
    carryMarkLine = null
    const merged: string[] = []
    for (let i = 0; i < effectiveLines.length; i++) {
      const cur = effectiveLines[i]
      const next = effectiveLines[i + 1]
      if (
        isLikelyMarksCell(cur) &&
        next &&
        /^\s*SANCARGO\b/i.test(next) &&
        !/\bSANCARGO\b/i.test(cur)
      ) {
        merged.push(`${cur} ${next}`)
        i++
      } else merged.push(cur)
    }

    // If the last merged line is an isolated MARKS with no SANCARGO it is likely
    // at a page boundary — save it so the next page can complete the merge.
    if (!pastSancargo && merged.length > 0) {
      const last = merged[merged.length - 1]
      if (isLikelyMarksCell(last) && !/\bSANCARGO\b/i.test(last)) {
        carryMarkLine = last
        merged.pop()
      }
    }

    // Second pass: if a SANCARGO line lacks a packing token, its numeric data
    // (packing, qty, CBM, price) may sit on a slightly different Y-bucket.
    // Extend such lines with the immediately following non-product line.
    const packingDetect = /\d+\s*[A-Za-z]+\s*\/\s*ctn/i
    const extended: string[] = []
    for (let i = 0; i < merged.length; i++) {
      const cur = merged[i]
      if (
        /\bSANCARGO\b/i.test(cur) &&
        !packingDetect.test(cur) &&
        i + 1 < merged.length
      ) {
        const nxt = merged[i + 1]
        const nxtFirst = nxt.split(/[\n\s]/)[0].trim()
        if (!isLikelyMarksCell(nxtFirst) && !/\bSANCARGO\b/i.test(nxt)) {
          extended.push(`${cur} ${nxt}`)
          i++
          continue
        }
      }
      extended.push(cur)
    }

    let pageParsed = 0
    let pageSkipped = 0
    for (let li = 0; li < extended.length; li++) {
      const line = extended[li]

      // Fast exit once we have passed the repacked section boundary.
      if (pastSancargo) {
        pageSkipped++
        continue
      }

      // Repacked-goods section stop. The strict regex needs "37-T-1 18 CTN GOODS STUFFED…";
      // the broader substring fallback catches cases where the banner text is split across
      // pdfjs Y-buckets. Only check `line` here — using twoLine risks triggering on the
      // yellow total row when the section banner immediately follows it.
      const extractedStageHeader = extractStageSectionHeader(line)
      const isRepackedBanner =
        !isGoodsLeftHeader(line) && (
          !!extractedStageHeader ||
          /GOODS\s+STUFFED\s+INTO\s+THIS\s+CONTAINER/i.test(line)
        )
      if (isRepackedBanner) {
        pastSancargo = true
        logImport(`PDF p${pageNum}: hit repacked section banner — stopping import`)
        pageSkipped++
        continue
      }

      // "GOODS LEFT IN SANCARGO" header can be split across two Y-bucket lines.
      const twoLine = li + 1 < extended.length
        ? (line + ' ' + extended[li + 1]).replace(/\s+/g, ' ')
        : line
      if (isGoodsLeftHeader(line) || isGoodsLeftHeader(twoLine)) {
        pastSancargo = true
        logImport(`PDF p${pageNum}: hit GOODS LEFT IN SANCARGO — skipping all subsequent rows`)
        pageSkipped++
        continue
      }

      // Section total rows (yellow PDF bands with CTN+CBM+KGS) appear BEFORE
      // the next section header in the document. Detect them here, before
      // section-header detection, so they are captured in document order.
      // Guard: no SANCARGO (product rows) and no labeled TOTAL lines.
      if (!/\bSANCARGO\b/i.test(line) && !shouldSkipPdfLine(line) && !isGoodsLeftHeader(line)) {
        const probe = [
          line,
          `${line} ${extended[li + 1] ?? ''}`.replace(/\s+/g, ' ').trim(),
        ].filter(Boolean)
        const stageTotal = probe.map(extractStageTotalLine).find(Boolean)
        if (stageTotal) {
          rows.push({ MARKS: makeStageTotalSku(stageTotal) })
          continue
        }
      }

      const result = parsePdfTableLineResult(line)
      if (result.ok) {
        rows.push(result.row)
        pageParsed++
      } else {
        pageSkipped++
        if (
          skipSamples < MAX_SKIP_LOG &&
          result.skip !== 'skipped (header/footer keyword)' &&
          result.skip !== 'empty line'
        ) {
          skipSamples++
          logImport(
            `PDF p${pageNum} skip (${result.skip}):`,
            'preview:',
            line.slice(0, 140)
          )
        }
      }
    }
    logImport(`PDF page ${pageNum}/${pdf.numPages}: merged=${merged.length}, extended=${extended.length}, parsed=${pageParsed}, skipped=${pageSkipped}`)
  }

  const fullText = pageTextBlobs.join('\n')
  if (isSalesOrderText(fullText)) {
    const salesRows = parseSalesOrderRowsFromTextBlob(fullText)
    if (salesRows.length > 0) {
      logImport('PDF sales-order parser rows:', salesRows.length, 'sample:', {
        MARKS: String(salesRows[0].MARKS ?? '').slice(0, 40),
        PACKING: salesRows[0].PACKING,
        'T.QTY': salesRows[0]['T.QTY'],
        'U.PRICE (RMB)': salesRows[0]['U.PRICE (RMB)'],
      })
      return salesRows
    }
  }

  logImport(
    'PDF total parsed rows:',
    rows.length,
    'sample:',
    rows[0]
      ? {
          MARKS: String(rows[0].MARKS).slice(0, 40),
          PACKING: rows[0].PACKING,
          'T.QTY': rows[0]['T.QTY'],
          'U.PRICE (RMB)': rows[0]['U.PRICE (RMB)'],
        }
      : '(none)'
  )

  const dataRowCount = rows.filter(r => !isStageMarkerRow(r)).length
  if (rows.length === 0 || dataRowCount === 0) {
    if (rows.length > 0 && dataRowCount === 0) {
      logImport('PDF parse produced only section markers; running fallback parser')
    }
    // Fallback parser for PDFs whose glyph coordinates are too fragmented for Y-bucketing.
    const rawText = fullText
    const sancargoCutIdx = rawText.search(/GOODS\s+LEFT\s+IN\s+SANCARGO/i)
    const text = sancargoCutIdx !== -1 ? rawText.slice(0, sancargoCutIdx) : rawText
    // Cut at the document summary section so TOTAL CBM / TOTAL WEIGHT / etc.
    // values don't end up in the last product's chunk body.
    // The label ("TOTAL CBM") and its value ("70.125CBM") can appear on separate
    // lines in column-by-column PDFs, so stripping just the label line is not
    // enough — we must cut the entire summary block away before chunking.
    const summaryCutIdx = text.search(/\bTOTAL\s+(?:WEIGHT|CBM|CARTON|COST)\b/i)
    const textForChunking = summaryCutIdx !== -1 ? text.slice(0, summaryCutIdx) : text
    const cleanText = textForChunking
      .replace(/Customer\s+care\s+line:[^\n]*/gi, '')
      .replace(/Complaints?\s+Line:[^\n]*/gi, '')
      .replace(/Page:\s*\d+\/\d+/gi, '')
    const chunks = extractPackingTextBlocks(cleanText)
    const fallbackRows: Record<string, unknown>[] = []
    for (const chunk of chunks) {
      // skipKeywordCheck=true: MARKS validated by isLikelyMarksCell, GOODS LEFT already cut
      const result = parsePdfTableLineResult(chunk, true)
      if (result.ok) fallbackRows.push(result.row)
    }
    if (fallbackRows.length) {
      logImport('PDF fallback parsed rows:', fallbackRows.length, 'sample:', {
        MARKS: String(fallbackRows[0].MARKS ?? '').slice(0, 40),
        PACKING: fallbackRows[0].PACKING,
        'T.QTY': fallbackRows[0]['T.QTY'],
        'U.PRICE (RMB)': fallbackRows[0]['U.PRICE (RMB)'],
      })
      return fallbackRows
    }
    logImport('PDF fallback produced no data rows')
    return []
  }

  return rows
}

async function parsePdfImportMeta(file: File): Promise<ImportMeta> {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise
  const pages: string[] = []
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const content = await page.getTextContent()
    pages.push(content.items.map(item => ('str' in item ? String((item as { str?: string }).str ?? '') : '')).join('\n'))
  }
  return extractImportMetaFromText(pages.join('\n'), file.name, 'pdf')
}

async function parseExcelImportMeta(file: File): Promise<ImportMeta> {
  let text = ''
  if (isCsvFile(file)) {
    text = await file.text()
  } else {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const wb = XLSX.read(bytes, { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][]
    text = rows.flat().map(v => String(v ?? '')).join('\n')
  }
  return extractImportMetaFromText(text, file.name, 'excel_or_csv')
}

export async function parseImportFileDetailed(file: File): Promise<{ rows: Record<string, unknown>[]; importMeta: ImportMeta }> {
  const isPdf = isPdfFile(file)
  let rows = isPdf ? await parsePdfFile(file) : await parseExcelFile(file)
  const importMeta = isPdf ? await parsePdfImportMeta(file) : await parseExcelImportMeta(file)

  // OCR pipeline: for PDFs, prefer full-document Claude extraction as the primary source.
  // Legacy parser rows remain as a fallback when OCR/LLM is unavailable.
  const rowsHaveNulls = rows.length > 0 && rows.some(r => {
    const packing = String(r['PACKING'] ?? '')
    return (!packing || !/\//.test(packing)) || !r['T.QTY'] || !r['U.PRICE (RMB)']
  })
  if (isPdf) {
    try {
      // Upload directly to Supabase Storage from the browser so large PDFs do not
      // pass through a serverless request body (prevents Vercel 413 errors).
      let res: Response
      const importPath = `imports/${Date.now()}-${file.name.replace(/[^\w.\-()]/g, '_')}`
      const { error: uploadErr } = await supabase.storage
        .from('documents')
        .upload(importPath, file, {
          upsert: true,
          contentType: file.type || 'application/pdf',
        })

      if (!uploadErr) {
        const { data: pub } = supabase.storage.from('documents').getPublicUrl(importPath)
        const blobUrl = pub.publicUrl
        res = await fetch('/api/ocr-extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blob_url: blobUrl, file_name: file.name, skip_insert: true }),
        })
      } else {
        // Fallback: direct upload only for small files.
        // Large files should fail fast with a clear message instead of hitting Vercel 413.
        const fourMb = 4.0 * 1024 * 1024
        if (file.size > fourMb) {
          throw new Error(
            `PDF is too large for direct upload fallback (${Math.round(file.size / (1024 * 1024))}MB). ` +
            `Storage upload failed: ${uploadErr.message}`
          )
        }
        const fd = new FormData()
        fd.append('file', file)
        fd.append('skip_insert', 'true')
        res = await fetch('/api/ocr-extract', { method: 'POST', body: fd })
      }
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        logImport(`OCR route failed: HTTP ${res.status}`, errBody?.error ?? errBody)
      }
      if (res.ok) {
        const data = await res.json()
        const ocrLines: string[] = Array.isArray(data?.lines) ? data.lines : []
        const ocrProducts = Array.isArray(data?.products) ? (data.products as Record<string, unknown>[]) : []

        // Merge Claude's extracted footer totals and doc metadata into importMeta.
        // extractImportMetaFromText only handles English container manifest labels; sales orders
        // use a Chinese format ("TOTAL： 1587 36839…") that the regex misses entirely.
        const claudeDoc = data?.document as Record<string, any> | null | undefined
        if (claudeDoc) {
          const ft = claudeDoc.footer_totals as Record<string, number | null> | null | undefined
          if (ft) {
            if (ft.total_cartons != null) importMeta.total_carton = ft.total_cartons
            if (ft.total_cbm != null) importMeta.total_cbm = ft.total_cbm
            if (ft.total_weight_kg != null) importMeta.total_weight_kgs = ft.total_weight_kg
            if (ft.total_amount_rmb != null) importMeta.total_cost_rmb = ft.total_amount_rmb
          }
          if (!importMeta.client_details && claudeDoc.client_id) importMeta.client_details = String(claudeDoc.client_id)
          if (!importMeta.container_no && claudeDoc.container_no) importMeta.container_no = String(claudeDoc.container_no)
        }
        if (data?.doc_type && !importMeta.document_type) {
          importMeta.document_type = data.doc_type as 'sales_order' | 'container_manifest'
        }

        if (ocrProducts.length > 0) {
          rows = ocrProducts.filter(p => ((p.section as string) ?? 'shipped') === 'shipped').map(p => ({
            MARKS: String(p.marks ?? p.item_code ?? ''),
            'SHOP#': String(p.shop ?? ''),
            'ITEM NO.': String(p.line_no ?? ''),
            'DESCRIPTION OF GOODS': String(p.description ?? ''),
            PACKING: String(p.packaging ?? ''),
            'T.CTN': p.total_cartons != null ? `${String(p.total_cartons)}CTNS` : '',
            'T.QTY': p.total_qty != null ? `${String(p.total_qty)}pcs` : '',
            'UNIT CBM': p.unit_cbm != null ? `${String(p.unit_cbm)}CBM` : '',
            'T.CBM': p.total_cbm != null ? `${String(p.total_cbm)}CBM` : '',
            'UNIT WEIGHT': p.unit_weight_kg != null ? `${String(p.unit_weight_kg)}KGS` : '',
            'T.WEIGHT': p.total_weight_kg != null ? `${String(p.total_weight_kg)}KGS` : '',
            'U.PRICE (RMB)': p.unit_price_rmb != null ? `¥${String(p.unit_price_rmb)}` : '',
            'T.AMOUNT': p.total_amount_rmb != null ? `¥${String(p.total_amount_rmb)}` : '',
            __source: 'claude_core',
            __needs_llm: 'false',
          }))
          logImport('OCR primary rows:', rows.length)
        } else if (ocrLines.length > 0 && rowsHaveNulls) {
          // Attach OCR text to each row so LLM alignment can use it to fill nulls
          rows = rows.map(r => ({ ...r, __ocr_lines: ocrLines.join('\n') }))
          logImport('OCR lines attached to', rows.length, 'rows for LLM enrichment')
        }
      }
    } catch (err) {
      logImport('OCR failed:', err)
    }
  }
  logImport('parseImportFile done:', file.name, '→', rows.length, 'rows')
  logImport('import meta:', importMeta)
  return { rows, importMeta }
}

/** Accept .xlsx/.xls/.csv or .pdf; images are handled separately as product thumbnails */
export async function parseImportFile(file: File): Promise<Record<string, unknown>[]> {
  const { rows } = await parseImportFileDetailed(file)
  return rows
}

/**
 * Upload a PDF to Supabase Storage, queue a background extraction job, and
 * fire the processing endpoint (fire-and-forget). Returns the job_id immediately
 * so the caller can subscribe to Supabase Realtime for progress updates.
 *
 * Flow:
 *   browser → Supabase Storage (no serverless body limit)
 *   → insert public.import_jobs directly via Supabase client
 *   → invoke Supabase Edge Function process-import (fire-and-forget)
 *   → Supabase Realtime pushes progress to subscribers
 */
export async function startPdfImportJob(file: File): Promise<string> {
  const fileBuffer = await file.arrayBuffer()
  const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer)
  const fileHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')
  const idempotencyKey = `pdf:${fileHash}`

  // 1. Upload to Supabase Storage
  const importPath = `imports/${Date.now()}-${file.name.replace(/[^\w.\-()]/g, '_')}`
  logImport('uploading to storage:', importPath)

  const { error: uploadErr } = await supabase.storage
    .from('documents')
    .upload(importPath, file, { upsert: true, contentType: file.type || 'application/pdf' })

  if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`)

  const { data: pub } = supabase.storage.from('documents').getPublicUrl(importPath)
  const fileUrl = pub.publicUrl
  logImport('upload done, url:', fileUrl)

  // 2. Create job record directly in Supabase → returns job_id instantly
  const { data: existing } = await supabase
    .from('import_jobs')
    .select('id,status')
    .eq('idempotency_key', idempotencyKey)
    .in('status', ['queued', 'processing', 'retryable', 'completed', 'failed'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  let job_id: string
  if (existing?.id) {
    job_id = existing.id
    // Reset failed jobs so they can be re-processed
    if (existing.status === 'failed') {
      await supabase
        .from('import_jobs')
        .update({ status: 'queued', step: 'queued', progress_pct: 0, error: null, retry_at: null, attempt_count: 0, file_url: fileUrl })
        .eq('id', job_id)
    }
  } else {
    const { data: inserted, error: queueErr } = await supabase
      .from('import_jobs')
      .insert({
        file_url: fileUrl,
        file_name: file.name,
        idempotency_key: idempotencyKey,
        attempt_count: 0,
        retry_at: null,
        skip_db_insert: false,
        status: 'queued',
        step: 'queued',
        progress_pct: 0,
      })
      .select('id')
      .single()
    if (queueErr || !inserted?.id) {
      throw new Error(`Queue failed: ${queueErr?.message ?? 'missing job id'}`)
    }
    job_id = inserted.id
  }
  logImport('job queued:', job_id)

  // 3. Fire the Next.js API route (maxDuration=300) instead of the Supabase Edge Function
  //    (edge functions have a 150s wall-clock limit that kills the process before cleanup runs).
  //    Fire-and-forget: browser tracks progress via Supabase Realtime, not this response.
  fetch('/api/process-import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id }),
  }).catch(err => logImport('process-import fire-and-forget error:', err?.message ?? err))

  return job_id
}
