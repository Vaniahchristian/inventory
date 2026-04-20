'use client'

import * as XLSX from 'xlsx'
import type { Product, StockMovement } from './types'
import { parseCsvRows } from './csv-parse'
import { formatDateTime } from './utils'

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

export function exportProductsToExcel(products: Product[]) {
  const rows = products.map(p => ({
    'MARKS / SKU': p.sku ?? '',
    Name: p.name ?? '',
    'SHOP#': p.shop_name ?? '',
    Description: p.description ?? '',
    Category: p.categories?.name ?? '',
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
    { wch: 16 }, { wch: 28 }, { wch: 14 }, { wch: 30 }, { wch: 16 }, { wch: 16 },
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
  import('jspdf').then(async ({ default: jsPDF }) => {
    const { default: autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF({ orientation: 'landscape', format: 'a3' })
    doc.setFontSize(13)
    doc.text('Product Inventory Report', 14, 14)
    doc.setFontSize(8)
    doc.text(`Generated: ${new Date().toLocaleString()}  |  ${products.length} items`, 14, 20)

    const totalCbm = products.reduce((s, p) => s + (p.cbm ?? 0), 0)
    const totalWeight = products.reduce((s, p) => s + parseFloat(String(p.total_weight ?? '0').replace(/[^\d.]/g, '') || '0'), 0)
    const totalCartons = products.reduce((s, p) => s + (p.cartons ?? 0), 0)
    const totalAmount = products.reduce((s, p) => s + (p.total_amount_rmb ?? 0), 0)

    autoTable(doc, {
      startY: 25,
      head: [[
        'MARKS / SKU', 'Name', 'Description', 'SHOP#', 'Packing',
        'CTN', 'Qty', 'CBM', 'U.Wt', 'T.Wt',
        'Unit Price ¥', 'T.Amount ¥',
      ]],
      body: [
        ...products.map(p => [
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
        ]),
        // Totals row
        [
          { content: 'TOTALS', styles: { fontStyle: 'bold' } },
          '', '', '',
          '',
          { content: String(totalCartons || '-'), styles: { fontStyle: 'bold' } },
          '',
          { content: totalCbm > 0 ? totalCbm.toFixed(3) : '-', styles: { fontStyle: 'bold' } },
          '',
          { content: totalWeight > 0 ? `${totalWeight.toFixed(1)} KGS` : '-', styles: { fontStyle: 'bold' } },
          '',
          { content: totalAmount > 0 ? `¥${totalAmount.toLocaleString()}` : '-', styles: { fontStyle: 'bold' } },
        ],
      ],
      styles: { fontSize: 7, cellPadding: 1.5, overflow: 'linebreak' },
      headStyles: { fillColor: [30, 41, 59], fontSize: 7, cellPadding: 2 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: {
        0: { cellWidth: 22 },   // SKU
        1: { cellWidth: 38 },   // Name
        2: { cellWidth: 38 },   // Description
        3: { cellWidth: 20 },   // Shop
        4: { cellWidth: 18 },   // Packing
        5: { cellWidth: 10 },   // CTN
        6: { cellWidth: 14 },   // Qty
        7: { cellWidth: 14 },   // CBM
        8: { cellWidth: 14 },   // U.Wt
        9: { cellWidth: 16 },   // T.Wt
        10: { cellWidth: 18 },  // Unit Price
        11: { cellWidth: 20 },  // T.Amount
      },
      didParseCell: (data) => {
        // Bold totals row
        if (data.row.index === products.length) {
          data.cell.styles.fillColor = [226, 232, 240]
        }
      },
    })
    doc.save(`products_${Date.now()}.pdf`)
  })
}

export function exportMovementsToPdf(movements: StockMovement[]) {
  import('jspdf').then(async ({ default: jsPDF }) => {
    const { default: autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF({ orientation: 'landscape' })
    doc.setFontSize(14)
    doc.text('Stock Movements Report', 14, 15)
    doc.setFontSize(9)
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 22)
    autoTable(doc, {
      startY: 27,
      head: [['Date', 'Product', 'SKU', 'Type', 'Qty', 'Unit', 'Reference', 'Notes']],
      body: movements.map(m => [
        formatDateTime(m.created_at),
        m.products?.name ?? '-',
        m.products?.sku ?? '-',
        m.movement_type,
        m.quantity,
        m.products?.unit ?? '-',
        m.reference ?? '-',
        m.notes ?? '-',
      ]),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [30, 41, 59] },
      alternateRowStyles: { fillColor: [248, 250, 252] },
    })
    doc.save(`stock_movements_${Date.now()}.pdf`)
  })
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
    const body = (m[2] ?? '').trim()
    if (!isLikelyMarksCell(marks)) continue
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

function parsePdfTableLineResult(joined: string): PdfLineResult {
  const line = joined.replace(/\s+/g, ' ').trim()
  if (!line) return { ok: false, skip: 'empty line' }
  if (shouldSkipPdfLine(line)) return { ok: false, skip: 'skipped (header/footer keyword)' }
  if (!/\bSANCARGO\b/i.test(line)) return { ok: false, skip: 'no SANCARGO anchor' }

  const marks = extractMarksFromPdfLine(line)
  if (!marks) return { ok: false, skip: 'no MARKS token' }
  const marksDisplay = /\bSANCARGO\b/i.test(line) ? `${marks}\nSANCARGO` : marks

  const packingM = line.match(/(\d+\s*(?:pcs|PCS|sets?|SETs?)\/ctn)/i)
  if (!packingM)
    return { ok: false, skip: 'no PACKING token (need e.g. 15pcs/ctn)', preview: line.slice(0, 120) }

  const packing = packingM[1].replace(/\s+/g, '')

  const tCtnM = line.match(/(\d+)\s*CTNS/i)
  const cartonsStr = tCtnM ? `${tCtnM[1]}CTNS` : ''

  const afterCtn = line.match(/\d+\s*CTNS\s+(\d+)\s*pcs/i)
  const qtyStr = afterCtn
    ? `${afterCtn[1]}pcs`
    : (line.match(/(\d+)\s*pcs(?!\/)/i)?.[1] ?? '')

  const cbmMatches = [...line.matchAll(/([\d.]+)\s*CBM/gi)]
  const unitCbmStr = cbmMatches[0] ? `${cbmMatches[0][1]}CBM` : ''
  const cbmStr = cbmMatches[1] ? `${cbmMatches[1][1]}CBM` : unitCbmStr

  const kgsMatches = [...line.matchAll(/([\d.]+)\s*KGS/gi)]
  const unitWt = kgsMatches[0] ? `${kgsMatches[0][1]}KGS` : ''
  const totalWt = kgsMatches[1] ? `${kgsMatches[1][1]}KGS` : kgsMatches[0] ? `${kgsMatches[0][1]}KGS` : ''

  const yenMatches = [...line.matchAll(/[¥￥]\s*([\d,]+(?:\.\d+)?)/g)]
  const unitPriceStr = yenMatches[0] ? `¥${yenMatches[0][1]}` : ''
  const totalAmtStr = yenMatches[1] ? `¥${yenMatches[1][1]}` : ''

  // Shop: between SANCARGO and PACKING (strip trailing item index like "… 12")
  let shop = ''
  const shopPack = line.match(/\bSANCARGO\s+(.+?)\s+(\d+\s*\w+\/ctn)/i)
  if (shopPack) {
    shop = shopPack[1]
      .replace(/\s+\d+\s*$/, '')
      .trim()
  }

  // Description: between item index and PACKING (English + Chinese blob)
  let descMain = ''
  let descDetail = ''
  const itemAndDesc = line.match(
    /\bSANCARGO\s+\S+\s+(\d+)\s+(.+?)\s+\d+\s*(?:pcs|PCS|sets?|SETs?)\/ctn/i
  )
  if (itemAndDesc) {
    const blob = itemAndDesc[2].trim()
    const parts = blob.split(/\s+(?=[\u4e00-\u9fff])/)
    if (parts.length >= 2) {
      descMain = parts[0]
      descDetail = parts.slice(1).join(' ')
    } else {
      const cut = blob.search(/[\u4e00-\u9fff]/)
      if (cut > 0) {
        descMain = blob.slice(0, cut).trim()
        descDetail = blob.slice(cut).trim()
      } else descMain = blob
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
    const result = parsePdfTableLineResult(chunk)
    if (result.ok) rows.push(result.row)
  }
  return rows
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

    // Merge "MARKS-only" line with following "SANCARGO-only" baseline (two-line MARKS cell)
    const merged: string[] = []
    for (let i = 0; i < rawLines.length; i++) {
      const cur = rawLines[i]
      const next = rawLines[i + 1]
      if (
        isLikelyMarksCell(cur) &&
        next &&
        /^\s*SANCARGO\s*$/i.test(next) &&
        !/\bSANCARGO\b/i.test(cur)
      ) {
        merged.push(`${cur} ${next}`)
        i++
      } else merged.push(cur)
    }

    let pageParsed = 0
    let pageSkipped = 0
    for (const line of merged) {
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
    logImport(`PDF page ${pageNum}/${pdf.numPages}: merged lines=${merged.length}, parsed=${pageParsed}, skipped=${pageSkipped}`)
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

  if (rows.length === 0) {
    // Fallback parser for PDFs whose glyph coordinates are too fragmented for Y-bucketing.
    const text = pageTextBlobs.join('\n')
    const chunks = extractPackingTextBlocks(text)
    const fallbackRows: Record<string, unknown>[] = []
    for (const chunk of chunks) {
      const result = parsePdfTableLineResult(chunk)
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
  }

  return rows
}

/** Accept .xlsx/.xls/.csv or .pdf; images are handled separately as product thumbnails */
export async function parseImportFile(file: File): Promise<Record<string, unknown>[]> {
  const rows = isPdfFile(file)
    ? await parsePdfFile(file)
    : await parseExcelFile(file)
  logImport('parseImportFile done:', file.name, '→', rows.length, 'rows')
  return rows
}
