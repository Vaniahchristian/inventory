'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { MonitorPlay, Loader2, Save, FileUp, ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import type { ExtractedDocument, ExtractedProduct } from '@/lib/claude-extractor'
import { isFullExtractBanner, isSubtotalBanner, isFooterBanner } from '@/lib/full-extract'
import { extractPdfText } from '@/lib/pdf-text-extractor'
import { saveLiveViewExtraction } from '@/app/actions/live-view'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type ExtractSuccess = {
  success: true
  extraction_method: string
  rows_extracted: number
  rows_pass: number
  rows_flagged: number
  totals_match: boolean
  totals_diff: Record<string, number>
  validation_flags: string[]
  products: ExtractedProduct[]
  document: ExtractedDocument
  metrics?: { duration_ms?: number }
  full_extract?: boolean
}

const EXTRACT_REQUEST_TIMEOUT_MS = Number(
  process.env.NEXT_PUBLIC_EXTRACT_REQUEST_TIMEOUT_MS ?? 15 * 60 * 1000
)

function parseOptionalNum(s: string): number | null {
  const t = s.trim().replace(/,/g, '')
  if (!t) return null
  const n = parseFloat(t.replace(/[¥￥]/g, ''))
  return isFinite(n) ? n : null
}

function sumGroup(rows: ExtractedProduct[]) {
  return {
    total_cartons: rows.reduce((s, r) => s + (r.total_cartons ?? 0), 0),
    total_qty: rows.reduce((s, r) => s + (r.total_qty ?? 0), 0),
    total_cbm: rows.reduce((s, r) => s + (r.total_cbm ?? 0), 0),
    total_weight_kg: rows.reduce((s, r) => s + (r.total_weight_kg ?? 0), 0),
    total_amount_rmb: rows.reduce((s, r) => s + (r.total_amount_rmb ?? 0), 0),
  }
}

