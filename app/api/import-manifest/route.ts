import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { parseCsvRows } from '@/lib/csv-parse'
import {
  detectDocTypeFromFilename,
  filenameSuggestsContainerManifest,
  isContainerManifestSpreadsheetPreview,
} from '@/lib/prompts'

export const runtime = 'nodejs'
export const maxDuration = 300

const DEFAULT_SALES_IMPORT_BASE = 'https://test1-production-50f5.up.railway.app'

function manifestUpstreamUrl(): string {
  const explicit = process.env.MANIFEST_IMPORT_URL?.trim()
  if (explicit) return explicit
  const sales = process.env.SALES_ORDER_IMPORT_URL?.trim() || `${DEFAULT_SALES_IMPORT_BASE}/import`
  try {
    const u = new URL(sales)
    u.pathname = '/import/manifest'
    return u.toString()
  } catch {
    return `${DEFAULT_SALES_IMPORT_BASE}/import/manifest`
  }
}

/** First-sheet preview lines for classify-only (same shape as import-sales-excel). */
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

function previewLinesForManifestProbe(buffer: Buffer, lowerFileName: string): string[] {
  if (lowerFileName.endsWith('.csv')) return csvPreviewLines(buffer)
  return sheetPreviewLines(buffer)
}

function isManifestSpreadsheetCandidate(fileName: string, previewLines: string[]): boolean {
  if (detectDocTypeFromFilename(fileName) === 'sales_order') return false
  if (isContainerManifestSpreadsheetPreview(previewLines)) return true
  if (filenameSuggestsContainerManifest(fileName)) {
    const blob = previewLines.slice(0, 40).join(' ')
    return /\bMARKS\b|唛头/.test(blob)
  }
  return false
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

  const fileName = file.name || 'upload.csv'
  const lower = fileName.toLowerCase()
  if (!lower.endsWith('.csv') && !lower.endsWith('.xlsx') && !lower.endsWith('.xls') && !lower.endsWith('.xlsm')) {
    return NextResponse.json(
      { error: 'Container manifest import accepts .csv, .xlsx, .xls, or .xlsm only', code: 'BAD_SUFFIX' },
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
    previewLines = previewLinesForManifestProbe(buffer, lower)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: `Could not read file: ${msg}` }, { status: 422 })
  }

  if (!isManifestSpreadsheetCandidate(fileName, previewLines)) {
    return NextResponse.json(
      {
        error:
          'This file does not look like a container manifest (expected MARKS / T.CTN / T.QTY columns, or MS-* style export).',
        code: 'NOT_CONTAINER_MANIFEST',
      },
      { status: 400 }
    )
  }

  const targetUrl = manifestUpstreamUrl()

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
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: `Import service unreachable: ${msg}` }, { status: 502 })
  }

  const ct = upstream.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    const body = await upstream.json().catch(() => null)
    if (!upstream.ok) {
      const msg =
        (body &&
          typeof body === 'object' &&
          'detail' in body &&
          String((body as { detail?: unknown }).detail)) ||
        (body &&
          typeof body === 'object' &&
          'error' in body &&
          String((body as { error?: unknown }).error)) ||
        `Import service returned HTTP ${upstream.status}`
      return NextResponse.json(body ?? { error: msg }, { status: upstream.status })
    }
    if (body && typeof body === 'object' && 'document_id' in body && 'items_inserted' in body) {
      const b = body as { document_id?: string; items_inserted?: number }
      return NextResponse.json({
        success: true,
        message: `Imported ${b.items_inserted ?? 0} manifest rows (document: ${b.document_id})`,
        document_id: b.document_id,
        items_inserted: b.items_inserted,
      })
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
