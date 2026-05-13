'use client'

import React, { useEffect, useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Search, ImageIcon, Download, FileSpreadsheet, FileText, MoreHorizontal, AlertTriangle, Trash2, Plus, Minus } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  deleteDocumentItem,
  adjustDocumentItemCartons,
  getDocumentImportMeta,
  type DocumentFooterPaymentRow,
} from '@/app/actions/products'
import { isSectionDividerProduct, REPACKAGED_SECTION_TITLE } from '@/lib/sections'
import type { Product, ImportMeta, ProductDocumentRef } from '@/lib/types'

type Props = {
  products: Product[]
  warehouseLeftProducts: Product[]
  /** Stored `document_items` that match `isFooterLikeItem` — counted in DB `computed_*` but omitted from compiled + warehouse tables. */
  footerLikeExcludedProducts: Product[]
  importMeta: ImportMeta | null
  productDocuments: ProductDocumentRef[]
}

type CompiledRow = Product & { _variants: number; _rowNo: number }
type DividerRow = { _isDivider: true; id: string; title: string }
type CompiledDisplayRow = CompiledRow | DividerRow

/**
 * Strip trailing model-number codes from a product name to get the base name.
 * A word is treated as a model code (and stops the base) if it:
 *   - contains any digit (e.g. "KD63-218A", "TE-R100FG-1", "SCT-150")
 *   - is all-uppercase / pure code with no lowercase (e.g. "SCT", "KD")
 * Examples:
 *   "Vacuum Flask TE-R100FG-1"  → "Vacuum Flask"
 *   "Cup Stand KD63-218A"       → "Cup Stand"
 *   "Ceramic Canister Set SCT-" → "Ceramic Canister Set"
 */
function extractBaseName(name: string): string {
  const words = name.trim().split(/\s+/)
  const base: string[] = []
  for (const w of words) {
    // Stop at CJK/Unicode suffix tokens after we've captured an English base name.
    if (/[\u2e80-\u9fff]/.test(w) && base.length > 0) break
    if (/\d/.test(w)) break                          // word contains a digit → model code
    if (/^[A-Z]{2,}/.test(w) && !/^[A-Z][a-z]/.test(w)) break  // all-caps code (e.g. "SCT")
    base.push(w)
  }
  return base.length > 0 ? base.join(' ') : words[0] ?? name
}

function fmt(n: number | null | undefined, decimals = 2) {
  if (n == null) return '-'
  return n.toLocaleString('en-UG', { minimumFractionDigits: 0, maximumFractionDigits: decimals })
}

function parseWeight(w: string | null | undefined): number {
  return parseFloat((w ?? '0').replace(/[^\d.]/g, '')) || 0
}

/** Sum numeric columns on raw Product rows (no compile merge). */
function sumProductMetrics(rows: Product[]) {
  return {
    cartons: rows.reduce((s, p) => s + (p.cartons ?? 0), 0),
    cbm: rows.reduce((s, p) => s + (p.cbm ?? 0), 0),
    weight: rows.reduce((s, p) => s + parseWeight(p.total_weight), 0),
    amount: rows.reduce((s, p) => s + (p.total_amount_rmb ?? 0), 0),
  }
}

/** Uses `manifest_section` from `document_items` (Compiled Products page only). */
function isRepackedManifestSection(p: Pick<Product, 'manifest_section'>): boolean {
  return (p.manifest_section ?? '').trim().toLowerCase() === 'repacked'
}

// ── Export field definitions ────────────────────────────────────────────────

type FieldKey =
  | 'name' | 'sku' | 'description' | 'shop_name' | 'packing'
  | 'cartons' | 'quantity' | 'unit_cbm' | 'cbm'
  | 'unit_weight' | 'total_weight' | 'cost_price' | 'total_amount_rmb'

const EXPORT_FIELDS: { key: FieldKey; label: string; defaultOn: boolean }[] = [
  { key: 'name',            label: 'Item Name',        defaultOn: true  },
  { key: 'sku',             label: 'SKU / MARKS',      defaultOn: false },
  { key: 'description',     label: 'Description',      defaultOn: false },
  { key: 'shop_name',       label: 'Shop #',           defaultOn: false },
  { key: 'packing',         label: 'Packing (PCS/CTN)',defaultOn: true  },
  { key: 'cartons',         label: 'CTN',              defaultOn: true  },
  { key: 'quantity',        label: 'T.QTY',            defaultOn: true  },
  { key: 'unit_cbm',        label: 'U.CBM',            defaultOn: false },
  { key: 'cbm',             label: 'T.CBM',            defaultOn: false },
  { key: 'unit_weight',     label: 'U.Weight',         defaultOn: false },
  { key: 'total_weight',    label: 'T.Weight',         defaultOn: false },
  { key: 'cost_price',      label: 'Unit Price (¥)',   defaultOn: false },
  { key: 'total_amount_rmb',label: 'T.Amount (¥)',     defaultOn: false },
]



function getCellValue(row: CompiledRow, key: FieldKey): string {
  switch (key) {
    case 'name':             return row.name ?? '-'
    case 'sku':              return row.sku ?? '-'
    case 'description':      return row.description ?? '-'
    case 'shop_name':        return row.shop_name ?? '-'
    case 'packing':          return row.packing ?? '-'
    case 'cartons':          return row.cartons != null ? String(row.cartons) : '-'
    case 'quantity':         return row.quantity > 0 ? `${row.quantity} ${row.unit}` : '-'
    case 'unit_cbm':         return row.unit_cbm != null ? Number(row.unit_cbm).toFixed(3) : '-'
    case 'cbm':              return row.cbm != null ? Number(row.cbm).toFixed(4) : '-'
    case 'unit_weight':      return row.unit_weight ?? '-'
    case 'total_weight':     return row.total_weight ?? '-'
    case 'cost_price':       return row.cost_price > 0 ? `¥${fmt(row.cost_price)}` : '-'
    case 'total_amount_rmb': return row.total_amount_rmb != null ? `¥${fmt(row.total_amount_rmb)}` : '-'
  }
}

// ── Excel export ────────────────────────────────────────────────────────────

async function exportToExcel(rows: CompiledRow[], selectedFields: FieldKey[], importMeta: ImportMeta | null) {
  const XLSX = await import('xlsx')
  const fieldDefs = EXPORT_FIELDS.filter(f => selectedFields.includes(f.key))

  const header = ['No.', ...fieldDefs.map(f => f.label)]
  const data = rows.map((row, i) => [
    i + 1,
    ...fieldDefs.map(f => getCellValue(row, f.key)),
  ])

  const totalsRow: (string | number | null)[] = [`TOTALS (${rows.length} rows)`]
  for (const f of fieldDefs) {
    switch (f.key) {
      case 'cartons':          totalsRow.push(rows.reduce((s, r) => s + (r.cartons ?? 0), 0)); break
      case 'quantity':         totalsRow.push(rows.reduce((s, r) => s + r.quantity, 0)); break
      case 'cbm':              totalsRow.push(rows.reduce((s, r) => s + (r.cbm ?? 0), 0)); break
      case 'total_amount_rmb': totalsRow.push(rows.reduce((s, r) => s + (r.total_amount_rmb ?? 0), 0)); break
      case 'total_weight':     totalsRow.push(rows.reduce((s, r) => s + parseWeight(r.total_weight), 0)); break
      default:                 totalsRow.push(null)
    }
  }

  const ws = XLSX.utils.aoa_to_sheet([header, ...data, totalsRow])
  ws['!cols'] = [{ wch: 5 }, ...fieldDefs.map(() => ({ wch: 22 }))]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Compiled Products')
  XLSX.writeFile(wb, `compiled_products_${Date.now()}.xlsx`)
}

