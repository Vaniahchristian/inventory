import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { parseCsvRows } from '@/lib/csv-parse'
import { detectDocType, detectDocTypeFromFilename } from '@/lib/prompts'

export const runtime = 'nodejs'
export const maxDuration = 300

const DEFAULT_SALES_IMPORT_URL = 'https://test1-production-50f5.up.railway.app/import'

/** First-sheet preview lines for classify-only (delivery note headers often span many columns). */
function sheetPreviewLines(buffer: Buffer, maxRows = 50): string[] {
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const name = wb.SheetNames[0]
  if (!name) return []
  const sheet = wb.Sheets[name]
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as unknown[][]
  const lines: string[] = []
  for (let i = 0; i < Math.min(rows.length, maxRows); i++) {
    const r = rows[i]
    if (!Array.isArray(r)) continue
    const s = r.map(c => String(c ?? '').trim()).filter(Boolean).join(' ')
    if (s) lines.push(s)
  }
  return lines
}

/** First rows of a CSV as single-line strings (same shape as `sheetPreviewLines` for `detectDocType`). */
function csvPreviewLines(buffer: Buffer, maxRows = 50): string[] {
  const text = buffer.toString('utf8')
  const rows = parseCsvRows(text)
  const lines: string[] = []
  for (let i = 0; i < Math.min(rows.length, maxRows); i++) {
    const r = rows[i]
    if (!Array.isArray(r)) continue
    const s = r.map(c => String(c ?? '').trim()).filter(Boolean).join(' ')
    if (s) lines.push(s)
  }
  return lines
}

function previewLinesForSalesImport(buffer: Buffer, lowerFileName: string): string[] {
  if (lowerFileName.endsWith('.csv')) return csvPreviewLines(buffer)
  return sheetPreviewLines(buffer)
}

function isSalesSpreadsheetCandidate(fileName: string, previewLines: string[]): boolean {
  if (detectDocTypeFromFilename(fileName) === 'sales_order') return true
  if (previewLines.length === 0) return false
  return detectDocType(previewLines) === 'sales_order'
}

export async function POST(req: Request) {
  const contentType = req.headers.get('content-type') ?? ''
  if (!contentType.includes('multipart/form-data')) {
    return NextResponse.json({ error: 'Expected multipart form data' }, { status: 400 })
  }

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Failed to parse form data' }, { status: 400 })
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file' }, { status: 400 })
  }

  const fileName = file.name || 'upload.xlsx'
  const lower = fileName.toLowerCase()
  if (!lower.endsWith('.xlsx') && !lower.endsWith('.xls') && !lower.endsWith('.csv')) {
    return NextResponse.json(
      { error: 'Sales import accepts .xlsx, .xls, or .csv only' },
      { status: 400 }
    )
  }

  let buffer: Buffer
  try {
    buffer = Buffer.from(await file.arrayBuffer())
  } catch {
    return NextResponse.json({ error: 'Failed to read file' }, { status: 400 })
  }

  let previewLines: string[] = []
  try {
    previewLines = previewLinesForSalesImport(buffer, lower)
  } catch (e: any) {
    return NextResponse.json(
      { error: `Could not read file: ${e?.message ?? String(e)}` },
      { status: 422 }
    )
  }

  if (!isSalesSpreadsheetCandidate(fileName, previewLines)) {
    return NextResponse.json(
      {
        error:
          'This file does not look like a sales / delivery-note file (CSV or spreadsheet / 送货单). ' +
          'Rename it to include e.g. 送货单 / 销售单 / sales-order, or use the expected column layout.',
      },
      { status: 400 }
    )
  }

  const targetUrl =
    process.env.SALES_ORDER_IMPORT_URL?.trim() || DEFAULT_SALES_IMPORT_URL

  const outbound = new FormData()
  const mime = lower.endsWith('.csv')
    ? 'text/csv; charset=utf-8'
    : lower.endsWith('.xls')
      ? 'application/vnd.ms-excel'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  outbound.append('file', new Blob([new Uint8Array(buffer)], { type: mime }), fileName)

  let upstream: Response
  try {
    upstream = await fetch(targetUrl, { method: 'POST', body: outbound })
  } catch (e: any) {
    return NextResponse.json(
      { error: `Import service unreachable: ${e?.message ?? String(e)}` },
      { status: 502 }
    )
  }

  const ct = upstream.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    const body = await upstream.json().catch(() => null)
    if (!upstream.ok) {
      const msg =
        (body && typeof body === 'object' && 'error' in body && String((body as { error?: unknown }).error)) ||
        `Import service returned HTTP ${upstream.status}`
      return NextResponse.json(body ?? { error: msg }, { status: upstream.status })
    }
    return NextResponse.json(body)
  }

  const text = await upstream.text().catch(() => '')
  if (!upstream.ok) {
    return NextResponse.json(
      { error: text || `Import service returned HTTP ${upstream.status}` },
      { status: upstream.status }
    )
  }

  return NextResponse.json(
    {
      success: true,
      message: 'Import service returned a non-JSON response',
      raw_preview: text.slice(0, 500),
    },
    { status: 200 }
  )
}
