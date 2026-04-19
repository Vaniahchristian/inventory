'use client'

import * as XLSX from 'xlsx'
import type { Product, StockMovement } from './types'
import { formatDateTime } from './utils'

export function exportProductsToExcel(products: Product[]) {
  const rows = products.map(p => ({
    SKU: p.sku ?? '',
    Name: p.name ?? '',
    Category: p.categories?.name ?? '',
    Supplier: p.suppliers?.name ?? '',
    Unit: p.unit,
    'Cost Price': p.cost_price,
    'Selling Price': p.selling_price,
    Quantity: p.quantity,
    'Reorder Level': p.reorder_level,
    Description: p.description ?? '',
  }))
  const ws = XLSX.utils.json_to_sheet(rows)
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
    const doc = new jsPDF({ orientation: 'landscape' })
    doc.setFontSize(14)
    doc.text('Product Inventory Report', 14, 15)
    doc.setFontSize(9)
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 22)
    autoTable(doc, {
      startY: 27,
      head: [['SKU', 'Name', 'Category', 'Unit', 'Cost', 'Selling', 'Qty', 'Reorder']],
      body: products.map(p => [
        p.sku ?? '-',
        p.name ?? '-',
        p.categories?.name ?? '-',
        p.unit,
        p.cost_price,
        p.selling_price,
        p.quantity,
        p.reorder_level,
      ]),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [30, 41, 59] },
      alternateRowStyles: { fillColor: [248, 250, 252] },
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
  const buffer = await file.arrayBuffer()
  const wb = XLSX.read(buffer)
  const ws = wb.Sheets[wb.SheetNames[0]]
  return XLSX.utils.sheet_to_json(ws)
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