// ── PDF export ──────────────────────────────────────────────────────────────

function exportToPdf(rows: CompiledRow[], selectedFields: FieldKey[], importMeta: ImportMeta | null) {
  const fieldDefs = EXPORT_FIELDS.filter(f => selectedFields.includes(f.key))

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const metaLine = importMeta
    ? `Client: ${esc(importMeta.client_details ?? '-')} &nbsp;|&nbsp; Container: ${esc(importMeta.container_no ?? '-')} &nbsp;|&nbsp; ${rows.length} items`
    : `${rows.length} items`

  const headerCells = ['No.', ...fieldDefs.map(f => f.label)].map(h => `<th>${esc(h)}</th>`).join('')

  const bodyRows = rows.map((row, i) => {
    const cells = [String(i + 1), ...fieldDefs.map(f => getCellValue(row, f.key))]
      .map(c => `<td>${esc(c)}</td>`).join('')
    return `<tr class="${i % 2 === 1 ? 'alt' : ''}">${cells}</tr>`
  }).join('')

  const totalCells = ['<td class="bold" style="background:#e2e8f0">TOTALS</td>']
  for (const f of fieldDefs) {
    let val = ''
    switch (f.key) {
      case 'cartons':          val = rows.reduce((s, r) => s + (r.cartons ?? 0), 0).toLocaleString(); break
      case 'quantity':         val = rows.reduce((s, r) => s + r.quantity, 0).toLocaleString(); break
      case 'cbm':              val = rows.reduce((s, r) => s + (r.cbm ?? 0), 0).toFixed(4); break
      case 'total_amount_rmb': val = '¥' + rows.reduce((s, r) => s + (r.total_amount_rmb ?? 0), 0).toLocaleString(); break
      case 'total_weight':     val = rows.reduce((s, r) => s + parseWeight(r.total_weight), 0).toFixed(1) + ' KGS'; break
    }
    totalCells.push(`<td class="bold" style="background:#e2e8f0">${esc(val)}</td>`)
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Compiled Products</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 8pt; margin: 0; padding: 8mm; color: #111; }
  h2 { margin: 0 0 2mm; font-size: 11pt; }
  p  { margin: 0 0 4mm; font-size: 7.5pt; color: #555; }
  table { border-collapse: collapse; width: 100%; table-layout: auto; }
  th { background: #1e293b; color: #fff; padding: 2px 4px; font-size: 7pt; text-align: left; white-space: nowrap; }
  td { border: 1px solid #d1d5db; padding: 2px 4px; font-size: 7.5pt; vertical-align: top; word-break: break-word; }
  tr.alt td { background: #f8fafc; }
  .bold { font-weight: bold; }
  @media print { @page { size: A3 landscape; margin: 8mm; } }
</style>
</head>
<body>
<h2>Compiled Products</h2>
<p>${metaLine}</p>
<table>
  <thead><tr>${headerCells}</tr></thead>
  <tbody>
    ${bodyRows}
    <tr>${totalCells.join('')}</tr>
  </tbody>
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

// ── Component ───────────────────────────────────────────────────────────────

export function CompiledProductsClient({
  products,
  warehouseLeftProducts,
  footerLikeExcludedProducts,
  importMeta,
  productDocuments,
}: Props) {
  const [query, setQuery] = useState('')
  const [selectedDocumentId, setSelectedDocumentId] = useState<string>('all')
  /** PDF footer totals + payments for the document chosen in the dropdown (not global latest import). */
  const [documentFooterMeta, setDocumentFooterMeta] = useState<ImportMeta | null>(null)
  const [documentPaymentRows, setDocumentPaymentRows] = useState<DocumentFooterPaymentRow[] | null>(null)
  const [documentFooterLoading, setDocumentFooterLoading] = useState(false)
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set())
  const [outOfStockIds, setOutOfStockIds] = useState<Set<string>>(new Set())
  const [adjustingId, setAdjustingId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [exportOpen, setExportOpen] = useState(false)
  const [exportFormat, setExportFormat] = useState<'excel' | 'pdf'>('excel')
  const [selectedFields, setSelectedFields] = useState<Set<FieldKey>>(
    () => new Set(EXPORT_FIELDS.filter(f => f.defaultOn).map(f => f.key))
  )

  const visibleProducts = useMemo(
    () =>
      products.filter(
        p => selectedDocumentId === 'all' || p.source_document_id === selectedDocumentId
      ),
    [products, selectedDocumentId]
  )

  const visibleWarehouseLeft = useMemo(
    () =>
      warehouseLeftProducts.filter(
        p => selectedDocumentId === 'all' || p.source_document_id === selectedDocumentId
      ),
    [warehouseLeftProducts, selectedDocumentId]
  )

  const warehouseLeftFiltered = useMemo(() => {
    if (!query.trim()) return visibleWarehouseLeft
    const q = query.toLowerCase()
    return visibleWarehouseLeft.filter(
      p =>
        p.name?.toLowerCase().includes(q) ||
        p.sku?.toLowerCase().includes(q) ||
        p.shop_name?.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q)
    )
  }, [visibleWarehouseLeft, query])

  const leftTotals = useMemo(() => sumProductMetrics(warehouseLeftFiltered), [warehouseLeftFiltered])

  const visibleFooterLikeExcluded = useMemo(
    () =>
      footerLikeExcludedProducts.filter(
        p => selectedDocumentId === 'all' || p.source_document_id === selectedDocumentId
      ),
    [footerLikeExcludedProducts, selectedDocumentId]
  )

  const footerLikeFiltered = useMemo(() => {
    if (!query.trim()) return visibleFooterLikeExcluded
    const q = query.toLowerCase()
    return visibleFooterLikeExcluded.filter(
      p =>
        p.name?.toLowerCase().includes(q) ||
        p.sku?.toLowerCase().includes(q) ||
        p.shop_name?.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q)
    )
  }, [visibleFooterLikeExcluded, query])

  const footerLikeTotals = useMemo(() => sumProductMetrics(footerLikeFiltered), [footerLikeFiltered])

  const { compiledRows, normalCompiledCount, hasRepackedSourceRows } = useMemo(() => {
    const compileSection = (rows: Product[], rowNoStart: number) => {
      const map = new Map<string, CompiledRow>()
      const singles: CompiledRow[] = []
      let rowNo = rowNoStart

      for (const p of rows) {
        if (!p.name) {
          singles.push({ ...p, _variants: 1, _rowNo: 0 })
          continue
        }
        const baseName = extractBaseName(p.name)
        const packingTrimmed = (p.packing ?? '').trim()
        const hasQuantity = Number.isFinite(p.quantity) && p.quantity > 0
        const key = packingTrimmed
          ? `${baseName.toLowerCase()}||pack||${packingTrimmed.toLowerCase()}`
          : hasQuantity
            ? `${baseName.toLowerCase()}||no_pack_qty||${p.quantity}`
            : `${baseName.toLowerCase()}||no_pack_no_qty`
        const existing = map.get(key)
        if (!existing) {
          map.set(key, { ...p, name: baseName, _variants: 1, _rowNo: rowNo++ })
        } else {
          existing._variants++
          existing.cartons = (existing.cartons ?? 0) + (p.cartons ?? 0)
          existing.quantity += p.quantity
          existing.cbm = +((existing.cbm ?? 0) + (p.cbm ?? 0)).toFixed(4)
          const sumW = parseWeight(existing.total_weight) + parseWeight(p.total_weight)
          existing.total_weight = sumW > 0 ? `${sumW.toFixed(1)}KGS` : existing.total_weight
          existing.total_amount_rmb = (existing.total_amount_rmb ?? 0) + (p.total_amount_rmb ?? 0)
        }
      }

      const numbered = [...map.values()].sort((a, b) =>
        (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' })
      )
      const sortedSingles = singles
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' }))
      sortedSingles.forEach(s => { s._rowNo = rowNo++ })
      const data = [...numbered, ...sortedSingles]
      return { data, nextRowNo: rowNo }
    }

    const nonDivider = (p: Product) => !isSectionDividerProduct(p)
    const normalSourceRows = visibleProducts.filter(p => nonDivider(p) && !isRepackedManifestSection(p))
    const repackedSourceRows = visibleProducts.filter(p => nonDivider(p) && isRepackedManifestSection(p))

    const normal = compileSection(normalSourceRows, 1)
    const repacked = compileSection(repackedSourceRows, normal.nextRowNo)
    const combined = [...normal.data, ...repacked.data]
    return {
      compiledRows: combined,
      normalCompiledCount: normal.data.length,
      hasRepackedSourceRows: repackedSourceRows.length > 0,
    }
  }, [visibleProducts])

  const compiled = useMemo<CompiledDisplayRow[]>(() => {
    if (!hasRepackedSourceRows || normalCompiledCount <= 0 || normalCompiledCount >= compiledRows.length) {
      return compiledRows
    }
    return [
      ...compiledRows.slice(0, normalCompiledCount),
      { _isDivider: true, id: 'compiled-repackaged-divider', title: REPACKAGED_SECTION_TITLE },
      ...compiledRows.slice(normalCompiledCount),
    ]
  }, [compiledRows, normalCompiledCount, hasRepackedSourceRows])

  const filtered = useMemo(() => {
    if (!query.trim()) return compiled
    const q = query.toLowerCase()
    return compiled.filter(
      p =>
        !('_isDivider' in p) && (
          p.name?.toLowerCase().includes(q) ||
          p.sku?.toLowerCase().includes(q) ||
          p.shop_name?.toLowerCase().includes(q) ||
          p.description?.toLowerCase().includes(q)
        ),
    )
  }, [compiled, query])

  const filteredDataRows = useMemo(
    () => filtered.filter((p): p is CompiledRow => !('_isDivider' in p)),
    [filtered]
  )

  const totals = useMemo(() => ({
    cartons: filteredDataRows.reduce((s, p) => s + (p.cartons ?? 0), 0),
    cbm: filteredDataRows.reduce((s, p) => s + (p.cbm ?? 0), 0),
    weight: filteredDataRows.reduce((s, p) => s + parseWeight(p.total_weight), 0),
    amount: filteredDataRows.reduce((s, p) => s + (p.total_amount_rmb ?? 0), 0),
  }), [filteredDataRows])

  const combinedLineTotals = useMemo(
    () => ({
      cartons: totals.cartons + leftTotals.cartons,
      cbm: totals.cbm + leftTotals.cbm,
      weight: totals.weight + leftTotals.weight,
      amount: totals.amount + leftTotals.amount,
    }),
    [totals, leftTotals]
  )

  /** PDF / `document_totals.total_*` is the printed manifest footer — stuffed/shipped scope, not “goods left”. */
  const footerVsCompiled = useMemo(() => {
    if (!documentFooterMeta) return null
    const ctn = documentFooterMeta.total_carton
    const cbm = documentFooterMeta.total_cbm
    const w = documentFooterMeta.total_weight_kgs
    const rmb = documentFooterMeta.total_cost_rmb
    const y = totals
    return {
      cartons:
        ctn != null ? Math.round((y.cartons - Number(ctn)) * 1000) / 1000 : null,
      cbm: cbm != null ? Math.round((y.cbm - Number(cbm)) * 10000) / 10000 : null,
      weight: w != null ? Math.round((y.weight - Number(w)) * 10) / 10 : null,
      amount: rmb != null ? Math.round((y.amount - Number(rmb)) * 100) / 100 : null,
    }
  }, [documentFooterMeta, totals])

  /** Page sum (yellow+sky) vs DB trigger sum of `document_items` — catches footer-filter drift vs SQL. */
  const combinedVsDbComputed = useMemo(() => {
    if (!documentFooterMeta) return null
    const c = documentFooterMeta.computed_sum_cartons
    const b = documentFooterMeta.computed_sum_cbm
    const w = documentFooterMeta.computed_sum_weight_kgs
    const a = documentFooterMeta.computed_sum_amount_rmb
    if (c == null && b == null && w == null && a == null) return null
    const cl = combinedLineTotals
    return {
      cartons: c != null ? Math.round((cl.cartons - Number(c)) * 1000) / 1000 : null,
      cbm: b != null ? Math.round((cl.cbm - Number(b)) * 10000) / 10000 : null,
      weight: w != null ? Math.round((cl.weight - Number(w)) * 10) / 10 : null,
      amount: a != null ? Math.round((cl.amount - Number(a)) * 100) / 100 : null,
    }
  }, [documentFooterMeta, combinedLineTotals])

  const selectedDataRows = useMemo(
    () => filteredDataRows.filter(p => selectedRowIds.has(p.id)),
    [filteredDataRows, selectedRowIds]
  )

  const selectedTotals = useMemo(() => ({
    cartons: selectedDataRows.reduce((s, p) => s + (p.cartons ?? 0), 0),
    cbm: selectedDataRows.reduce((s, p) => s + (p.cbm ?? 0), 0),
    weight: selectedDataRows.reduce((s, p) => s + parseWeight(p.total_weight), 0),
    amount: selectedDataRows.reduce((s, p) => s + (p.total_amount_rmb ?? 0), 0),
  }), [selectedDataRows])

  useEffect(() => {
    if (selectedDocumentId === 'all') {
      setDocumentFooterMeta(null)
      setDocumentPaymentRows(null)
      setDocumentFooterLoading(false)
      return
    }
    let cancelled = false
    setDocumentFooterLoading(true)
    ;(async () => {
      try {
        const bundle = await getDocumentImportMeta(selectedDocumentId)
        if (cancelled) return
        if (bundle) {
          setDocumentFooterMeta(bundle.meta)
          setDocumentPaymentRows(bundle.paymentRows.length > 0 ? bundle.paymentRows : null)
        } else {
          setDocumentFooterMeta(null)
          setDocumentPaymentRows(null)
        }
      } catch {
        if (!cancelled) {
          setDocumentFooterMeta(null)
          setDocumentPaymentRows(null)
        }
      } finally {
        if (!cancelled) setDocumentFooterLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedDocumentId])

  const exportImportMeta = documentFooterMeta ?? importMeta

  useEffect(() => {
    const visibleIds = new Set(filteredDataRows.map(p => p.id))
    setSelectedRowIds(prev => {
      const next = new Set([...prev].filter(id => visibleIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [filteredDataRows])

  const allVisibleSelected = filteredDataRows.length > 0 && filteredDataRows.every(p => selectedRowIds.has(p.id))
  const someVisibleSelected = filteredDataRows.some(p => selectedRowIds.has(p.id))

  function toggleField(key: FieldKey) {
    setSelectedFields(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function toggleOutOfStock(id: string) {
    setOutOfStockIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleRowSelection(id: string) {
    setSelectedRowIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAllVisible(checked: boolean | 'indeterminate') {
    const shouldSelectAll = checked === true || (checked === 'indeterminate' && !allVisibleSelected)
    setSelectedRowIds(prev => {
      const next = new Set(prev)
      if (shouldSelectAll) filteredDataRows.forEach(p => next.add(p.id))
      else filteredDataRows.forEach(p => next.delete(p.id))
      return next
    })
  }

  function handleDelete(id: string, name: string | null) {
    if (!confirm(`Delete "${name ?? 'this product'}"? This cannot be undone.`)) return
    startTransition(async () => {
      try {
        await deleteDocumentItem(id)
        toast.success('Product deleted')
      } catch (e: any) {
        toast.error(e.message)
      }
    })
  }

  async function handleAdjustCartons(id: string, delta: number) {
    if (adjustingId) return
    setAdjustingId(id)
    try {
      await adjustDocumentItemCartons(id, delta)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setAdjustingId(null)
    }
  }

  function openExport(format: 'excel' | 'pdf') {
    setExportFormat(format)
    setExportOpen(true)
  }

  function runExport() {
    const fields = EXPORT_FIELDS.map(f => f.key).filter(k => selectedFields.has(k))
    if (fields.length === 0) return
    const rows =
      selectedDataRows.length > 0
        ? selectedDataRows
        : filteredDataRows.length < compiledRows.length
          ? filteredDataRows
          : compiledRows
    if (exportFormat === 'excel') exportToExcel(rows, fields, exportImportMeta)
    else exportToPdf(rows, fields, exportImportMeta)
    setExportOpen(false)
  }

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Compiled Products</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {compiledRows.length} unique items (from {visibleProducts.filter(p => !isSectionDividerProduct(p)).length} total)
          </p>
          <p className="text-[11px] text-slate-500 mt-1">
            All sections except <strong>goods left in warehouse</strong> (same DB rows as Products shipped + repacked blocks;
            footer-style lines excluded). Repacked block is split using <code className="text-[10px]">manifest_section</code>.
          </p>
          {selectedDataRows.length > 0 && (
            <p className="text-xs text-emerald-700 mt-1">
              {selectedDataRows.length} selected
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <Input
              placeholder="Search name, SKU, shop…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="pl-8 h-8 text-sm w-56"
            />
          </div>
          <Select value={selectedDocumentId} onValueChange={(value) => setSelectedDocumentId(value ?? 'all')}>
            <SelectTrigger className="h-8 text-xs w-[260px]">
              <SelectValue placeholder="All PDFs / documents" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All PDFs / documents</SelectItem>
              {productDocuments.map(doc => (
                <SelectItem key={doc.id} value={doc.id}>
                  {(doc.source_file_name ?? doc.id).slice(0, 70)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="h-8 gap-1.5" />}>
              <Download className="h-3.5 w-3.5" /> Export
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openExport('excel')}>
                <FileSpreadsheet className="h-3.5 w-3.5 mr-2" /> Excel (.xlsx)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openExport('pdf')}>
                <FileText className="h-3.5 w-3.5 mr-2" /> PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Client / container — only when a single document is selected (matches footer totals). */}
      {documentFooterMeta && (
        <div className="rounded-md border bg-amber-50 border-amber-200 px-3 py-2 text-xs flex flex-wrap gap-x-6 gap-y-0.5 items-center">
          <span className="font-semibold text-slate-800">
            CLIENT DETAILS: <span className="text-amber-800">{documentFooterMeta.client_details ?? '-'}</span>
          </span>
          <span className="font-semibold text-slate-800">
            CONTAINER NO: <span className="text-amber-800">{documentFooterMeta.container_no ?? '-'}</span>
          </span>
          <span className="text-slate-500 text-[10px] ml-auto">{documentFooterMeta.source_file_name}</span>
        </div>
      )}

      {/* Table */}
      <div className="rounded-md border bg-white overflow-x-auto">
        <Table className="text-xs min-w-[1200px]">
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead className="w-10 text-center">#</TableHead>
              <TableHead className="w-10 text-center">
                <Checkbox
                  checked={allVisibleSelected}
                  onCheckedChange={toggleSelectAllVisible}
                  aria-label="Select all visible compiled products"
                />
              </TableHead>
              <TableHead className="w-10 px-2" />
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Order No</TableHead>
              <TableHead>CUS No</TableHead>
              <TableHead>Item No</TableHead>
              <TableHead>Shop</TableHead>
              <TableHead>Packing</TableHead>
              <TableHead className="text-right">CTN</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">U.CBM</TableHead>
              <TableHead className="text-right">T.CBM</TableHead>
              <TableHead className="text-right">U.Weight</TableHead>
              <TableHead className="text-right">T.Weight</TableHead>
              <TableHead className="text-right">Unit Price</TableHead>
              <TableHead className="text-right">T.Amount</TableHead>
              <TableHead className="text-center">Variants</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={20} className="text-center text-slate-400 py-10">
                  No products found.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((p, i) => {
                if ('_isDivider' in p) {
                  return (
                    <TableRow key={p.id} className="bg-yellow-200 hover:bg-yellow-200">
                      <TableCell colSpan={20} className="text-center font-semibold text-slate-800 py-2 tracking-wide">
                        {p.title}
                      </TableCell>
                    </TableRow>
                  )
                }
                const isZeroStock = (p.cartons ?? 0) === 0 && p.quantity === 0
                const isMarkedOutOfStock = !isZeroStock && outOfStockIds.has(p.id)
                const isSelected = selectedRowIds.has(p.id)
                const rowClass = isSelected
                  ? 'bg-indigo-100 hover:bg-indigo-100'
                  : isZeroStock
                  ? 'bg-red-100 hover:bg-red-100'
                  : isMarkedOutOfStock
                  ? 'bg-yellow-100 hover:bg-yellow-100'
                  : 'hover:bg-slate-50'
                return (
                  <TableRow key={`${p.id}-${i}`} className={rowClass}>
                    <TableCell className="text-center text-slate-400 font-mono text-[10px]">{i + 1}</TableCell>
                    <TableCell className="text-center p-1">
                      <Checkbox
                        checked={selectedRowIds.has(p.id)}
                        onCheckedChange={() => toggleRowSelection(p.id)}
                        aria-label={`Select ${p.name ?? 'row'}`}
                      />
                    </TableCell>
                    <TableCell className="p-1">
                      {p.image_url ? (
                        <img src={p.image_url} alt={p.name ?? ''} className="h-8 w-8 rounded object-cover border border-slate-100" />
                      ) : (
                        <div className="h-8 w-8 rounded bg-slate-100 flex items-center justify-center">
                          <ImageIcon className="h-3.5 w-3.5 text-slate-300" />
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-medium text-slate-900 max-w-[180px] truncate">{p.name ?? '-'}</TableCell>
                    <TableCell className="text-slate-500 max-w-[160px] truncate">{p.description ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.order_no ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.customer_no ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.source_item_no ?? '-'}</TableCell>
                    <TableCell className="max-w-[100px] truncate">{p.shop_name ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.packing ?? '-'}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-0.5">
                        <Button
                          variant="ghost" size="icon"
                          className="h-5 w-5 rounded text-slate-500 hover:text-slate-900"
                          disabled={adjustingId === p.id}
                          onClick={() => handleAdjustCartons(p.id, -1)}
                        >
                          <Minus className="h-2.5 w-2.5" />
                        </Button>
                        <span className="w-7 text-center tabular-nums">{p.cartons ?? '-'}</span>
                        <Button
                          variant="ghost" size="icon"
                          className="h-5 w-5 rounded text-slate-500 hover:text-slate-900"
                          disabled={adjustingId === p.id}
                          onClick={() => handleAdjustCartons(p.id, +1)}
                        >
                          <Plus className="h-2.5 w-2.5" />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-medium">{p.quantity} {p.unit}</TableCell>
                    <TableCell className="text-right">{p.unit_cbm != null ? Number(p.unit_cbm).toFixed(3) : '-'}</TableCell>
                    <TableCell className="text-right">{p.cbm != null ? Number(p.cbm).toFixed(4) : '-'}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">{p.unit_weight ?? '-'}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">{p.total_weight ?? '-'}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {p.cost_price > 0 ? `¥${fmt(p.cost_price)}` : '-'}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {p.total_amount_rmb != null ? `¥${fmt(p.total_amount_rmb)}` : '-'}
                    </TableCell>
                    <TableCell className="text-center">
                      {p._variants > 1 ? (
                        <Badge className="bg-blue-100 text-blue-700 border-blue-200 text-[10px] font-semibold">
                          ×{p._variants}
                        </Badge>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="h-7 w-7" />}>
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            className={outOfStockIds.has(p.id) ? 'text-slate-600' : 'text-amber-600'}
                            onClick={() => toggleOutOfStock(p.id)}
                          >
                            <AlertTriangle className="h-3.5 w-3.5 mr-2" />
                            {outOfStockIds.has(p.id) ? 'Unmark Out of Stock' : 'Mark Out of Stock'}
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-red-600" onClick={() => handleDelete(p.id, p.name)}>
                            <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })
            )}

            {selectedDataRows.length > 0 && (
              <TableRow className="bg-emerald-100 font-bold border-t-2 border-emerald-400">
                <TableCell colSpan={20} className="text-right text-emerald-900">
                  {`SELECTED TOTALS: ${fmt(selectedTotals.cartons, 0)} CTNS | ${fmt(selectedTotals.cbm, 4)} CBM | ${fmt(selectedTotals.weight, 1)} KGS | ¥${fmt(selectedTotals.amount, 0)}`}
                </TableCell>
              </TableRow>
            )}
            {filteredDataRows.length > 0 && (
              <TableRow className="bg-yellow-300 font-bold border-t-2 border-yellow-500">
                <TableCell colSpan={20} className="text-right text-slate-900">
                  {`TOTALS (excl. warehouse-left, compiled): ${fmt(totals.cartons, 0)} CTNS | ${fmt(totals.cbm, 4)} CBM | ${fmt(totals.weight, 1)} KGS | ¥${fmt(totals.amount, 0)}`}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Reconciliation: PDF footer = manifest stuffed/shipped — compare to yellow only, not yellow+sky. */}
      {/* {selectedDocumentId !== 'all' && (
        <div className="rounded-md border border-indigo-200 bg-indigo-50/90 px-3 py-2 text-xs space-y-1.5">
          <p className="font-semibold text-indigo-950">
            Line totals reconciliation
            <span className="font-normal text-indigo-800 ml-2">
              The PDF footer is the printed manifest total for goods stuffed / shipped — it does{' '}
              <strong>not</strong> include &quot;goods left in warehouse&quot;. Compare the{' '}
              <strong>yellow</strong> bar to the PDF; the sky block is separate on purpose.
            </span>
          </p>
          <div className="grid gap-1 font-mono text-[11px] text-slate-900">
            <div>
              <span className="text-slate-600">Compiled (yellow bar, excl. warehouse-left):</span>{' '}
              {fmt(totals.cartons, 0)} CTN | {fmt(totals.cbm, 4)} CBM | {fmt(totals.weight, 1)} KGS | ¥{fmt(totals.amount, 0)}
            </div>
            <div>
              <span className="text-slate-600">Warehouse-left (sky bar, same filter):</span>{' '}
              {fmt(leftTotals.cartons, 0)} CTN | {fmt(leftTotals.cbm, 4)} CBM | {fmt(leftTotals.weight, 1)} KGS | ¥{fmt(leftTotals.amount, 0)}
            </div>
            <div className="border-t border-indigo-200/80 pt-1 text-slate-700">
              <span className="text-slate-600">All stored lines (yellow + sky, reference only):</span>{' '}
              {fmt(combinedLineTotals.cartons, 0)} CTN | {fmt(combinedLineTotals.cbm, 4)} CBM | {fmt(combinedLineTotals.weight, 1)} KGS | ¥{fmt(combinedLineTotals.amount, 0)}
              <span className="font-normal text-slate-500 ml-1">
                — not expected to match the PDF footer when the PDF excludes warehouse-left.
              </span>
            </div>
            {documentFooterLoading ? (
              <p className="text-slate-600">Loading PDF footer…</p>
            ) : documentFooterMeta ? (
              <>
                <div>
                  <span className="text-slate-600">PDF footer (`document_totals.total_*`, printed totals):</span>{' '}
                  {documentFooterMeta.total_carton != null ? `${fmt(documentFooterMeta.total_carton, 0)} CTN` : '—'} |{' '}
                  {documentFooterMeta.total_cbm != null ? `${fmt(documentFooterMeta.total_cbm, 4)} CBM` : '—'} |{' '}
                  {documentFooterMeta.total_weight_kgs != null ? `${fmt(documentFooterMeta.total_weight_kgs, 1)} KGS` : '—'} |{' '}
                  {documentFooterMeta.total_cost_rmb != null ? `¥${fmt(documentFooterMeta.total_cost_rmb, 0)}` : '—'}
                </div>
                {documentFooterMeta.computed_sum_cartons != null ||
                documentFooterMeta.computed_sum_cbm != null ||
                documentFooterMeta.computed_sum_weight_kgs != null ||
                documentFooterMeta.computed_sum_amount_rmb != null ? (
                  <div className="text-slate-700">
                    <span className="text-slate-600">DB sum of `document_items` (computed_* trigger, incl. warehouse-left):</span>{' '}
                    {documentFooterMeta.computed_sum_cartons != null ? `${fmt(documentFooterMeta.computed_sum_cartons, 0)} CTN` : '—'} |{' '}
                    {documentFooterMeta.computed_sum_cbm != null ? `${fmt(documentFooterMeta.computed_sum_cbm, 4)} CBM` : '—'} |{' '}
                    {documentFooterMeta.computed_sum_weight_kgs != null ? `${fmt(documentFooterMeta.computed_sum_weight_kgs, 1)} KGS` : '—'} |{' '}
                    {documentFooterMeta.computed_sum_amount_rmb != null ? `¥${fmt(documentFooterMeta.computed_sum_amount_rmb, 0)}` : '—'}
                  </div>
                ) : null}
                {footerVsCompiled && (() => {
                  const parts: string[] = []
                  if (footerVsCompiled.cartons != null) parts.push(`${fmt(footerVsCompiled.cartons, 3)} CTN`)
                  if (footerVsCompiled.cbm != null) parts.push(`${fmt(footerVsCompiled.cbm, 4)} CBM`)
                  if (footerVsCompiled.weight != null) parts.push(`${fmt(footerVsCompiled.weight, 1)} KGS`)
                  if (footerVsCompiled.amount != null) parts.push(`¥${fmt(footerVsCompiled.amount, 2)}`)
                  const allZero =
                    (footerVsCompiled.cartons == null || footerVsCompiled.cartons === 0) &&
                    (footerVsCompiled.cbm == null || footerVsCompiled.cbm === 0) &&
                    (footerVsCompiled.weight == null || footerVsCompiled.weight === 0) &&
                    (footerVsCompiled.amount == null || footerVsCompiled.amount === 0)
                  if (parts.length === 0) {
                    return (
                      <p className="text-slate-600">
                        PDF footer has no numeric totals to compare (compiled − PDF not shown).
                      </p>
                    )
                  }
                  return (
                    <div
                      className={
                        allZero
                          ? 'text-emerald-900 font-semibold'
                          : 'text-amber-950 font-semibold'
                      }
                    >
                      Δ (compiled − PDF): {parts.join(' | ')}
                      <span className="font-normal text-slate-600 ml-2">
                        Use this row for manifests. Columns with no PDF value are omitted.
                      </span>
                    </div>
                  )
                })()}
                {combinedVsDbComputed && (() => {
                  const parts: string[] = []
                  if (combinedVsDbComputed.cartons != null) parts.push(`${fmt(combinedVsDbComputed.cartons, 3)} CTN`)
                  if (combinedVsDbComputed.cbm != null) parts.push(`${fmt(combinedVsDbComputed.cbm, 4)} CBM`)
                  if (combinedVsDbComputed.weight != null) parts.push(`${fmt(combinedVsDbComputed.weight, 1)} KGS`)
                  if (combinedVsDbComputed.amount != null) parts.push(`¥${fmt(combinedVsDbComputed.amount, 2)}`)
                  if (parts.length === 0) return null
                  const allZero =
                    (combinedVsDbComputed.cartons == null || combinedVsDbComputed.cartons === 0) &&
                    (combinedVsDbComputed.cbm == null || combinedVsDbComputed.cbm === 0) &&
                    (combinedVsDbComputed.weight == null || combinedVsDbComputed.weight === 0) &&
                    (combinedVsDbComputed.amount == null || combinedVsDbComputed.amount === 0)
                  return (
                    <div
                      className={
                        allZero
                          ? 'text-slate-600'
                          : 'text-rose-900 font-medium'
                      }
                    >
                      Δ (page yellow+sky − DB computed lines): {parts.join(' | ')}
                      <span className="font-normal text-slate-600 ml-2">
                        Non-zero is usually rows in the{' '}
                        <strong className="text-slate-800">Excluded (footer-like)</strong> table below (still in{' '}
                        <code className="text-[10px]">document_items</code>, counted by the DB trigger) plus minor rounding.
                      </span>
                    </div>
                  )
                })()}
              </>
            ) : (
              <p className="text-amber-900">
                PDF footer not loaded — cannot compare compiled lines to `document_totals`.
              </p>
            )}
          </div>
        </div>
      )} */}

      {/* Warehouse-left: same columns as compiled, not aggregated — not part of PDF stuffed total. */}
      {/* <div className="space-y-2">
        <div>
          <h2 className="text-sm font-semibold text-sky-950">Goods left in warehouse</h2>
          <p className="text-[11px] text-slate-600 mt-0.5">
            Lines with section <code className="text-[10px]">left_in_warehouse</code>, excluded from the yellow compiled total.
            Uses the same document filter and search as the table above (read-only).
          </p>
        </div>
        <div className="rounded-md border border-sky-200 bg-sky-50/50 overflow-x-auto">
          <Table className="text-xs min-w-[1200px]">
            <TableHeader>
              <TableRow className="bg-sky-100/80">
                <TableHead className="w-10 text-center">#</TableHead>
                <TableHead className="w-10 text-center" aria-hidden />
                <TableHead className="w-10 px-2" />
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Order No</TableHead>
                <TableHead>CUS No</TableHead>
                <TableHead>Item No</TableHead>
                <TableHead>Shop</TableHead>
                <TableHead>Packing</TableHead>
                <TableHead className="text-right">CTN</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">U.CBM</TableHead>
                <TableHead className="text-right">T.CBM</TableHead>
                <TableHead className="text-right">U.Weight</TableHead>
                <TableHead className="text-right">T.Weight</TableHead>
                <TableHead className="text-right">Unit Price</TableHead>
                <TableHead className="text-right">T.Amount</TableHead>
                <TableHead className="text-center">Variants</TableHead>
                <TableHead className="w-10" aria-hidden />
              </TableRow>
            </TableHeader>
            <TableBody>
              {warehouseLeftFiltered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={20} className="text-center text-slate-500 py-8">
                    No warehouse-left lines for this document / search.
                  </TableCell>
                </TableRow>
              ) : (
                warehouseLeftFiltered.map((p, i) => (
                  <TableRow key={p.id} className="hover:bg-sky-100/50">
                    <TableCell className="text-center text-slate-500 font-mono text-[10px]">{i + 1}</TableCell>
                    <TableCell className="text-center p-1 text-slate-300">—</TableCell>
                    <TableCell className="p-1">
                      {p.image_url ? (
                        <img src={p.image_url} alt={p.name ?? ''} className="h-8 w-8 rounded object-cover border border-slate-100" />
                      ) : (
                        <div className="h-8 w-8 rounded bg-slate-100 flex items-center justify-center">
                          <ImageIcon className="h-3.5 w-3.5 text-slate-300" />
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-medium text-slate-900 max-w-[180px] truncate">{p.name ?? '-'}</TableCell>
                    <TableCell className="text-slate-500 max-w-[160px] truncate">{p.description ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.order_no ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.customer_no ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.source_item_no ?? '-'}</TableCell>
                    <TableCell className="max-w-[100px] truncate">{p.shop_name ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.packing ?? '-'}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.cartons ?? '-'}</TableCell>
                    <TableCell className="text-right font-medium">{p.quantity} {p.unit}</TableCell>
                    <TableCell className="text-right">{p.unit_cbm != null ? Number(p.unit_cbm).toFixed(3) : '-'}</TableCell>
                    <TableCell className="text-right">{p.cbm != null ? Number(p.cbm).toFixed(4) : '-'}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">{p.unit_weight ?? '-'}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">{p.total_weight ?? '-'}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {p.cost_price > 0 ? `¥${fmt(p.cost_price)}` : '-'}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {p.total_amount_rmb != null ? `¥${fmt(p.total_amount_rmb)}` : '-'}
                    </TableCell>
                    <TableCell className="text-center text-slate-300">—</TableCell>
                    <TableCell />
                  </TableRow>
                ))
              )}
              {warehouseLeftFiltered.length > 0 && (
                <TableRow className="bg-sky-200 font-bold border-t-2 border-sky-500">
                  <TableCell colSpan={20} className="text-right text-slate-900">
                    {`WAREHOUSE-LEFT TOTALS: ${fmt(leftTotals.cartons, 0)} CTNS | ${fmt(leftTotals.cbm, 4)} CBM | ${fmt(leftTotals.weight, 1)} KGS | ¥${fmt(leftTotals.amount, 0)}`}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div> */}

      {/* Footer-like / financial lines: in DB computed_* but stripped from yellow + sky tables (see document-item-filters). */}
      {/* <div className="space-y-2">
        <div>
          <h2 className="text-sm font-semibold text-amber-950">Excluded from compiled (footer-like lines)</h2>
          <p className="text-[11px] text-slate-600 mt-0.5">
            These <code className="text-[10px]">document_items</code> rows match{' '}
            <code className="text-[10px]">isFooterLikeItem</code> (totals, payments, freight text, etc.). They are{' '}
            <strong>not</strong> in the yellow compiled grid or the warehouse-left sky table, but they still contribute to{' '}
            <code className="text-[10px]">document_totals.computed_*</code>. Same document filter and search as above; read-only.
          </p>
        </div>
        <div className="rounded-md border border-amber-200 bg-amber-50/40 overflow-x-auto">
          <Table className="text-xs min-w-[1200px]">
            <TableHeader>
              <TableRow className="bg-amber-100/90">
                <TableHead className="w-10 text-center">#</TableHead>
                <TableHead className="w-10 text-center" aria-hidden />
                <TableHead className="w-10 px-2" />
                <TableHead>Section</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Order No</TableHead>
                <TableHead>CUS No</TableHead>
                <TableHead>Item No</TableHead>
                <TableHead>Shop</TableHead>
                <TableHead>Packing</TableHead>
                <TableHead className="text-right">CTN</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">U.CBM</TableHead>
                <TableHead className="text-right">T.CBM</TableHead>
                <TableHead className="text-right">U.Weight</TableHead>
                <TableHead className="text-right">T.Weight</TableHead>
                <TableHead className="text-right">Unit Price</TableHead>
                <TableHead className="text-right">T.Amount</TableHead>
                <TableHead className="w-10" aria-hidden />
              </TableRow>
            </TableHeader>
            <TableBody>
              {footerLikeFiltered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={20} className="text-center text-slate-500 py-8">
                    No footer-like excluded lines for this document / search.
                  </TableCell>
                </TableRow>
              ) : (
                footerLikeFiltered.map((p, i) => (
                  <TableRow key={p.id} className="hover:bg-amber-100/60">
                    <TableCell className="text-center text-slate-500 font-mono text-[10px]">{i + 1}</TableCell>
                    <TableCell className="text-center p-1 text-slate-300">—</TableCell>
                    <TableCell className="p-1">
                      {p.image_url ? (
                        <img src={p.image_url} alt={p.name ?? ''} className="h-8 w-8 rounded object-cover border border-slate-100" />
                      ) : (
                        <div className="h-8 w-8 rounded bg-slate-100 flex items-center justify-center">
                          <ImageIcon className="h-3.5 w-3.5 text-slate-300" />
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Badge variant="outline" className="text-[10px] border-amber-300 text-amber-900 bg-amber-50">
                        {(p.manifest_section ?? '—').replace(/_/g, ' ')}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium text-slate-900 max-w-[180px] truncate">{p.name ?? '-'}</TableCell>
                    <TableCell className="text-slate-500 max-w-[160px] truncate">{p.description ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.order_no ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.customer_no ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.source_item_no ?? '-'}</TableCell>
                    <TableCell className="max-w-[100px] truncate">{p.shop_name ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.packing ?? '-'}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.cartons ?? '-'}</TableCell>
                    <TableCell className="text-right font-medium">{p.quantity} {p.unit}</TableCell>
                    <TableCell className="text-right">{p.unit_cbm != null ? Number(p.unit_cbm).toFixed(3) : '-'}</TableCell>
                    <TableCell className="text-right">{p.cbm != null ? Number(p.cbm).toFixed(4) : '-'}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">{p.unit_weight ?? '-'}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">{p.total_weight ?? '-'}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {p.cost_price > 0 ? `¥${fmt(p.cost_price)}` : '-'}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {p.total_amount_rmb != null ? `¥${fmt(p.total_amount_rmb)}` : '-'}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                ))
              )}
              {footerLikeFiltered.length > 0 && (
                <TableRow className="bg-amber-200 font-bold border-t-2 border-amber-500">
                  <TableCell colSpan={20} className="text-right text-slate-900">
                    {`FOOTER-LIKE EXCLUDED TOTALS: ${fmt(footerLikeTotals.cartons, 0)} CTNS | ${fmt(footerLikeTotals.cbm, 4)} CBM | ${fmt(footerLikeTotals.weight, 1)} KGS | ¥${fmt(footerLikeTotals.amount, 0)}`}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div> */}

      {/* Financial summary: PDF footer from selected document (document_totals), not global latest import. */}
      {selectedDocumentId === 'all' ? (
        <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Select a document in the dropdown above to show PDF footer totals (weight, CBM, cartons, cost) and
          payment lines for that file. The yellow bar in the table is the sum of compiled line items in the current
          view; with &quot;All PDFs / documents&quot; it can differ from any single document&apos;s footer.
        </div>
      ) : documentFooterLoading ? (
        <div className="rounded-md border bg-white px-3 py-2 text-xs text-slate-500">Loading document totals…</div>
      ) : documentFooterMeta ? (
        <div className="rounded-md border bg-white overflow-hidden text-xs">
          <div className="grid grid-cols-2 divide-x divide-slate-200">
            <table className="w-full">
              <tbody>
                <MetaRow label="TOTAL WEIGHT" value={documentFooterMeta.total_weight_kgs != null ? `${fmt(documentFooterMeta.total_weight_kgs, 1)} KGS` : '-'} />
                <MetaRow label="TOTAL CBM" value={documentFooterMeta.total_cbm != null ? `${fmt(documentFooterMeta.total_cbm, 1)} CBM` : '-'} />
                <MetaRow label="TOTAL CARTON" value={documentFooterMeta.total_carton != null ? `${fmt(documentFooterMeta.total_carton, 0)} CTN` : '-'} />
                <MetaRow
                  label="TOTAL COST"
                  value={
                    <>
                      {documentFooterMeta.total_cost_rmb != null && <span className="mr-3">¥{fmt(documentFooterMeta.total_cost_rmb, 2)} RMB</span>}
                      {documentFooterMeta.total_cost_usd != null && <span>${fmt(documentFooterMeta.total_cost_usd, 2)} USD</span>}
                      {documentFooterMeta.total_cost_rmb == null && documentFooterMeta.total_cost_usd == null && '-'}
                    </>
                  }
                />
              </tbody>
            </table>
            <table className="w-full">
              <tbody>
                {documentPaymentRows && documentPaymentRows.length > 0 ? (
                  <>
                    {documentPaymentRows.map((row, idx) => (
                      <MetaRow key={`${row.label}-${idx}`} label={row.label} value={row.value} highlight={row.highlight} />
                    ))}
                    {documentFooterMeta.goods_balance_usd != null && (
                      <MetaRow label="GOODS BALANCE" value={`$${fmt(documentFooterMeta.goods_balance_usd, 2)} USD`} />
                    )}
                    {documentFooterMeta.total_balance_usd != null && (
                      <MetaRow label="TOTAL BALANCE" value={`$${fmt(documentFooterMeta.total_balance_usd, 2)} USD`} highlight />
                    )}
                    {documentFooterMeta.exchange_rate != null && (
                      <MetaRow label="EXCHANGE RATE" value={`¥${fmt(documentFooterMeta.exchange_rate, 2)} RMB`} />
                    )}
                  </>
                ) : (
                  <>
                    {documentFooterMeta.payment_date != null && documentFooterMeta.payment_usd != null && (
                      <MetaRow label={`${documentFooterMeta.payment_date} PAYMENT`} value={`$${fmt(documentFooterMeta.payment_usd, 2)} USD`} />
                    )}
                    {documentFooterMeta.goods_balance_usd != null && (
                      <MetaRow label="GOODS BALANCE" value={`$${fmt(documentFooterMeta.goods_balance_usd, 2)} USD`} />
                    )}
                    {documentFooterMeta.credit_support_usd != null && (
                      <MetaRow label="CREDIT SUPPORT TO MOMBASA" value={`$${fmt(documentFooterMeta.credit_support_usd, 2)} USD`} />
                    )}
                    {documentFooterMeta.pivoc_usd != null && (
                      <MetaRow label="PIVOC" value={`$${fmt(documentFooterMeta.pivoc_usd, 2)} USD`} />
                    )}
                    {documentFooterMeta.freight_usd != null && (
                      <MetaRow label="YIWU-MOMBASA FREIGHT" value={`$${fmt(documentFooterMeta.freight_usd, 2)} USD`} />
                    )}
                    {documentFooterMeta.total_balance_usd != null && (
                      <MetaRow label="TOTAL BALANCE" value={`$${fmt(documentFooterMeta.total_balance_usd, 2)} USD`} highlight />
                    )}
                    {documentFooterMeta.exchange_rate != null && (
                      <MetaRow label="EXCHANGE RATE" value={`¥${fmt(documentFooterMeta.exchange_rate, 2)} RMB`} />
                    )}
                  </>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Could not load footer totals for this document (missing <code className="text-[10px]">document_totals</code> row or
          access error). Re-import the file or run totals reconciliation if your pipeline supports it.
        </div>
      )}

      {/* Export field-selector dialog */}
      <Dialog open={exportOpen} onOpenChange={v => !v && setExportOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Select fields to export&nbsp;
              <span className="text-slate-400 font-normal text-sm">
                ({exportFormat === 'excel' ? 'Excel' : 'PDF'})
              </span>
            </DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-2 py-2">
            {EXPORT_FIELDS.map(f => (
              <label key={f.key} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <Checkbox
                  checked={selectedFields.has(f.key)}
                  onCheckedChange={() => toggleField(f.key)}
                />
                {f.label}
              </label>
            ))}
          </div>

          <div className="flex justify-between items-center text-xs text-slate-400 pt-1">
            <span>
              {selectedFields.size} field{selectedFields.size !== 1 ? 's' : ''} selected
              {selectedDataRows.length > 0 ? ` · exporting ${selectedDataRows.length} selected row${selectedDataRows.length !== 1 ? 's' : ''}` : ''}
            </span>
            <div className="flex gap-2">
              <button className="underline" onClick={() => setSelectedFields(new Set(EXPORT_FIELDS.map(f => f.key)))}>
                All
              </button>
              <button className="underline" onClick={() => setSelectedFields(new Set())}>
                None
              </button>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setExportOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              className="bg-slate-900 hover:bg-slate-700"
              disabled={selectedFields.size === 0}
              onClick={runExport}
            >
              {exportFormat === 'excel' ? <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" /> : <FileText className="h-3.5 w-3.5 mr-1.5" />}
              Export {exportFormat === 'excel' ? 'Excel' : 'PDF'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function MetaRow({ label, value, highlight = false }: {
  label: string
  value: React.ReactNode
  highlight?: boolean
}) {
  return (
    <tr className={highlight ? 'bg-yellow-300 font-bold' : 'border-b border-slate-100'}>
      <td className="text-right pr-3 py-1.5 pl-4 text-slate-600 whitespace-nowrap w-1/2">{label}</td>
      <td className="pl-3 py-1.5 pr-4 text-slate-900 font-medium">{value}</td>
    </tr>
  )
}