export function LiveViewClient() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [documentState, setDocumentState] = useState<ExtractedDocument | null>(null)
  const [products, setProducts] = useState<ExtractedProduct[]>([])
  const [model, setModel] = useState('')
  const [totalsMatch, setTotalsMatch] = useState<boolean | null>(null)
  const [rowsFlagged, setRowsFlagged] = useState<number | null>(null)
  const [extractMs, setExtractMs] = useState<number | null>(null)
  const [validationFlags, setValidationFlags] = useState<string[]>([])
  const [extracting, setExtracting] = useState(false)
  const [extractStatus, setExtractStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [lastRaw, setLastRaw] = useState<string | null>(null)
  const [fullExtractMode, setFullExtractMode] = useState(false)

  const patchProduct = useCallback((index: number, patch: Partial<ExtractedProduct>) => {
    setProducts(prev =>
      prev.map((p, i) => (i === index ? { ...p, ...patch } : p))
    )
  }, [])

  const patchFooter = useCallback(
    (key: keyof ExtractedDocument['footer_totals'], raw: string) => {
      setDocumentState(prev => {
        if (!prev) return prev
        const n = parseOptionalNum(raw)
        return {
          ...prev,
          footer_totals: { ...prev.footer_totals, [key]: n },
        }
      })
    },
    []
  )

  const removeProduct = useCallback((index: number) => {
    setProducts(prev => prev.filter((_, i) => i !== index))
  }, [])

  const realRows = useMemo(
    () => products.filter(p => !isFullExtractBanner(p) && !isSubtotalBanner(p) && !isFooterBanner(p)),
    [products]
  )
  const grandTotals = useMemo(() => sumGroup(realRows), [realRows])
  const persistableCount = realRows.length

  async function handleExtract(file: File) {
    setExtracting(true)
    setExtractStatus('Preparing PDF text…')
    setLastRaw(null)
    try {
      const { text: fallbackText } = await extractPdfText(file)
      const formData = new FormData()
      formData.append('file', file, file.name)
      formData.append('file_name', file.name)
      formData.append('fallback_text', fallbackText)
      formData.append('skip_db_insert', 'true')
      formData.append('full_extract', 'true')

      setExtractStatus('Uploading and extracting (this can take several minutes for large PDFs)…')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), EXTRACT_REQUEST_TIMEOUT_MS)
      const res = await fetch('/api/extract', { method: 'POST', body: formData, signal: controller.signal })
      clearTimeout(timer)
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        throw new Error(data.error ?? `Extract failed (${res.status})`)
      }

      const ok = data as ExtractSuccess
      if (!ok.success || !Array.isArray(ok.products)) {
        throw new Error('Unexpected extract response')
      }

      setFileName(file.name)
      setDocumentState(ok.document)
      setProducts(ok.products.map(p => ({ ...p })))
      setModel(ok.extraction_method ?? 'unknown')
      setTotalsMatch(ok.totals_match ?? null)
      setRowsFlagged(ok.rows_flagged ?? null)
      setExtractMs(ok.metrics?.duration_ms ?? null)
      setValidationFlags(Array.isArray(ok.validation_flags) ? ok.validation_flags : [])
      setFullExtractMode(ok.full_extract ?? false)
      setLastRaw(JSON.stringify(data, null, 2))
      toast.success(`Extracted ${ok.products.length} row(s) — review and save when ready`)
    } catch (e: unknown) {
      let msg = e instanceof Error ? e.message : String(e)
      if (e instanceof Error && e.name === 'AbortError') {
        msg =
          'Extraction timed out while waiting for server response. The parser likely switched to schema extraction, which can run long. Please retry once; if it repeats, we can lower parse timeout or skip html phase for this file.'
      }
      toast.error(msg)
      setFileName(null)
      setDocumentState(null)
      setProducts([])
      setModel('')
      setFullExtractMode(false)
    } finally {
      setExtracting(false)
      setExtractStatus('')
    }
  }

  async function handleSave() {
    const persistable = products.filter(p => !isFullExtractBanner(p) && !isSubtotalBanner(p) && !isFooterBanner(p))
    if (!documentState || !fileName) {
      toast.error('Nothing to save — extract a PDF first')
      return
    }
    if (persistable.length === 0) {
      toast.error('No product rows to save — remove heading-only rows or edit lines into real items')
      return
    }
    setSaving(true)
    try {
      const result = await saveLiveViewExtraction({
        fileName,
        document: documentState,
        products: persistable,
        model: model || 'live_view',
      })
      toast.success(`Saved — document ${result.document_id}, ${result.items_inserted} line item(s)`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 flex items-center gap-2">
            <MonitorPlay className="h-6 w-6 text-slate-600" />
            Live View
          </h1>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            Full extract lists product rows plus headings like NEW ORDER and text between tables.
            Yellow section totals (CTNS/CBM/KGS/¥), repacked-container banners, and goods-left banners
            are skipped automatically. Edit or delete remaining rows, then save. Footer fields are PDF
            text only; no checksums here.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            disabled={extracting}
            onChange={e => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void handleExtract(f)
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={extracting}
            onClick={() => fileRef.current?.click()}
          >
            {extracting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
            <span className="ml-2">{extracting ? 'Extracting…' : 'Choose PDF'}</span>
          </Button>
          <Button
            type="button"
            disabled={saving || persistableCount === 0 || extracting}
            onClick={() => void handleSave()}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
            Save to database
          </Button>
        </div>
      </div>

      {extracting && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          {extractStatus || 'Extracting…'}
        </div>
      )}

      {fileName && (
        <div className="rounded-lg border bg-slate-50/80 px-4 py-3 text-sm flex flex-wrap gap-x-6 gap-y-1">
          <span>
            <span className="text-slate-500">File:</span>{' '}
            <span className="font-medium text-slate-800">{fileName}</span>
          </span>
          <span>
            <span className="text-slate-500">Method:</span>{' '}
            <span className="font-mono text-xs">{model || '—'}</span>
          </span>
          {extractMs != null && (
            <span>
              <span className="text-slate-500">Duration:</span> {extractMs}ms
            </span>
          )}
          {fullExtractMode && (
            <span className="text-slate-600">
              Mode: <span className="font-medium">full document</span>
            </span>
          )}
          {!fullExtractMode && totalsMatch !== null && (
            <span className={totalsMatch ? 'text-emerald-700' : 'text-amber-700'}>
              Totals match: {totalsMatch ? 'yes' : 'no'}
            </span>
          )}
          {!fullExtractMode && rowsFlagged !== null && (
            <span className="text-slate-700">Flagged rows: {rowsFlagged}</span>
          )}
        </div>
      )}

      {validationFlags.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span className="font-medium">Validation:</span> {validationFlags.join(' · ')}
        </div>
      )}

      {documentState && (
        <div className="space-y-3">
          <div className="rounded-lg border p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
            <Field label="Doc no." value={documentState.doc_number} />
            <Field label="Client" value={documentState.client_id} />
            <Field label="Container" value={documentState.container_no} />
            <Field label="Date" value={documentState.document_date} />
          </div>
          <div className="rounded-lg border p-4 bg-amber-50/50">
            <h3 className="text-sm font-semibold text-slate-800 mb-2">Document footer (from PDF text)</h3>
            <p className="text-xs text-slate-500 mb-3">
              Parsed from the full document; edit before save.{' '}
              {fullExtractMode
                ? 'This is the PDF footer text only — not cross-checked against line items here.'
                : 'Compare to the grand total row below.'}
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <FooterNum label="Total CTNS" value={documentState.footer_totals.total_cartons} onChange={v => patchFooter('total_cartons', v)} />
              <FooterNum label="Total CBM" value={documentState.footer_totals.total_cbm} onChange={v => patchFooter('total_cbm', v)} />
              <FooterNum label="Total weight kg" value={documentState.footer_totals.total_weight_kg} onChange={v => patchFooter('total_weight_kg', v)} />
              <FooterNum label="Total amount ¥" value={documentState.footer_totals.total_amount_rmb} onChange={v => patchFooter('total_amount_rmb', v)} />
            </div>
          </div>
        </div>
      )}

      {products.length > 0 && (
        <div className="rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse min-w-[1900px]">
              <thead>
                <tr className="bg-slate-100 text-left border-b">
                  <th className="p-2 font-medium w-8">#</th>
                  <th className="p-2 font-medium min-w-[120px]">Marks</th>
                  <th className="p-2 font-medium min-w-[80px]">Shop</th>
                  <th className="p-2 font-medium w-16">Item</th>
                  <th className="p-2 font-medium min-w-[160px]">Description</th>
                  <th className="p-2 font-medium min-w-[80px]">Packing</th>
                  <th className="p-2 font-medium w-14 text-right">CTN</th>
                  <th className="p-2 font-medium w-14 text-right">Qty</th>
                  <th className="p-2 font-medium w-12 text-right">L cm</th>
                  <th className="p-2 font-medium w-12 text-right">W cm</th>
                  <th className="p-2 font-medium w-12 text-right">H cm</th>
                  <th className="p-2 font-medium w-16 text-right">U.CBM</th>
                  <th className="p-2 font-medium w-16 text-right">T.CBM</th>
                  <th className="p-2 font-medium w-16 text-right">U.Wkg</th>
                  <th className="p-2 font-medium w-16 text-right">T.Wkg</th>
                  <th className="p-2 font-medium w-18 text-right">U.Price ¥</th>
                  <th className="p-2 font-medium w-20 text-right">Amount ¥</th>
                  <th className="p-2 font-medium w-16">Box No</th>
                  <th className="p-2 font-medium min-w-[90px]">Section</th>
                  <th className="p-2 font-medium w-8" aria-label="Remove row" />
                </tr>
              </thead>
              <tbody>
                {products.map((row, i) => (
                  <tr
                    key={`${row.line_no}-${i}`}
                    className={
                      isSubtotalBanner(row)
                        ? 'border-b border-yellow-400 bg-yellow-200 hover:bg-yellow-300 font-semibold'
                        : isFooterBanner(row)
                        ? 'border-b border-slate-300 bg-slate-100 hover:bg-slate-200 text-slate-500 italic'
                        : isFullExtractBanner(row)
                        ? 'border-b border-amber-200 bg-amber-50/90 hover:bg-amber-50'
                        : 'border-b border-slate-100 hover:bg-slate-50/80'
                    }
                  >
                    <td className="p-1 align-top text-slate-500">{row.line_no ?? i + 1}</td>
                    <td className="p-1 align-top">
                      <Textarea
                        className="min-h-[52px] text-xs resize-y"
                        value={row.marks ?? ''}
                        onChange={e => patchProduct(i, { marks: e.target.value.trim() || null })}
                      />
                    </td>
                    <td className="p-1 align-top">
                      <Input
                        className="text-xs h-8"
                        value={row.shop ?? ''}
                        onChange={e => patchProduct(i, { shop: e.target.value.trim() || null })}
                      />
                    </td>
                    <td className="p-1 align-top">
                      <Input
                        className="text-xs h-8"
                        value={row.item_code ?? ''}
                        onChange={e => patchProduct(i, { item_code: e.target.value.trim() || null })}
                      />
                    </td>
                    <td className="p-1 align-top">
                      <Textarea
                        className="min-h-[52px] text-xs resize-y"
                        value={row.description ?? ''}
                        onChange={e => patchProduct(i, { description: e.target.value.trim() || null })}
                      />
                    </td>
                    <td className="p-1 align-top">
                      <Input
                        className="text-xs h-8"
                        value={row.packaging ?? ''}
                        onChange={e => patchProduct(i, { packaging: e.target.value.trim() || null })}
                      />
                    </td>
                    <td className="p-1 align-top">
                      <Input
                        className="text-xs h-8 text-right"
                        inputMode="decimal"
                        value={row.total_cartons ?? ''}
                        onChange={e => patchProduct(i, { total_cartons: parseOptionalNum(e.target.value) })}
                      />
                    </td>
                    <td className="p-1 align-top">
                      <Input
                        className="text-xs h-8 text-right"
                        inputMode="decimal"
                        value={row.total_qty ?? ''}
                        onChange={e => patchProduct(i, { total_qty: parseOptionalNum(e.target.value) })}
                      />
                    </td>
                    <td className="p-1 align-top">
                      <Input
                        className="text-xs h-8 text-right"
                        inputMode="decimal"
                        value={row.dim_l_cm ?? ''}
                        onChange={e => patchProduct(i, { dim_l_cm: parseOptionalNum(e.target.value) })}
                      />
                    </td>
                    <td className="p-1 align-top">
                      <Input
                        className="text-xs h-8 text-right"
                        inputMode="decimal"
                        value={row.dim_w_cm ?? ''}
                        onChange={e => patchProduct(i, { dim_w_cm: parseOptionalNum(e.target.value) })}
                      />
                    </td>
                    <td className="p-1 align-top">
                      <Input
                        className="text-xs h-8 text-right"
                        inputMode="decimal"
                        value={row.dim_h_cm ?? ''}
                        onChange={e => patchProduct(i, { dim_h_cm: parseOptionalNum(e.target.value) })}
                      />
                    </td>
                    <td className="p-1 align-top">
                      <Input
                        className="text-xs h-8 text-right"
                        inputMode="decimal"
                        value={row.unit_cbm ?? ''}
                        onChange={e => patchProduct(i, { unit_cbm: parseOptionalNum(e.target.value) })}
                      />
                    </td>
                    <td className="p-1 align-top">
                      <Input
                        className="text-xs h-8 text-right"
                        inputMode="decimal"
                        value={row.total_cbm ?? ''}
                        onChange={e => patchProduct(i, { total_cbm: parseOptionalNum(e.target.value) })}
                      />
                    </td>
                    <td className="p-1 align-top">
                      <Input
                        className="text-xs h-8 text-right"
                        inputMode="decimal"
                        value={row.unit_weight_kg ?? ''}
                        onChange={e => patchProduct(i, { unit_weight_kg: parseOptionalNum(e.target.value) })}
                      />
                    </td>
                    <td className="p-1 align-top">
                      <Input
                        className="text-xs h-8 text-right"
                        inputMode="decimal"
                        value={row.total_weight_kg ?? ''}
                        onChange={e => patchProduct(i, { total_weight_kg: parseOptionalNum(e.target.value) })}
                      />
                    </td>
                    <td className="p-1 align-top">
                      <Input
                        className="text-xs h-8 text-right"
                        inputMode="decimal"
                        value={row.unit_price_rmb ?? ''}
                        onChange={e => patchProduct(i, { unit_price_rmb: parseOptionalNum(e.target.value) })}
                      />
                    </td>
                    <td className="p-1 align-top">
                      <Input
                        className="text-xs h-8 text-right"
                        inputMode="decimal"
                        value={row.total_amount_rmb ?? ''}
                        onChange={e => patchProduct(i, { total_amount_rmb: parseOptionalNum(e.target.value) })}
                      />
                    </td>
                    <td className="p-1 align-top">
                      <Input
                        className="text-xs h-8"
                        value={
                          row.box_no_start != null
                            ? row.box_no_end != null && row.box_no_end !== row.box_no_start
                              ? `${row.box_no_start}–${row.box_no_end}`
                              : String(row.box_no_start)
                            : ''
                        }
                        readOnly
                      />
                    </td>
                    <td className="p-1 align-top">
                      <Select
                        value={row.section ?? 'shipped'}
                        onValueChange={v => patchProduct(i, { section: v as ExtractedProduct['section'] })}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="shipped">shipped</SelectItem>
                          <SelectItem value="left_in_warehouse">left_in_warehouse</SelectItem>
                          <SelectItem value="repacked">repacked</SelectItem>
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="p-1 align-top">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-slate-400 hover:text-red-600"
                        title="Remove row"
                        onClick={() => removeProduct(i)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
                {!fullExtractMode && (
                  <tr className="bg-emerald-50 border-t-2 border-emerald-300 text-xs font-semibold">
                    <td className="p-2" colSpan={6}>Grand total (sum of all rows)</td>
                    <td className="p-2 text-right tabular-nums">{fmtNum(grandTotals.total_cartons)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtNum(grandTotals.total_qty)}</td>
                    <td className="p-2 text-slate-400 text-center" colSpan={3}>—</td>
                    <td className="p-2 text-slate-400 text-right">—</td>
                    <td className="p-2 text-right tabular-nums">{fmtNum(grandTotals.total_cbm)}</td>
                    <td className="p-2 text-slate-400 text-right">—</td>
                    <td className="p-2 text-right tabular-nums">{fmtNum(grandTotals.total_weight_kg)}</td>
                    <td className="p-2 text-slate-400 text-right">—</td>
                    <td className="p-2 text-right tabular-nums">{fmtNum(grandTotals.total_amount_rmb)}</td>
                    <td className="p-2 text-slate-400" colSpan={3}>—</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {lastRaw && (
        <div className="rounded-lg border border-slate-200 bg-white">
          <button
            type="button"
            className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            onClick={() => setShowRaw(!showRaw)}
          >
            {showRaw ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Raw API response (debug)
          </button>
          {showRaw && (
            <pre className="text-[10px] leading-snug p-3 border-t bg-slate-950 text-slate-100 overflow-x-auto max-h-[320px] overflow-y-auto">
              {lastRaw}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-slate-500 text-xs">{label}</div>
      <div className="font-medium text-slate-900 truncate">{value ?? '—'}</div>
    </div>
  )
}

function fmtNum(n: number): string {
  if (!isFinite(n)) return '—'
  const r = Math.round(n * 100) / 100
  return Number.isInteger(r) ? String(r) : r.toFixed(2)
}

function FooterNum({
  label,
  value,
  onChange,
}: {
  label: string
  value: number | null | undefined
  onChange: (v: string) => void
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-slate-500">{label}</span>
      <Input
        className="h-8 text-xs"
        value={value != null && isFinite(value) ? String(value) : ''}
        placeholder="—"
        onChange={e => onChange(e.target.value)}
      />
    </label>
  )
}
