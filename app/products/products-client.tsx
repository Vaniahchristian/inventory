'use client'

import React, { useState, useTransition, useRef, useMemo } from 'react'
import { toast } from 'sonner'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Plus, Minus, Search, MoreHorizontal, Pencil, Trash2,
  Download, Upload, FileSpreadsheet, FileText, ImageIcon, AlertTriangle, Loader2,
} from 'lucide-react'
import { createProduct, updateProduct, deleteProduct, deleteAllProducts, importProducts, markOutOfStock, adjustProductCartons } from '@/app/actions/products'
import { exportProductsToExcel, exportProductsToPdf, parseImportFileDetailed } from '@/lib/export'
import { stockStatus } from '@/lib/utils'
import { isSectionDividerProduct, REPACKAGED_SECTION_TITLE, STAGE_TOTAL_MARKER_PREFIX, parseSectionMarkerTitle } from '@/lib/sections'
import type { Product, Category, Supplier, ImportMeta, ProductDocumentRef } from '@/lib/types'

type Props = {
  products: Product[]
  categories: Category[]
  suppliers: Supplier[]
  importMeta: ImportMeta | null
  productDocuments: ProductDocumentRef[]
}

const UNITS = ['pcs', 'kg', 'g', 'L', 'mL', 'box', 'bag', 'roll', 'pair', 'set', 'ctn']

function fmt(n: number | null | undefined, decimals = 2) {
  if (n == null) return '-'
  return n.toLocaleString('en-UG', { minimumFractionDigits: 0, maximumFractionDigits: decimals })
}

function parseWeight(w: string | null | undefined): number {
  return parseFloat((w ?? '0').replace(/[^\d.]/g, '')) || 0
}

function parseStageTotalValues(text: string) {
  const ctns = text.match(/(\d+)CTNS?/i)?.[1]
  const cbm = text.match(/([\d.]+)CBM/i)?.[1]
  const kgs = text.match(/([\d.]+)KGS/i)?.[1]
  const amountRaw = text.match(/[¥￥]([\d,]+(?:\.\d+)?)/)?.[1]
  return {
    cartons: ctns ? parseInt(ctns) : null,
    cbm: cbm ? parseFloat(cbm) : null,
    weight: kgs ? parseFloat(kgs) : null,
    amount: amountRaw ? parseFloat(amountRaw.replace(/,/g, '')) : null,
  }
}

