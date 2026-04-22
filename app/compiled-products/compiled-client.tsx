'use client'

import React, { useMemo, useState } from 'react'
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
import { Label } from '@/components/ui/label'
import { Search, ImageIcon, Download, FileSpreadsheet, FileText } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Product, ImportMeta } from '@/lib/types'

type Props = {
  products: Product[]
  importMeta: ImportMeta | null
}

type CompiledRow = Product & { _variants: number; _rowNo: number }

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

export function CompiledProductsClient({ products, importMeta }: Props) {
  const [query, setQuery] = useState('')
  const [exportOpen, setExportOpen] = useState(false)
  const [exportFormat, setExportFormat] = useState<'excel' | 'pdf'>('excel')
  const [selectedFields, setSelectedFields] = useState<Set<FieldKey>>(
    () => new Set(EXPORT_FIELDS.filter(f => f.defaultOn).map(f => f.key))
  )

  const compiled = useMemo<CompiledRow[]>(() => {
    const map = new Map<string, CompiledRow>()
    const singles: CompiledRow[] = []
    let rowNo = 1

    for (const p of products) {
      if (!p.name || !p.packing) {
        singles.push({ ...p, _variants: 1, _rowNo: 0 })
        continue
      }
      const key = `${p.name.trim().toLowerCase()}||${p.packing.trim().toLowerCase()}`
      const existing = map.get(key)
      if (!existing) {
        map.set(key, { ...p, _variants: 1, _rowNo: rowNo++ })
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
    return [...numbered, ...singles]
  }, [products])

  const filtered = useMemo(() => {
    if (!query.trim()) return compiled
    const q = query.toLowerCase()
    return compiled.filter(
      p =>
        p.name?.toLowerCase().includes(q) ||
        p.sku?.toLowerCase().includes(q) ||
        p.shop_name?.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q),
    )
  }, [compiled, query])

  const totals = useMemo(() => ({
    cartons: filtered.reduce((s, p) => s + (p.cartons ?? 0), 0),
    cbm: filtered.reduce((s, p) => s + (p.cbm ?? 0), 0),
    weight: filtered.reduce((s, p) => s + parseWeight(p.total_weight), 0),
    amount: filtered.reduce((s, p) => s + (p.total_amount_rmb ?? 0), 0),
  }), [filtered])

  function toggleField(key: FieldKey) {
    setSelectedFields(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function openExport(format: 'excel' | 'pdf') {
    setExportFormat(format)
    setExportOpen(true)
  }

  function runExport() {
    const fields = EXPORT_FIELDS.map(f => f.key).filter(k => selectedFields.has(k))
    if (fields.length === 0) return
    const rows = filtered.length < compiled.length ? filtered : compiled
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
            {compiled.length} unique items (from {products.length} total)
          </p>
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
              <TableHead className="w-10 px-2" />
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
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
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={15} className="text-center text-slate-400 py-10">
                  No products found.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((p, i) => (
                <TableRow key={`${p.id}-${i}`} className="hover:bg-slate-50">
                  <TableCell className="text-center text-slate-400 font-mono text-[10px]">{i + 1}</TableCell>
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
                  <TableCell className="max-w-[100px] truncate">{p.shop_name ?? '-'}</TableCell>
                  <TableCell className="whitespace-nowrap">{p.packing ?? '-'}</TableCell>
                  <TableCell className="text-right">{p.cartons ?? '-'}</TableCell>
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
                </TableRow>
              ))
            )}

            {filtered.length > 0 && (
              <TableRow className="bg-yellow-300 font-bold border-t-2 border-yellow-500">
                <TableCell /><TableCell /><TableCell /><TableCell /><TableCell /><TableCell /><TableCell />
                <TableCell className="text-right text-slate-900">
                  {`${fmt(totals.cartons, 0)} CTNS`}
                </TableCell>
                <TableCell />
                <TableCell />
                <TableCell className="text-right text-slate-900">
                  {`${fmt(totals.cbm, 4)} CBM`}
                </TableCell>
                <TableCell />
                <TableCell className="text-right text-slate-900">
                  {`${fmt(totals.weight, 1)} KGS`}
                </TableCell>
                <TableCell />
                <TableCell className="text-right text-slate-900">
                  {`¥${fmt(totals.amount, 0)}`}
                </TableCell>
                <TableCell />
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
