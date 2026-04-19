'use client'

import * as XLSX from 'xlsx'
import type { Product, StockMovement } from './types'
import { formatDateTime } from './utils'

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
  let wb: XLSX.WorkBook
  if (file.name.toLowerCase().endsWith('.csv')) {
    // Use browser's native UTF-8 decoding for CSV so ¥ and CJK chars survive
    const text = await file.text()
    wb = XLSX.read(text, { type: 'string' })
  } else {
    const bytes = new Uint8Array(await file.arrayBuffer())
    wb = XLSX.read(bytes, { type: 'array' })
  }
  const ws = wb.Sheets[wb.SheetNames[0]]

  // Read everything as raw rows first
  const allRows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  // Find the header row: the row where the first non-empty cell is "MARKS"
  // (packing list format) or where we see standard inventory column names
  const headerIdx = allRows.findIndex(row => {
    const first = String(row[0] ?? '').trim().toUpperCase()
    if (first === 'MARKS') return true
    // Standard exported format
    const cols = row.map(c => String(c ?? '').trim().toLowerCase())
    return cols.includes('sku') || cols.includes('name')
  })

  if (headerIdx === -1) {
    // Fallback: let xlsx auto-detect (original behaviour)
    return XLSX.utils.sheet_to_json(ws, { defval: '' })
  }

  const rawHeaders = (allRows[headerIdx] as unknown[]).map(h =>
    String(h ?? '').trim().replace(/\n/g, ' ')
  )
  // Give unnamed columns a stable placeholder so their data isn't lost
  const headers = rawHeaders.map((h, i) => h || `__col${i}`)

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

  return result
}

/** Parse a packing-list PDF exported from the container manifest format.
 *  Columns: MARKS | SHOP# | ITEM NO. | DESCRIPTION OF GOODS | Col5 | Col6 | PACKING | T.CTN | T.QTY | T.CBM | UNIT WEIGHT | T.WEIGHT | U.PRICE (RMB) | T.AMOUNT
 */
export async function parsePdfFile(file: File): Promise<Record<string, unknown>[]> {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise
  const rows: Record<string, unknown>[] = []

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const content = await page.getTextContent()

    // Group text items by approximate Y position to reconstruct rows
    const lineMap = new Map<number, { x: number; text: string }[]>()
    for (const item of content.items) {
      if (!('str' in item)) continue
      const y = Math.round((item as any).transform[5])
      if (!lineMap.has(y)) lineMap.set(y, [])
      lineMap.get(y)!.push({ x: (item as any).transform[4], text: (item as any).str })
    }

    const sortedYs = Array.from(lineMap.keys()).sort((a, b) => b - a)
    for (const y of sortedYs) {
      const cells = lineMap.get(y)!.sort((a, b) => a.x - b.x)
      const texts = cells.map(c => c.text.trim()).filter(Boolean)
      if (texts.length < 4) continue

      // Skip header rows
      const joined = texts.join(' ')
      if (joined.includes('MARKS') || joined.includes('DESCRIPTION OF GOODS') || joined.includes('Customer care')) continue

      // Try to parse MARKS column (looks like MS-T-201-1)
      const marksMatch = texts[0].match(/MS-[A-Z0-9-]+/)
      if (!marksMatch) continue

      const sku = marksMatch[0]
      const description = texts[3] ?? ''
      const name = texts[5] || texts[4] || description
      const packing = texts[6] ?? ''
      const qty = parseFloat(texts[8]?.replace(/[^\d.]/g, '') ?? '0') || 0
      const priceStr = texts[12] ?? ''
      const cost_price = parseFloat(priceStr.replace(/[¥,]/g, '')) || 0
      const unit = packing.match(/(\d+)(\w+)\/ctn/)?.[2] ?? 'pcs'

      rows.push({ sku, name, description, quantity: qty, cost_price, unit })
    }
  }

  return rows
}

/** Accept .xlsx/.xls/.csv or .pdf; images are handled separately as product thumbnails */
export async function parseImportFile(file: File): Promise<Record<string, unknown>[]> {
  if (file.name.endsWith('.pdf')) return parsePdfFile(file)
  return parseExcelFile(file)
}