export function ProductsClient({ products, categories, suppliers, importMeta, productDocuments }: Props) {
  const [editing, setEditing] = useState<Product | null>(null)
  const [adding, setAdding] = useState(false)
  const [isPending, startTransition] = useTransition()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [adjustingId, setAdjustingId] = useState<string | null>(null)
  const [selectedDocumentId, setSelectedDocumentId] = useState<string>('all')
  const [importStage, setImportStage] = useState<string | null>(null)
  const realProducts = useMemo(() => products.filter(p => !isSectionDividerProduct(p)), [products])
  const filtered = useMemo(() => {
    const queryTrimmed = query.trim().toLowerCase()
    const q = query.toLowerCase()
    return products.filter(p => {
      const passesDoc =
        selectedDocumentId === 'all' ||
        p.source_document_id === selectedDocumentId ||
        isSectionDividerProduct(p)
      if (!passesDoc) return false
      if (!queryTrimmed) return true
      return (
        isSectionDividerProduct(p) ||
        p.name?.toLowerCase().includes(q) ||
        p.sku?.toLowerCase().includes(q) ||
        p.shop_name?.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q) ||
        p.order_no?.toLowerCase().includes(q) ||
        p.customer_no?.toLowerCase().includes(q)
      )
    })
  }, [products, query, selectedDocumentId])
  const filteredDataRows = useMemo(() => filtered.filter(p => !isSectionDividerProduct(p)), [filtered])

  function importConsole(msg: string, meta?: unknown) {
    if (meta !== undefined) {
      console.log(`[products-import] ${msg}`, meta)
    } else {
      console.log(`[products-import] ${msg}`)
    }
  }

  async function handleMarkOutOfStock(id: string, name: string | null) {
    if (!confirm(`Mark "${name ?? 'this product'}" as out of stock? Cartons and quantity will be set to 0.`)) return
    startTransition(async () => {
      try {
        await markOutOfStock(id)
        toast.success('Marked as out of stock')
      } catch (e: any) {
        toast.error(e.message)
      }
    })
  }

  async function handleAdjustCartons(id: string, delta: number) {
    if (adjustingId) return
    setAdjustingId(id)
    try {
      await adjustProductCartons(id, delta)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setAdjustingId(null)
    }
  }

  const totals = useMemo(() => ({
    cartons: filteredDataRows.reduce((s, p) => s + (p.cartons ?? 0), 0),
    cbm: filteredDataRows.reduce((s, p) => s + (p.cbm ?? 0), 0),
    weight: filteredDataRows.reduce((s, p) => s + parseWeight(p.total_weight), 0),
    amount: filteredDataRows.reduce((s, p) => s + (p.total_amount_rmb ?? 0), 0),
  }), [filteredDataRows])

  function handleDelete(id: string, name: string | null) {
    if (!confirm(`Delete "${name ?? 'this product'}"? This cannot be undone.`)) return
    startTransition(async () => {
      try {
        await deleteProduct(id)
        toast.success('Product deleted')
      } catch (e: any) {
        toast.error(e.message)
      }
    })
  }

  function handleDeleteAll() {
    if (!products.length) return
    if (!confirm(`Delete ALL ${products.length} products? This cannot be undone.`)) return
    startTransition(async () => {
      try {
        await deleteAllProducts()
        toast.success(`Deleted ${products.length} products`)
      } catch (e: any) {
        toast.error(e.message)
      }
    })
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const startedAt = Date.now()
    const file = e.target.files?.[0]
    if (!file) return

    if (file.type.startsWith('image/')) {
      toast.info('To attach an image to a product, open the product and upload from the edit form.')
      e.target.value = ''
      return
    }

    try {
      importConsole('▶ import started', { file: file.name, size_bytes: file.size, type: file.type || 'unknown' })
      setImportStage(`Uploading and extracting ${file.name}...`)
      const { rows, importMeta } = await parseImportFileDetailed(file)
      importConsole('parseImportFileDetailed complete', {
        rows: rows.length,
        document_type: importMeta?.document_type ?? null,
        elapsed_ms: Date.now() - startedAt,
      })
      if (rows.length === 0) {
        throw new Error('No rows detected from file. If this is a PDF, re-export it as text-searchable PDF or CSV.')
      }
      setImportStage(`Saving ${rows.length} extracted rows...`)
      importConsole('importProducts start', { rows: rows.length })
      startTransition(async () => {
        try {
          const result = await importProducts(rows, importMeta)
          const count = typeof result === 'number' ? result : result.importedCount
          const llmAligned = typeof result === 'number' ? 0 : result.llmAligned
          const totalsMatch = typeof result === 'number' ? true : result.totalsMatch
          const totalsDiff = typeof result === 'number' ? null : result.totalsDiff
          if (llmAligned > 0) {
            toast.success(`Imported ${count} products (LLM aligned ${llmAligned} uncertain rows)`)
          } else {
            toast.success(`Imported ${count} products`)
          }
          if (!totalsMatch && totalsDiff) {
            toast.info(
              `PDF totals differ from imported totals: ΔCTN ${totalsDiff.cartons ?? 0}, ΔCBM ${totalsDiff.cbm ?? 0}, ΔKGS ${totalsDiff.weight ?? 0}, ΔRMB ${totalsDiff.amountRmb ?? 0}`
            )
          }
          importConsole('✓ importProducts complete', {
            imported: count,
            llm_aligned: llmAligned,
            totals_match: totalsMatch,
            totals_diff: totalsDiff,
            elapsed_ms: Date.now() - startedAt,
          })
        } catch (err: unknown) {
          toast.error(err instanceof Error ? err.message : 'Import failed')
          importConsole('✗ importProducts failed', {
            error: err instanceof Error ? err.message : 'Import failed',
            elapsed_ms: Date.now() - startedAt,
          })
        } finally {
          setImportStage(null)
        }
      })
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to parse file')
      importConsole('✗ import failed before save', {
        error: err instanceof Error ? err.message : 'Failed to parse file',
        elapsed_ms: Date.now() - startedAt,
      })
      setImportStage(null)
    }
    e.target.value = ''
  }


  return (
    <div className="p-6 space-y-4">
      {/* Header bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Products</h1>
          <p className="text-sm text-slate-500 mt-0.5">{realProducts.length} items total</p>
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
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv,.pdf,image/*"
            className="hidden"
            onChange={handleImport}
          />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="h-8 gap-1.5" />}>
              <Download className="h-3.5 w-3.5" /> Export
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => exportProductsToExcel(products)}>
                <FileSpreadsheet className="h-3.5 w-3.5 mr-2" /> Excel (.xlsx)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportProductsToPdf(products)}>
                <FileText className="h-3.5 w-3.5 mr-2" /> PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => fileInputRef.current?.click()}
            disabled={!!importStage}
          >
            {importStage ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Importing...
              </>
            ) : (
              <>
                <Upload className="h-3.5 w-3.5" /> Import
              </>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
            onClick={handleDeleteAll}
            disabled={isPending || products.length === 0}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete All
          </Button>
          <Button size="sm" className="h-8 gap-1.5 bg-slate-900 hover:bg-slate-700" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add Product
          </Button>
        </div>
      </div>

      {importStage && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
          <span>{importStage}</span>
        </div>
      )}

      {importMeta && (
        <div className="rounded-md border bg-amber-50 border-amber-200 px-3 py-2 text-xs flex flex-wrap gap-x-6 gap-y-0.5 items-center">
          <span className="font-semibold text-slate-800">CLIENT DETAILS: <span className="text-amber-800">{importMeta.client_details ?? '-'}</span></span>
          <span className="font-semibold text-slate-800">CONTAINER NO: <span className="text-amber-800">{importMeta.container_no ?? '-'}</span></span>
          <span className="text-slate-500 text-[10px] ml-auto">{importMeta.source_file_name}</span>
        </div>
      )}

      {/* Wide scrollable table */}
      <div className="rounded-md border bg-white overflow-x-auto">
        <Table className="text-xs min-w-[1200px]">
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead className="w-10 px-2" />
              <TableHead className="w-28">SKU / MARKS</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Order No</TableHead>
              <TableHead>CUS No</TableHead>
              <TableHead>Item No</TableHead>
              <TableHead>Shop / Supplier</TableHead>
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
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={22} className="text-center text-slate-400 py-10">
                  {importStage ? 'Import in progress... extracted rows will appear shortly.' : 'No products found.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(p => {
                if (isSectionDividerProduct(p)) {
                  const markerTitle = parseSectionMarkerTitle(p.sku)
                  const isStageTotal = !!p.sku?.startsWith(STAGE_TOTAL_MARKER_PREFIX)
                  if (isStageTotal && markerTitle) {
                    const tv = parseStageTotalValues(markerTitle)
                    return (
                      <TableRow key={p.id} className="bg-amber-100 hover:bg-amber-100 font-semibold border-t-2 border-amber-400">
                        <TableCell colSpan={22} className="text-center text-slate-800">
                          Stage Total
                          {tv.cartons != null ? ` | ${tv.cartons} CTNS` : ''}
                          {tv.cbm != null ? ` | ${tv.cbm.toFixed(3)} CBM` : ''}
                          {tv.weight != null ? ` | ${tv.weight.toFixed(1)} KGS` : ''}
                          {tv.amount != null ? ` | ¥${fmt(tv.amount, 0)}` : ''}
                        </TableCell>
                      </TableRow>
                    )
                  }
                  return (
                    <TableRow key={p.id} className="bg-yellow-200 hover:bg-yellow-200">
                      <TableCell colSpan={22} className="text-center py-2 tracking-wide font-semibold text-slate-800">
                        {markerTitle ?? REPACKAGED_SECTION_TITLE}
                      </TableCell>
                    </TableRow>
                  )
                }
                const status = stockStatus(p.quantity, p.reorder_level)
                const isZeroStock = (p.cartons ?? 0) === 0 || p.quantity === 0
                const rowClass = isZeroStock
                  ? 'bg-red-100 hover:bg-red-100'
                  : 'hover:bg-slate-50'
                return (
                  <TableRow key={p.id} className={rowClass}>
                    <TableCell className="p-1">
                      {p.image_url ? (
                        <img src={p.image_url} alt={p.name ?? ''} className="h-8 w-8 rounded object-cover border border-slate-100" />
                      ) : (
                        <div className="h-8 w-8 rounded bg-slate-100 flex items-center justify-center">
                          <ImageIcon className="h-3.5 w-3.5 text-slate-300" />
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono whitespace-nowrap">{p.sku ?? '-'}</TableCell>
                    <TableCell className="font-medium text-slate-900 max-w-[180px] truncate">{p.name ?? '-'}</TableCell>
                    <TableCell className="text-slate-500 max-w-[160px] truncate">{p.description ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.order_no ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.customer_no ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.source_item_no ?? '-'}</TableCell>
                    <TableCell className="max-w-[120px] truncate">{p.shop_name ?? p.suppliers?.name ?? '-'}</TableCell>
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
                    <TableCell className="text-right">{p.unit_cbm != null ? p.unit_cbm.toFixed(3) : '-'}</TableCell>
                    <TableCell className="text-right">{p.cbm != null ? p.cbm.toFixed(3) : '-'}</TableCell>
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
                    <TableCell>
                      {status !== 'ok' && (
                        <Badge
                          variant={status === 'out' ? 'destructive' : 'outline'}
                          className={status === 'low' ? 'border-amber-400 text-amber-700 bg-amber-50 text-[10px]' : 'text-[10px]'}
                        >
                          {status === 'out' ? 'Out' : 'Low'}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="h-7 w-7" />}>
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditing(p)}>
                            <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-amber-600"
                            onClick={() => handleMarkOutOfStock(p.id, p.name)}
                          >
                            <AlertTriangle className="h-3.5 w-3.5 mr-2" />
                            Mark Out of Stock
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
            {filteredDataRows.length > 0 && (
              <TableRow className="bg-yellow-300 font-bold border-t-2 border-yellow-500">
                <TableCell colSpan={22} className="text-right text-slate-900">
                  {`TOTALS: ${fmt(totals.cartons, 0)} CTNS | ${fmt(totals.cbm, 4)} CBM | ${fmt(totals.weight, 1)} KGS | ¥${fmt(totals.amount, 0)}`}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Financial summary — mirrors PDF bottom section */}
      {importMeta && (
        <div className="rounded-md border bg-white overflow-hidden text-xs">
          <div className="grid grid-cols-2 divide-x divide-slate-200">
            {/* Left: document-wide weight/volume/cost totals */}
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
            {/* Right: balance breakdown */}
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

      <ProductDialog
        open={adding || !!editing}
        product={editing}
        categories={categories}
        suppliers={suppliers}
        onClose={() => { setAdding(false); setEditing(null) }}
        isPending={isPending}
        onSubmit={(formData) => {
          startTransition(async () => {
            try {
              if (editing) {
                await updateProduct(editing.id, formData)
                toast.success('Product updated')
              } else {
                await createProduct(formData)
                toast.success('Product created')
              }
              setAdding(false)
              setEditing(null)
            } catch (e: any) {
              toast.error(e.message)
            }
          })
        }}
      />
    </div>
  )
}

function ProductDialog({
  open, product, categories, suppliers, onClose, onSubmit, isPending,
}: {
  open: boolean
  product: Product | null
  categories: Category[]
  suppliers: Supplier[]
  onClose: () => void
  onSubmit: (formData: FormData) => void
  isPending: boolean
}) {
  const [preview, setPreview] = useState<string | null>(product?.image_url ?? null)

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{product ? 'Edit Product' : 'Add Product'}</DialogTitle>
        </DialogHeader>
        <form action={onSubmit} className="space-y-3" encType="multipart/form-data">
          {/* Core */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" name="name" defaultValue={product?.name ?? ''} />
            <Field label="SKU / MARKS" name="sku" defaultValue={product?.sku ?? ''} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <SelectField label="Category" name="category_id" defaultValue={product?.category_id ?? ''}
              options={categories.map(c => ({ value: c.id, label: c.name }))} placeholder="None" />
            <SelectField label="Supplier" name="supplier_id" defaultValue={product?.supplier_id ?? ''}
              options={suppliers.map(s => ({ value: s.id, label: s.name ?? '' }))} placeholder="None" />
          </div>
          {/* Packing list fields */}
          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide pt-1">Packing List Data</p>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Shop / SHOP#" name="shop_name" defaultValue={product?.shop_name ?? ''} />
            <Field label="Packing" name="packing" defaultValue={product?.packing ?? ''} placeholder="e.g. 15pcs/ctn" />
            <Field label="Cartons (T.CTN)" name="cartons" type="number" defaultValue={String(product?.cartons ?? '')} />
          </div>
          <div className="grid grid-cols-5 gap-3">
            <SelectField label="Unit" name="unit" defaultValue={product?.unit ?? 'pcs'}
              options={UNITS.map(u => ({ value: u, label: u }))} placeholder="pcs" />
            <Field label="Qty (T.QTY)" name="quantity" type="number" defaultValue={String(product?.quantity ?? 0)} />
            <Field label="U.CBM" name="unit_cbm" type="number" step="0.0001" defaultValue={String(product?.unit_cbm ?? '')} />
            <Field label="T.CBM" name="cbm" type="number" step="0.0001" defaultValue={String(product?.cbm ?? '')} />
            <Field label="Reorder Level" name="reorder_level" type="number" defaultValue={String(product?.reorder_level ?? 0)} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Unit Weight" name="unit_weight" defaultValue={product?.unit_weight ?? ''} placeholder="e.g. 15.8KGS" />
            <Field label="Total Weight (T.WEIGHT)" name="total_weight" defaultValue={product?.total_weight ?? ''} placeholder="e.g. 142.2KGS" />
            <Field label="Unit Price ¥ (RMB)" name="cost_price" type="number" step="0.01" defaultValue={String(product?.cost_price ?? '')} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Total Amount ¥ (T.AMOUNT)" name="total_amount_rmb" type="number" step="0.01" defaultValue={String(product?.total_amount_rmb ?? '')} />
            <Field label="Selling Price" name="selling_price" type="number" step="0.01" defaultValue={String(product?.selling_price ?? '')} />
          </div>
          <div>
            <Label className="text-xs text-slate-600 mb-1 block">Description</Label>
            <Textarea name="description" defaultValue={product?.description ?? ''} rows={2} className="text-sm resize-none" />
          </div>
          {/* Image */}
          <div>
            <Label className="text-xs text-slate-600 mb-1 block">Product Image (optional)</Label>
            {preview && <img src={preview} alt="preview" className="h-20 w-20 object-cover rounded border border-slate-200 mb-2" />}
            <Input name="image" type="file" accept="image/*" className="h-8 text-sm"
              onChange={e => { const f = e.target.files?.[0]; if (f) setPreview(URL.createObjectURL(f)) }} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" disabled={isPending} className="bg-slate-900 hover:bg-slate-700">
              {isPending ? 'Saving…' : product ? 'Save Changes' : 'Create Product'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, name, type = 'text', defaultValue, step, placeholder }: {
  label: string; name: string; type?: string; defaultValue?: string; step?: string; placeholder?: string
}) {
  return (
    <div>
      <Label className="text-xs text-slate-600 mb-1 block">{label}</Label>
      <Input name={name} type={type} defaultValue={defaultValue} step={step} placeholder={placeholder} className="h-8 text-sm" />
    </div>
  )
}

function SelectField({ label, name, defaultValue, options, placeholder }: {
  label: string; name: string; defaultValue: string; options: { value: string; label: string }[]; placeholder: string
}) {
  return (
    <div>
      <Label className="text-xs text-slate-600 mb-1 block">{label}</Label>
      <Select name={name} defaultValue={defaultValue || undefined}>
        <SelectTrigger className="h-8 text-sm">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map(o => <SelectItem key={o.value} value={o.value} className="text-sm">{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
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
