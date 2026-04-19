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

export async function parseExcelFile(file: File): Promise<Record<string, unknown>[]> {
  let allRows: unknown[][]
  /** Only set for binary .xlsx/.xls — used if header detection fails */
  let wsFallback: XLSX.WorkSheet | undefined

  if (file.name.toLowerCase().endsWith('.csv')) {
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
    const sheetRef = wsFallback?.['!ref'] ?? 'unknown'
    throw new Error(
      `This Excel workbook only stores two columns (${sheetRef}). Columns like PACKING, T.QTY, and prices are missing from the file itself — often caused by exporting or saving only part of the sheet. Import the full .csv packing list instead, or re-export the spreadsheet so all columns (through T.AMOUNT) are saved in Excel.`
    )
  }

  const result: Record<string, unknown>[] = []
  for (let i = headerIdx + 1; i < allRows.length; i++) {
    const row = allRows[i] as unknown[]
    // Skip completely empty rows
    const nonEmpty = row.filter(c => String(c ?? '').trim())
    if (nonEmpty.length === 0) continue
    // Skip section-header rows like "NEW ORDER" (single non-MARKS cell in col 0)
    if (nonEmpty.length === 1 && !String(row[0] ?? '').match(/^[A-Z]{2,3}-/)) continue

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

/** SKU pattern used on SANCARGO packing lists */
const MARKS_SKU_RE = /\b(MS-[A-Z]-\d+(?:-\d+)*)\b/

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

  const skuMatch = line.match(MARKS_SKU_RE)
  if (!skuMatch) return { ok: false, skip: 'no MS-T-* SKU token' }

  const sku = skuMatch[1]
  const marksDisplay = /\bSANCARGO\b/i.test(line) ? `${sku}\nSANCARGO` : sku

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

  const cbmM = line.match(/([\d.]+)\s*CBM/i)
  const cbmStr = cbmM ? `${cbmM[1]}CBM` : ''

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
      'T.CBM': cbmStr,
      'UNIT WEIGHT': unitWt,
      'T.WEIGHT': totalWt,
      'U.PRICE (RMB)': unitPriceStr,
      'T.AMOUNT': totalAmtStr,
    },
  }
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

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const content = await page.getTextContent()

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

    // Merge "MS-T-*" line with following "SANCARGO-only" baseline (two-line MARKS cell)
    const merged: string[] = []
    for (let i = 0; i < rawLines.length; i++) {
      const cur = rawLines[i]
      const next = rawLines[i + 1]
      if (
        MARKS_SKU_RE.test(cur) &&
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

  return rows
}

/** Accept .xlsx/.xls/.csv or .pdf; images are handled separately as product thumbnails */
export async function parseImportFile(file: File): Promise<Record<string, unknown>[]> {
  const rows = file.name.endsWith('.pdf')
    ? await parsePdfFile(file)
    : await parseExcelFile(file)
  logImport('parseImportFile done:', file.name, '→', rows.length, 'rows')
  return rows
}
