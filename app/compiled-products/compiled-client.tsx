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
import { deleteDocumentItem, adjustDocumentItemCartons } from '@/app/actions/products'
import { isSectionDividerProduct, REPACKAGED_SECTION_TITLE } from '@/lib/sections'
import type { Product, ImportMeta, ProductDocumentRef } from '@/lib/types'

type Props = {
  products: Product[]
  importMeta: ImportMeta | null
  productDocuments: ProductDocumentRef[]
}

type CompiledRow = Product & { _variants: number; _rowNo: number }
type DividerRow = { _isDivider: true; id: string; title: string }
type CompiledDisplayRow = CompiledRow | DividerRow

/**
 * Build a merge base name.
 * Primary rule: if the first three words exist, use them as the grouping base.
 * Fallback: stop at model-code-ish tokens or CJK suffixes.
 */
function extractBaseName(name: string): string {
  const words = name.trim().split(/\s+/)
  if (words.length >= 3) {
    return `${words[0]} ${words[1]} ${words[2]}`
  }
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

// Strip CJK characters — jsPDF's built-in fonts can't render them and produce garbled boxes
function cjkSafe(text: string): string {
  return text.replace(/[\u2e80-\u2eff\u3000-\u9fff\uf900-\ufaff\ufe30-\ufe4f]/g, '').replace(/\s+/g, ' ').trim() || '-'
}

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

  const ws = XLSX.utils.aoa_to_sheet([header, ...data])
  ws['!cols'] = [{ wch: 5 }, ...fieldDefs.map(() => ({ wch: 22 }))]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Compiled Products')
  XLSX.writeFile(wb, `compiled_products_${Date.now()}.xlsx`)
}

// ── PDF export ──────────────────────────────────────────────────────────────

async function exportToPdf(rows: CompiledRow[], selectedFields: FieldKey[], importMeta: ImportMeta | null) {
  const { default: jsPDF } = await import('jspdf')
  const { default: autoTable } = await import('jspdf-autotable')

  const doc = new jsPDF({ orientation: 'landscape', format: 'a3' })
  const fieldDefs = EXPORT_FIELDS.filter(f => selectedFields.includes(f.key))

  doc.setFontSize(13)
  doc.text('Compiled Products', 14, 14)
  if (importMeta) {
    doc.setFontSize(8)
    doc.text(
      `Client: ${importMeta.client_details ?? '-'}   Container: ${importMeta.container_no ?? '-'}   ${rows.length} items`,
      14, 20,
    )
  }

  autoTable(doc, {
    startY: 26,
    head: [['No.', ...fieldDefs.map(f => f.label)]],
    body: rows.map((row, i) => [i + 1, ...fieldDefs.map(f => cjkSafe(getCellValue(row, f.key)))]),
    styles: { fontSize: 7, cellPadding: 1.5, overflow: 'linebreak' },
    headStyles: { fillColor: [30, 41, 59], fontSize: 7, cellPadding: 2 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { cellWidth: 10 },
      ...Object.fromEntries(fieldDefs.map((_, i) => [i + 1, { cellWidth: 'auto' as const }])),
    },
  })

  doc.save(`compiled_products_${Date.now()}.pdf`)
}

// ── Component ───────────────────────────────────────────────────────────────

export function CompiledProductsClient({ products, importMeta, productDocuments }: Props) {
  const [query, setQuery] = useState('')
  const [selectedDocumentId, setSelectedDocumentId] = useState<string>('all')
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

  const compiledRows = useMemo<CompiledRow[]>(() => {
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
        // Merge conditions:
        // 1) same base name + packing (when packing exists)
        // 2) same base name + quantity (when packing is missing but quantity exists)
        // 3) same base name only (when both packing and quantity are missing/zero; carton-only lines)
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

      const numbered = [...map.values()]
      singles.forEach(s => { s._rowNo = rowNo++ })
      const data = [...numbered, ...singles]
        .filter(p => !((p.cartons ?? 0) === 0 && p.quantity === 0))
        .sort((a, b) => {
          const nameCmp = (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' })
          if (nameCmp !== 0) return nameCmp
          const packingCmp = (a.packing ?? '').localeCompare(b.packing ?? '', undefined, { sensitivity: 'base' })
          if (packingCmp !== 0) return packingCmp
          return (a.sku ?? '').localeCompare(b.sku ?? '', undefined, { sensitivity: 'base' })
        })
      return { data, nextRowNo: rowNo }
    }

    const dividerIdx = visibleProducts.findIndex(p => isSectionDividerProduct(p))
    const normalSource = (dividerIdx >= 0 ? visibleProducts.slice(0, dividerIdx) : visibleProducts).filter(p => !isSectionDividerProduct(p))
    const repackedSource = dividerIdx >= 0 ? visibleProducts.slice(dividerIdx + 1).filter(p => !isSectionDividerProduct(p)) : []

    const normal = compileSection(normalSource, 1)
    const repacked = compileSection(repackedSource, normal.nextRowNo)
    return [...normal.data, ...repacked.data]
  }, [visibleProducts])

  const compiled = useMemo<CompiledDisplayRow[]>(() => {
    const dividerIdx = visibleProducts.findIndex(p => isSectionDividerProduct(p))
    if (dividerIdx < 0) return compiledRows

    const normalSourceCount = visibleProducts.slice(0, dividerIdx).filter(p => !isSectionDividerProduct(p)).length
    const normalCount = Math.min(normalSourceCount, compiledRows.length)
    const normal = compiledRows.slice(0, normalCount)
    const repacked = compiledRows.slice(normalCount)
    if (normal.length === 0 || repacked.length === 0) return compiledRows

    return [
      ...normal,
      { _isDivider: true, id: 'compiled-repackaged-divider', title: REPACKAGED_SECTION_TITLE },
      ...repacked,
    ]
  }, [compiledRows, visibleProducts])

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
    const rows = filteredDataRows.length < compiledRows.length ? filteredDataRows : compiledRows
    if (exportFormat === 'excel') exportToExcel(rows, fields, importMeta)
    else exportToPdf(rows, fields, importMeta)
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

      {/* Client / container banner */}
      {importMeta && (
        <div className="rounded-md border bg-amber-50 border-amber-200 px-3 py-2 text-xs flex flex-wrap gap-x-6 gap-y-0.5 items-center">
          <span className="font-semibold text-slate-800">
            CLIENT DETAILS: <span className="text-amber-800">{importMeta.client_details ?? '-'}</span>
          </span>
          <span className="font-semibold text-slate-800">
            CONTAINER NO: <span className="text-amber-800">{importMeta.container_no ?? '-'}</span>
          </span>
          <span className="text-slate-500 text-[10px] ml-auto">{importMeta.source_file_name}</span>
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
              <TableHead className="text-right">L</TableHead>
              <TableHead className="text-right">W</TableHead>
              <TableHead className="text-right">H</TableHead>
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
                <TableCell colSpan={23} className="text-center text-slate-400 py-10">
                  No products found.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((p, i) => {
                if ('_isDivider' in p) {
                  return (
                    <TableRow key={p.id} className="bg-yellow-200 hover:bg-yellow-200">
                      <TableCell colSpan={23} className="text-center font-semibold text-slate-800 py-2 tracking-wide">
                        {p.title}
                      </TableCell>
                    </TableRow>
                  )
                }
                const isZeroStock = (p.cartons ?? 0) === 0 && p.quantity === 0
                const isMarkedOutOfStock = !isZeroStock && outOfStockIds.has(p.id)
                const rowClass = isZeroStock
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
                    <TableCell className="text-right">{p.dim_l_cm != null ? Number(p.dim_l_cm).toFixed(1) : '-'}</TableCell>
                    <TableCell className="text-right">{p.dim_w_cm != null ? Number(p.dim_w_cm).toFixed(1) : '-'}</TableCell>
                    <TableCell className="text-right">{p.dim_h_cm != null ? Number(p.dim_h_cm).toFixed(1) : '-'}</TableCell>
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
                <TableCell colSpan={23} className="text-right text-emerald-900">
                  {`SELECTED TOTALS: ${fmt(selectedTotals.cartons, 0)} CTNS | ${fmt(selectedTotals.cbm, 4)} CBM | ${fmt(selectedTotals.weight, 1)} KGS | ¥${fmt(selectedTotals.amount, 0)}`}
                </TableCell>
              </TableRow>
            )}
            {filteredDataRows.length > 0 && (
              <TableRow className="bg-yellow-300 font-bold border-t-2 border-yellow-500">
                <TableCell colSpan={23} className="text-right text-slate-900">
                  {`TOTALS: ${fmt(totals.cartons, 0)} CTNS | ${fmt(totals.cbm, 4)} CBM | ${fmt(totals.weight, 1)} KGS | ¥${fmt(totals.amount, 0)}`}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Financial summary */}
      {importMeta && (
        <div className="rounded-md border bg-white overflow-hidden text-xs">
          <div className="grid grid-cols-2 divide-x divide-slate-200">
            <table className="w-full">
              <tbody>
                <MetaRow label="TOTAL WEIGHT" value={importMeta.total_weight_kgs != null ? `${fmt(importMeta.total_weight_kgs, 1)} KGS` : '-'} />
                <MetaRow label="TOTAL CBM" value={importMeta.total_cbm != null ? `${fmt(importMeta.total_cbm, 1)} CBM` : '-'} />
                <MetaRow label="TOTAL CARTON" value={importMeta.total_carton != null ? `${fmt(importMeta.total_carton, 0)} CTN` : '-'} />
                <MetaRow
                  label="TOTAL COST"
                  value={
                    <>
                      {importMeta.total_cost_rmb != null && <span className="mr-3">¥{fmt(importMeta.total_cost_rmb, 2)} RMB</span>}
                      {importMeta.total_cost_usd != null && <span>${fmt(importMeta.total_cost_usd, 2)} USD</span>}
                    </>
                  }
                />
              </tbody>
            </table>
            <table className="w-full">
              <tbody>
                {importMeta.payment_date != null && importMeta.payment_usd != null && (
                  <MetaRow label={`${importMeta.payment_date} PAYMENT`} value={`$${fmt(importMeta.payment_usd, 2)} USD`} />
                )}
                {importMeta.goods_balance_usd != null && (
                  <MetaRow label="GOODS BALANCE" value={`$${fmt(importMeta.goods_balance_usd, 2)} USD`} />
                )}
                {importMeta.credit_support_usd != null && (
                  <MetaRow label="CREDIT SUPPORT TO MOMBASA" value={`$${fmt(importMeta.credit_support_usd, 2)} USD`} />
                )}
                {importMeta.pivoc_usd != null && (
                  <MetaRow label="PIVOC" value={`$${fmt(importMeta.pivoc_usd, 2)} USD`} />
                )}
                {importMeta.freight_usd != null && (
                  <MetaRow label="YIWU-MOMBASA FREIGHT" value={`$${fmt(importMeta.freight_usd, 2)} USD`} />
                )}
                {importMeta.total_balance_usd != null && (
                  <MetaRow label="TOTAL BALANCE" value={`$${fmt(importMeta.total_balance_usd, 2)} USD`} highlight />
                )}
                {importMeta.exchange_rate != null && (
                  <MetaRow label="EXCHANGE RATE" value={`¥${fmt(importMeta.exchange_rate, 2)} RMB`} />
                )}
              </tbody>
            </table>
          </div>
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
            <span>{selectedFields.size} field{selectedFields.size !== 1 ? 's' : ''} selected</span>
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
