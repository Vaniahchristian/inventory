'use client'

import React, { useState, useTransition, useRef, useMemo, useEffect, useCallback } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Search, Trash2, Upload, Loader2, MoreHorizontal, Pencil, AlertTriangle, Plus, Minus, Download, FileSpreadsheet, FileText,
} from 'lucide-react'
import {
  getDocumentImportMeta,
  deleteDocumentItem,
  deleteDocumentsByDocument,
  deleteAllDocumentItems,
  deleteDocumentItemsBySection,
  deleteDocumentFooterItems,
  adjustDocumentItemCartons,
  markDocumentItemOutOfStock,
  updateDocumentItem,
  importProducts,
  type DocumentFooterPaymentRow,
} from '@/app/actions/products'
import type { DocumentItemsPageStats } from '@/lib/products-list'
import { importPdfDirect } from '@/lib/export'
import { useImportStore } from '@/lib/import-store'
import { shouldPublishExtractedProduct } from '@/lib/sections'
import type { DocumentItem, ImportMeta, ProductDocumentRef } from '@/lib/types'

type Props = {
  items: DocumentItem[]
  importMeta: ImportMeta | null
  productDocuments: ProductDocumentRef[]
  listStats: DocumentItemsPageStats
  globalStats: DocumentItemsPageStats
  docScopeStats: DocumentItemsPageStats | null
  footerRows: DocumentItem[]
  initialQ: string
  initialDoc: string
}

function fmtN(n: number | null | undefined, dec = 2): string {
  if (n == null) return '-'
  const v = typeof n === 'string' ? parseFloat(n) : n
  if (!isFinite(v)) return '-'
  return v.toLocaleString('en-UG', { minimumFractionDigits: 0, maximumFractionDigits: dec })
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return '-'
  const v = typeof n === 'string' ? parseFloat(n) : n
  if (!isFinite(v)) return '-'
  return `¥${v.toLocaleString('en-UG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

/** Label for the latest document per file name (see getDocumentItemDocuments). */
function documentSelectLabel(doc: ProductDocumentRef): string {
  const name = (doc.source_file_name ?? 'Document').trim() || 'Document'
  const short = name.length > 52 ? `${name.slice(0, 50)}…` : name
  if (!doc.created_at) return short
  try {
    const d = new Date(doc.created_at)
    if (!isFinite(d.getTime())) return short
    const when = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    return `${short} — ${when}`
  } catch {
    return short
  }
}

function boxLabel(start: number | null, end: number | null): string {
  if (start == null) return '-'
  if (end != null && end !== start) return `${start}–${end}`
  return String(start)
}

/** Detects financial summary / footer rows saved in older imports (now filtered at parse time). */
function isFooterLikeItem(p: DocumentItem): boolean {
  const combined = [p.marks ?? '', p.description ?? '', p.item_code ?? '', p.shop ?? '']
    .join(' ').toUpperCase()
  // Standard totals
  if (/\bTOTAL\s+(WEIGHT|CBM|CARTON|COST|BALANCE)\b/.test(combined)) return true
  // Balance line items
  if (/\b(GOODS\s+BALANCE|CREDIT\s+SUPPORT|PIVOC|EXCHANGE\s+RATE)\b/.test(combined)) return true
  // Freight
  if (/YIWU.{0,10}MOMBASA.{0,10}FREIGHT/i.test(combined)) return true
  // Payment rows (date + PAYMENT keyword)
  if (/\bPAYMENT\b/.test(combined) && /\d{1,2}\/\d{1,2}\/\d{4}/.test(combined)) return true
  // Payment with USD but no pcs/ctn
  if (/\bPAYMENT\b/.test(combined) && /USD/.test(combined) && !/\bPCS\/CTN\b/.test(combined)) return true
  // Payment terms body text
  if (/IF\s+OUTSTANDING\s+BALANCE\s+IS\s+NOT\s+PAID/i.test(combined)) return true
  if (/PAYMENT\s+DELAY\s+SURCHARGE/i.test(combined)) return true
  if (/VESSEL\s+ARRIVAL\s+MOMBASA/i.test(combined)) return true
  if (/BALANCE\s+PAYMENT\s+TERMS/i.test(combined)) return true
  // Reduce notes after TOTAL CARTON
  if (/REDUCE\s+DETAILS/i.test(combined)) return true
  if (/REDUCE\s+\d+\s*CTN/i.test(combined)) return true
  return false
}

function isStuffedBannerItem(p: DocumentItem): boolean {
  const text = [p.marks ?? '', p.item_code ?? '', p.description ?? '', p.shop ?? '', p.packaging ?? '']
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
  if (!text) return false
  if (!text.includes('STUFFED INTO THIS CO') && !text.includes('STUFFED INTO THIS CONTAINER')) return false
  const hasNoNumericPayload =
    (p.total_cartons ?? 0) <= 0 &&
    (p.total_quantity ?? 0) <= 0 &&
    (p.total_cbm ?? 0) <= 0 &&
    (p.total_weight_kg ?? 0) <= 0 &&
    (p.total_amount_rmb ?? 0) <= 0
  return hasNoNumericPayload
}

function isCarryoverBeforeGoodsItem(p: DocumentItem): boolean {
  return (p.remarks ?? '').toLowerCase().includes('carryover:before_goods')
}

function rowMatchesSearch(p: DocumentItem, qLower: string): boolean {
  if (!qLower) return true
  const docName =
    p.documents && typeof p.documents === 'object' && 'source_file_name' in p.documents
      ? String((p.documents as { source_file_name?: string | null }).source_file_name ?? '')
      : ''
  return (
    p.marks?.toLowerCase().includes(qLower) ||
    p.item_code?.toLowerCase().includes(qLower) ||
    p.description?.toLowerCase().includes(qLower) ||
    p.shop?.toLowerCase().includes(qLower) ||
    docName.toLowerCase().includes(qLower)
  )
}

const SECTION_RENDER_ORDER: DocumentItem['section'][] = ['shipped', 'left_in_warehouse', 'repacked']

const SECTION_LABELS: Record<DocumentItem['section'], string> = {
  shipped: 'Shipped',
  left_in_warehouse: 'Left in Warehouse',
  repacked: 'Repacked',
}

const SECTION_SUBTOTAL_STYLE: Record<DocumentItem['section'], string> = {
  shipped: 'bg-yellow-200 border-t-2 border-yellow-500 font-semibold',
  left_in_warehouse: 'bg-sky-200 border-t-2 border-sky-500 font-semibold',
  repacked: 'bg-violet-200 border-t-2 border-violet-500 font-semibold',
}

function sectionClass(section: DocumentItem['section']): string {
  if (section === 'left_in_warehouse') return 'bg-sky-50 hover:bg-sky-100'
  if (section === 'repacked') return 'bg-violet-50 hover:bg-violet-100'
  return 'hover:bg-slate-50'
}

function SectionBadge({ section }: { section: DocumentItem['section'] }) {
  if (section === 'left_in_warehouse')
    return <Badge variant="outline" className="text-[10px] border-sky-300 text-sky-700 bg-sky-50">left</Badge>
  if (section === 'repacked')
    return <Badge variant="outline" className="text-[10px] border-violet-300 text-violet-700 bg-violet-50">repacked</Badge>
  return <Badge variant="outline" className="text-[10px] border-emerald-300 text-emerald-700 bg-emerald-50">shipped</Badge>
}

async function exportDocumentItemsToExcel(rows: DocumentItem[]) {
  const XLSX = await import('xlsx')
  const header = ['No.', 'Marks', 'Shop', 'Item No', 'Description', 'Packing', 'CTN', 'Qty', 'L', 'W', 'H', 'U.CBM', 'T.CBM', 'U.Wkg', 'T.Wkg', 'U.Price (RMB)', 'Amount (RMB)', 'Section']
  const data = rows.map((p, i) => [
    i + 1,
    p.marks ?? '-',
    p.shop ?? '-',
    p.item_code ?? '-',
    p.description ?? '-',
    p.packaging ?? '-',
    p.total_cartons ?? 0,
    p.total_quantity ?? 0,
    p.dim_l_cm ?? null,
    p.dim_w_cm ?? null,
    p.dim_h_cm ?? null,
    p.unit_cbm ?? null,
    p.total_cbm ?? null,
    p.unit_weight_kg ?? null,
    p.total_weight_kg ?? null,
    p.unit_price_rmb ?? null,
    p.total_amount_rmb ?? null,
    p.section,
  ])
  const ws = XLSX.utils.aoa_to_sheet([header, ...data])
  ws['!cols'] = header.map((_, idx) => ({ wch: idx === 0 ? 5 : 16 }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Products')
  XLSX.writeFile(wb, `products_${Date.now()}.xlsx`)
}

async function exportDocumentItemsToPdf(rows: DocumentItem[]) {
  const { default: jsPDF } = await import('jspdf')
  const { default: autoTable } = await import('jspdf-autotable')
  const doc = new jsPDF({ orientation: 'landscape', format: 'a3' })
  doc.setFontSize(13)
  doc.text('Products', 14, 14)
  autoTable(doc, {
    startY: 20,
    head: [['No.', 'Marks', 'Shop', 'Item No', 'Description', 'Packing', 'CTN', 'Qty', 'T.CBM', 'T.Wkg', 'Amount (RMB)', 'Section']],
    body: rows.map((p, i) => [
      i + 1,
      p.marks ?? '-',
      p.shop ?? '-',
      p.item_code ?? '-',
      p.description ?? '-',
      p.packaging ?? '-',
      p.total_cartons ?? 0,
      p.total_quantity ?? 0,
      p.total_cbm ?? '-',
      p.total_weight_kg ?? '-',
      p.total_amount_rmb ?? '-',
      p.section,
    ]),
    styles: { fontSize: 7, cellPadding: 1.5, overflow: 'linebreak' },
    headStyles: { fillColor: [30, 41, 59], fontSize: 7, cellPadding: 2 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
  })
  doc.save(`products_${Date.now()}.pdf`)
}

export function ProductsClient({
  items,
  importMeta,
  productDocuments,
  listStats,
  globalStats,
  docScopeStats,
  footerRows,
  initialQ,
  initialDoc,
}: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const selectedDocumentId = initialDoc

  const [queryInput, setQueryInput] = useState(initialQ)
  useEffect(() => {
    setQueryInput(initialQ)
  }, [initialQ])

  useEffect(() => {
    const t = window.setTimeout(() => {
      const trimmed = queryInput.trim()
      const cur = (searchParams.get('q') ?? '').trim()
      if (trimmed === cur) return
      const params = new URLSearchParams(searchParams.toString())
      if (trimmed) params.set('q', trimmed)
      else params.delete('q')
      params.set('page', '1')
      router.replace(`${pathname}?${params.toString()}`)
    }, 400)
    return () => clearTimeout(t)
  }, [queryInput, pathname, router, searchParams])

  const pushListUrl = useCallback((patch: Record<string, string | null | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === '') params.delete(k)
      else params.set(k, v)
    }
    router.replace(`${pathname}?${params.toString()}`)
  }, [pathname, router, searchParams])

  const [editingItem, setEditingItem] = useState<DocumentItem | null>(null)
  const [adjustingId, setAdjustingId] = useState<string | null>(null)
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set())
  const [footerMeta, setFooterMeta] = useState<ImportMeta | null>(importMeta)
  const [footerPaymentRows, setFooterPaymentRows] = useState<DocumentFooterPaymentRow[] | null>(null)
  const [isPending, startTransition] = useTransition()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { status: importStatus, progress: importProgress, stage: importStage, startImport, updateProgress, finishImport, failImport } = useImportStore()

  useEffect(() => {
    if (selectedDocumentId === 'all') {
      setFooterMeta(importMeta)
      setFooterPaymentRows(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const bundle = await getDocumentImportMeta(selectedDocumentId)
        if (cancelled) return
        if (bundle) {
          setFooterMeta(bundle.meta)
          setFooterPaymentRows(bundle.paymentRows.length > 0 ? bundle.paymentRows : null)
        } else {
          setFooterMeta(null)
          setFooterPaymentRows(null)
        }
      } catch {
        if (!cancelled) { setFooterMeta(null); setFooterPaymentRows(null) }
      }
    })()
    return () => { cancelled = true }
  }, [selectedDocumentId, importMeta])

  const sectionCounts = listStats.sectionCounts
  const totals = listStats.totals

  const mainRows = useMemo(
    () => items.filter(p => !isFooterLikeItem(p)),
    [items]
  )

  const footerMerged = useMemo(() => {
    const ids = new Set(footerRows.map(r => r.id))
    const extra = items.filter(p => isFooterLikeItem(p) && !ids.has(p.id))
    return [...footerRows, ...extra]
  }, [footerRows, items])

  const footerItems = useMemo(() => {
    const qLower = initialQ.trim().toLowerCase()
    if (!qLower) return footerMerged
    return footerMerged.filter(p => rowMatchesSearch(p, qLower))
  }, [footerMerged, initialQ])

  const selectableRows = useMemo(
    () => mainRows.filter(p => !isStuffedBannerItem(p)),
    [mainRows]
  )

  const selectedRows = useMemo(
    () => selectableRows.filter(p => selectedRowIds.has(p.id)),
    [selectableRows, selectedRowIds]
  )

  const selectedTotals = useMemo(() => ({
    cartons: selectedRows.reduce((s, p) => s + (p.total_cartons ?? 0), 0),
    qty: selectedRows.reduce((s, p) => s + (p.total_quantity ?? 0), 0),
    cbm: selectedRows.reduce((s, p) => s + (p.total_cbm ?? 0), 0),
    weight: selectedRows.reduce((s, p) => s + (p.total_weight_kg ?? 0), 0),
    amount: selectedRows.reduce((s, p) => s + (p.total_amount_rmb ?? 0), 0),
  }), [selectedRows])

  useEffect(() => {
    const visibleIds = new Set(selectableRows.map(p => p.id))
    setSelectedRowIds(prev => {
      const next = new Set([...prev].filter(id => visibleIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [selectableRows])

  const allVisibleSelected = selectableRows.length > 0 && selectableRows.every(p => selectedRowIds.has(p.id))

  const footerGrandTotals = useMemo(() => {
    if (selectedDocumentId === 'all' || !footerMeta) return null
    return {
      cartons: footerMeta.total_carton ?? null,
      qty: null as number | null,
      cbm: footerMeta.total_cbm ?? null,
      weight: footerMeta.total_weight_kgs ?? null,
      amount: footerMeta.total_cost_rmb ?? null,
    }
  }, [selectedDocumentId, footerMeta])

  const multiSection = useMemo(() => {
    const c = listStats.sectionCounts
    return [c.shipped, c.left_in_warehouse, c.repacked].filter(n => n > 0).length > 1
  }, [listStats.sectionCounts])

  const groupedSections = useMemo(() =>
    SECTION_RENDER_ORDER.flatMap(sectionKey => {
      const rows = mainRows.filter(p => p.section === sectionKey)
      if (rows.length === 0) return []
      const subtotalRows = rows.filter(p => !isCarryoverBeforeGoodsItem(p))
      return [{
        sectionKey,
        rows,
        st: {
          cartons: subtotalRows.reduce((s, p) => s + (p.total_cartons ?? 0), 0),
          qty: subtotalRows.reduce((s, p) => s + (p.total_quantity ?? 0), 0),
          cbm: subtotalRows.reduce((s, p) => s + (p.total_cbm ?? 0), 0),
          weight: subtotalRows.reduce((s, p) => s + (p.total_weight_kg ?? 0), 0),
          amount: subtotalRows.reduce((s, p) => s + (p.total_amount_rmb ?? 0), 0),
        },
      }]
    })
  , [mainRows])

  function handleDeleteItem(id: string) {
    if (!confirm('Delete this row?')) return
    startTransition(async () => {
      try {
        await deleteDocumentItem(id)
        toast.success('Row deleted')
        router.refresh()
      } catch (e: any) { toast.error(e.message) }
    })
  }

  function handleMarkOutOfStock(item: DocumentItem) {
    if (!confirm(`Mark "${item.description ?? item.marks ?? 'this row'}" as out of stock?`)) return
    startTransition(async () => {
      try {
        await markDocumentItemOutOfStock(item.id)
        toast.success('Marked as out of stock')
        router.refresh()
      } catch (e: any) { toast.error(e.message) }
    })
  }

  function handleSaveItemEdit(formData: FormData) {
    if (!editingItem) return
    startTransition(async () => {
      try {
        await updateDocumentItem(editingItem.id, formData)
        setEditingItem(null)
        toast.success('Row updated')
        router.refresh()
      } catch (e: any) { toast.error(e.message) }
    })
  }

  function handleDeleteFooterItems() {
    if (footerItems.length === 0) return
    const scopeLabel = selectedDocumentId !== 'all' ? ' from this document' : ''
    if (!confirm(`Delete ${footerItems.length} document footer rows${scopeLabel}? This cannot be undone.`)) return
    startTransition(async () => {
      try {
        await deleteDocumentFooterItems(selectedDocumentId !== 'all' ? selectedDocumentId : null)
        toast.success(`Deleted ${footerItems.length} footer rows`)
        router.refresh()
      } catch (e: any) { toast.error(e.message) }
    })
  }

  function handleDeleteSection(section: DocumentItem['section']) {
    const sectionLabel = section === 'left_in_warehouse' ? 'left in warehouse' : section
    const scopeLabel = selectedDocumentId !== 'all' ? ' from this document' : ''
    const base =
      initialDoc === 'all'
        ? globalStats.sectionCounts
        : (docScopeStats?.sectionCounts ?? { shipped: 0, left_in_warehouse: 0, repacked: 0 })
    const count = base[section]
    if (count === 0) return
    if (!confirm(`Delete all ${count} "${sectionLabel}" rows${scopeLabel}? This cannot be undone.`)) return
    startTransition(async () => {
      try {
        await deleteDocumentItemsBySection(section, selectedDocumentId !== 'all' ? selectedDocumentId : null)
        toast.success(`Deleted ${count} "${sectionLabel}" rows`)
        router.refresh()
      } catch (e: any) { toast.error(e.message) }
    })
  }

  function handleDeleteAll() {
    const count = initialDoc === 'all' ? globalStats.totalCount : (docScopeStats?.totalCount ?? 0)
    if (count === 0) return
    const msg = initialDoc === 'all'
      ? `Delete ALL ${count} rows from all documents? This cannot be undone.`
      : `Delete all ${count} rows from this document? This cannot be undone.`
    if (!confirm(msg)) return
    startTransition(async () => {
      try {
        if (initialDoc === 'all') {
          await deleteAllDocumentItems()
        } else {
          await deleteDocumentsByDocument(selectedDocumentId)
          pushListUrl({ doc: null, page: null })
        }
        toast.success(`Deleted ${count} rows`)
        router.refresh()
      } catch (e: any) { toast.error(e.message) }
    })
  }

  async function handleAdjustCartons(id: string, delta: number) {
    if (adjustingId) return
    setAdjustingId(id)
    try {
      await adjustDocumentItemCartons(id, delta)
      router.refresh()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setAdjustingId(null)
    }
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
      if (shouldSelectAll) selectableRows.forEach(p => next.add(p.id))
      else selectableRows.forEach(p => next.delete(p.id))
      return next
    })
  }

  async function runExport(format: 'excel' | 'pdf') {
    const rows = selectedRows.length > 0 ? selectedRows : selectableRows
    if (rows.length === 0) {
      toast.info('No rows to export')
      return
    }
    if (format === 'excel') await exportDocumentItemsToExcel(rows)
    else await exportDocumentItemsToPdf(rows)
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    const isPdf = file.name.toLowerCase().endsWith('.pdf')
    if (isPdf) {
      try {
        startImport(file.name)
        const result = await importPdfDirect(file, (pct, stage) => updateProgress(pct, stage))
        const { products, document: doc } = result
        const rows = products
          .filter((p: any) => shouldPublishExtractedProduct(p.section))
          .map((p: any) => ({
            MARKS: String(p.marks ?? p.item_code ?? ''),
            'SHOP#': String(p.shop ?? ''),
            'ITEM NO.': String(p.line_no ?? ''),
            'DESCRIPTION OF GOODS': String(p.description ?? ''),
            PACKING: String(p.packaging ?? ''),
            'T.CTN': p.total_cartons != null ? `${p.total_cartons}CTNS` : '',
            'T.QTY': p.total_qty != null ? `${p.total_qty}pcs` : '',
            'UNIT CBM': p.unit_cbm != null ? `${p.unit_cbm}CBM` : '',
            'T.CBM': p.total_cbm != null ? `${p.total_cbm}CBM` : '',
            'UNIT WEIGHT': p.unit_weight_kg != null ? `${p.unit_weight_kg}KGS` : '',
            'T.WEIGHT': p.total_weight_kg != null ? `${p.total_weight_kg}KGS` : '',
            'U.PRICE (RMB)': p.unit_price_rmb != null ? `¥${p.unit_price_rmb}` : '',
            'T.AMOUNT': p.total_amount_rmb != null ? `¥${p.total_amount_rmb}` : '',
            __source: 'claude_core',
            __needs_llm: 'false',
          }))
        if (rows.length === 0) {
          toast.error('PDF processed but no product rows found')
          failImport('No product rows found')
          return
        }
        updateProgress(92, `Saving ${rows.length} rows…`)
        const normalizedDocumentType: ImportMeta['document_type'] =
          doc.document_type === 'sales_order' || doc.document_type === 'container_manifest'
            ? doc.document_type : 'container_manifest'
        const meta: ImportMeta = {
          source_file_name: file.name, source_file_type: 'pdf',
          document_type: normalizedDocumentType,
          client_details: doc.client_id ?? null,
          container_no: doc.container_no ?? null,
          total_carton: doc.footer_totals?.total_cartons ?? null,
          total_cbm: doc.footer_totals?.total_cbm ?? null,
          total_weight_kgs: doc.footer_totals?.total_weight_kg ?? null,
          total_cost_rmb: doc.footer_totals?.total_amount_rmb ?? null,
          total_cost_usd: doc.footer_totals?.total_amount_usd ?? null,
          payment_date: null, payment_usd: null, goods_balance_usd: null,
          credit_support_usd: null, pivoc_usd: null, freight_usd: null,
          total_balance_usd: null, exchange_rate: null,
        }
        startTransition(async () => {
          try {
            await importProducts(rows, meta)
            toast.success(`Imported ${rows.length} rows`)
            router.refresh()
          } catch (err: any) {
            toast.error(err?.message ?? 'Save failed')
          } finally { finishImport() }
        })
      } catch (err: any) {
        toast.error(err?.message ?? 'Failed to import PDF')
        failImport(String(err))
      }
      e.target.value = ''
      return
    }

    toast.info('For PDFs use Live View. CSV/Excel import writes to a separate products table.')
    e.target.value = ''
  }

  const scopedDeleteCount =
    initialDoc === 'all' ? globalStats.totalCount : (docScopeStats?.totalCount ?? 0)

  const tableMainEmpty = groupedSections.length === 0 && footerItems.length === 0

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Products</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {selectedDocumentId === 'all'
              ? `${listStats.totalCount} rows match filters · latest import per file name`
              : `${listStats.totalCount} rows match · latest import for this file`}
          </p>
          {selectedRows.length > 0 && (
            <p className="text-xs text-emerald-700 mt-1">{selectedRows.length} selected</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <Input
              placeholder="Search marks, description, shop…"
              value={queryInput}
              onChange={e => setQueryInput(e.target.value)}
              className="pl-8 h-8 text-sm w-64"
            />
          </div>
          <Select
            value={selectedDocumentId === 'all' ? 'all' : selectedDocumentId}
            onValueChange={(v) => {
              const docId = v ?? 'all'
              const params = new URLSearchParams(searchParams.toString())
              if (docId === 'all') params.delete('doc')
              else params.set('doc', docId)
              params.set('page', '1')
              router.replace(`${pathname}?${params.toString()}`)
            }}
          >
            <SelectTrigger className="h-8 text-xs min-w-[300px] max-w-[420px]">
              <SelectValue placeholder="All PDFs / documents" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All PDFs / documents</SelectItem>
              {productDocuments.map(doc => (
                <SelectItem key={doc.id} value={doc.id}>
                  {documentSelectLabel(doc)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,image/*"
            className="hidden"
            onChange={handleImport}
          />
          <Button
            variant="outline" size="sm" className="h-8 gap-1.5"
            onClick={() => fileInputRef.current?.click()}
            disabled={!!importStage}
          >
            {importStage
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Importing...</>
              : <><Upload className="h-3.5 w-3.5" /> Import</>}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="h-8 gap-1.5" />}>
              <Download className="h-3.5 w-3.5" /> Export
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => runExport('excel')}>
                <FileSpreadsheet className="h-3.5 w-3.5 mr-2" /> Excel (.xlsx)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => runExport('pdf')}>
                <FileText className="h-3.5 w-3.5 mr-2" /> PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline" size="sm"
            className="h-8 gap-1.5 text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
            onClick={handleDeleteAll}
            disabled={isPending || scopedDeleteCount === 0}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete All
          </Button>
        </div>
      </div>

      {/* Import progress */}
      {importStatus !== 'idle' && (
        <div className={`rounded-md border px-3 py-2.5 text-xs space-y-1.5 ${
          importStatus === 'error' ? 'border-red-200 bg-red-50 text-red-900' :
          importStatus === 'done'  ? 'border-green-200 bg-green-50 text-green-900' :
          'border-blue-200 bg-blue-50 text-blue-900'
        }`}>
          <div className="flex items-center gap-2">
            {importStatus === 'importing' && <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />}
            <span>{importStage}</span>
            {importStatus === 'importing' && importProgress > 0 && (
              <span className="ml-auto text-blue-400 font-mono">{importProgress}%</span>
            )}
          </div>
          {importStatus === 'importing' && importProgress > 0 && (
            <div className="w-full h-1.5 bg-blue-100 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${importProgress}%` }} />
            </div>
          )}
        </div>
      )}

      {/* Document banner */}
      {footerMeta && (
        <div className="rounded-md border bg-amber-50 border-amber-200 px-3 py-2 text-xs flex flex-wrap gap-x-6 gap-y-0.5 items-center">
          <span className="font-semibold text-slate-800">
            CLIENT: <span className="text-amber-800">{footerMeta.client_details ?? '-'}</span>
          </span>
          <span className="font-semibold text-slate-800">
            CONTAINER: <span className="text-amber-800">{footerMeta.container_no ?? '-'}</span>
          </span>
          <span className="text-slate-500 text-[10px] ml-auto">{footerMeta.source_file_name}</span>
        </div>
      )}

      {/* Section legend with per-section delete */}
      <div className="flex gap-3 text-[11px] text-slate-500 flex-wrap">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm bg-white border border-slate-200" />
          shipped ({sectionCounts.shipped})
        </span>
        <span className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-sky-100 border border-sky-200" />
            left in warehouse ({sectionCounts.left_in_warehouse})
          </span>
          {sectionCounts.left_in_warehouse > 0 && (
            <button
              onClick={() => handleDeleteSection('left_in_warehouse')}
              disabled={isPending}
              className="text-[10px] text-red-400 hover:text-red-600 underline disabled:opacity-40"
            >
              delete section
            </button>
          )}
        </span>
        <span className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-violet-100 border border-violet-200" />
            repacked ({sectionCounts.repacked})
          </span>
          {sectionCounts.repacked > 0 && (
            <button
              onClick={() => handleDeleteSection('repacked')}
              disabled={isPending}
              className="text-[10px] text-red-400 hover:text-red-600 underline disabled:opacity-40"
            >
              delete section
            </button>
          )}
        </span>
        {footerItems.length > 0 && (
          <span className="flex items-center gap-2">
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-sm bg-slate-200 border border-slate-400" />
              document footer ({footerItems.length})
            </span>
            <button
              onClick={handleDeleteFooterItems}
              disabled={isPending}
              className="text-[10px] text-red-400 hover:text-red-600 underline disabled:opacity-40"
            >
              delete section
            </button>
          </span>
        )}
      </div>

      {/* Main table */}
      <div className="rounded-md border bg-white overflow-x-auto">
        <table className="w-full text-xs border-collapse min-w-[1900px]">
          <thead>
            <tr className="bg-slate-50 border-b text-left">
              <th className="p-2 font-medium w-8 text-slate-500">#</th>
              <th className="p-2 font-medium w-8 text-center">
                <Checkbox
                  checked={allVisibleSelected}
                  onCheckedChange={toggleSelectAllVisible}
                  aria-label="Select all visible products"
                />
              </th>
              <th className="p-2 font-medium min-w-[120px]">Marks</th>
              <th className="p-2 font-medium min-w-[80px]">Shop</th>
              <th className="p-2 font-medium w-14">Item</th>
              <th className="p-2 font-medium min-w-[180px]">Description</th>
              <th className="p-2 font-medium min-w-[80px]">Packing</th>
              <th className="p-2 font-medium w-14 text-right">CTN</th>
              <th className="p-2 font-medium w-14 text-right">Qty</th>
              <th className="p-2 font-medium w-12 text-right">L</th>
              <th className="p-2 font-medium w-12 text-right">W</th>
              <th className="p-2 font-medium w-12 text-right">H</th>
              <th className="p-2 font-medium w-16 text-right">U.CBM</th>
              <th className="p-2 font-medium w-16 text-right">T.CBM</th>
              <th className="p-2 font-medium w-16 text-right">U.Wkg</th>
              <th className="p-2 font-medium w-16 text-right">T.Wkg</th>
              <th className="p-2 font-medium w-20 text-right">U.Price ¥</th>
              <th className="p-2 font-medium w-20 text-right">Amount ¥</th>
              <th className="p-2 font-medium w-16">Box No</th>
              <th className="p-2 font-medium w-24">Section</th>
              <th className="p-2 font-medium w-8" />
            </tr>
          </thead>
          <tbody>
            {tableMainEmpty ? (
              <tr>
                <td colSpan={21} className="text-center text-slate-400 py-10">
                  {importStage
                    ? 'Import in progress…'
                    : listStats.totalCount > 0
                      ? 'No product rows in this view. Try clearing filters.'
                      : 'No rows found. Save a PDF via Live View.'}
                </td>
              </tr>
            ) : (
              groupedSections.map(({ sectionKey, rows, st }) => (
                <React.Fragment key={sectionKey}>
                  {rows.map(p => (
                    isStuffedBannerItem(p) ? (
                      <tr key={p.id} className="border-b border-yellow-300 bg-yellow-200 font-semibold">
                        <td className="p-2 text-slate-500 tabular-nums">{p.line_no ?? '-'}</td>
                        <td className="p-2 text-center">—</td>
                        <td className="p-2" colSpan={18}>
                          {(p.description ?? p.marks ?? p.item_code ?? 'GOODS STUFFED INTO THIS CO').replace(/\s+/g, ' ').trim()}
                        </td>
                        <td className="p-1">
                          <Button
                            type="button" variant="ghost" size="icon"
                            className="h-7 w-7 text-slate-300 hover:text-red-600"
                            disabled={isPending}
                            onClick={() => handleDeleteItem(p.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ) : (
                    <tr
                      key={p.id}
                      className={`border-b border-slate-100 ${selectedRowIds.has(p.id) ? 'bg-indigo-100 hover:bg-indigo-100' : sectionClass(p.section)}`}
                    >
                      <td className="p-2 text-slate-400 tabular-nums">{p.line_no ?? '-'}</td>
                      <td className="p-2 text-center">
                        <Checkbox
                          checked={selectedRowIds.has(p.id)}
                          onCheckedChange={() => toggleRowSelection(p.id)}
                          aria-label={`Select ${p.description ?? p.marks ?? 'row'}`}
                        />
                      </td>
                      <td className="p-2 font-mono text-slate-800 whitespace-nowrap">{p.marks ?? '-'}</td>
                      <td className="p-2 text-slate-600 max-w-[100px] truncate">{p.shop ?? '-'}</td>
                      <td className="p-2 tabular-nums">{p.item_code ?? '-'}</td>
                      <td className="p-2 text-slate-700 max-w-[200px]">{p.description ?? '-'}</td>
                      <td className="p-2 whitespace-nowrap">{p.packaging ?? '-'}</td>
                      <td className="p-2 text-right tabular-nums">
                        <div className="flex items-center justify-end gap-0.5">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 rounded text-slate-500 hover:text-slate-900"
                            disabled={adjustingId === p.id}
                            onClick={() => handleAdjustCartons(p.id, -1)}
                          >
                            <Minus className="h-2.5 w-2.5" />
                          </Button>
                          <span className="w-7 text-center tabular-nums">{fmtN(p.total_cartons, 0)}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 rounded text-slate-500 hover:text-slate-900"
                            disabled={adjustingId === p.id}
                            onClick={() => handleAdjustCartons(p.id, +1)}
                          >
                            <Plus className="h-2.5 w-2.5" />
                          </Button>
                        </div>
                      </td>
                      <td className="p-2 text-right tabular-nums">{fmtN(p.total_quantity, 0)}</td>
                      <td className="p-2 text-right tabular-nums">{fmtN(p.dim_l_cm, 1)}</td>
                      <td className="p-2 text-right tabular-nums">{fmtN(p.dim_w_cm, 1)}</td>
                      <td className="p-2 text-right tabular-nums">{fmtN(p.dim_h_cm, 1)}</td>
                      <td className="p-2 text-right tabular-nums">{fmtN(p.unit_cbm, 4)}</td>
                      <td className="p-2 text-right tabular-nums">{fmtN(p.total_cbm, 4)}</td>
                      <td className="p-2 text-right tabular-nums">{fmtN(p.unit_weight_kg, 3)}</td>
                      <td className="p-2 text-right tabular-nums">{fmtN(p.total_weight_kg, 3)}</td>
                      <td className="p-2 text-right tabular-nums">{fmtMoney(p.unit_price_rmb)}</td>
                      <td className="p-2 text-right tabular-nums font-medium">{fmtMoney(p.total_amount_rmb)}</td>
                      <td className="p-2 tabular-nums">{boxLabel(p.box_no_start, p.box_no_end)}</td>
                      <td className="p-2"><SectionBadge section={p.section} /></td>
                      <td className="p-1">
                        <DropdownMenu>
                          <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon" className="h-7 w-7" />}>
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setEditingItem(p)}>
                              <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem className="text-amber-700" onClick={() => handleMarkOutOfStock(p)}>
                              <AlertTriangle className="h-3.5 w-3.5 mr-2" /> Mark Out of Stock
                            </DropdownMenuItem>
                            <DropdownMenuItem className="text-red-600" onClick={() => handleDeleteItem(p.id)}>
                              <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                    )
                  ))}
                  {/* Section subtotal row */}
                  <tr className={`text-xs ${SECTION_SUBTOTAL_STYLE[sectionKey]}`}>
                    <td className="p-2" colSpan={7}>
                      {SECTION_LABELS[sectionKey]} — {rows.length} rows
                    </td>
                    <td className="p-2 text-right tabular-nums">{fmtN(st.cartons, 0)} CTN</td>
                    <td className="p-2 text-right tabular-nums">{fmtN(st.qty, 0)} pcs</td>
                    <td colSpan={3} />
                    <td />
                    <td className="p-2 text-right tabular-nums">{fmtN(st.cbm, 4)} CBM</td>
                    <td />
                    <td className="p-2 text-right tabular-nums">{fmtN(st.weight, 3)} KGS</td>
                    <td />
                    <td className="p-2 text-right tabular-nums">¥{fmtN(st.amount, 0)} RMB</td>
                    <td colSpan={3} />
                  </tr>
                </React.Fragment>
              ))
            )}
            {/* Document footer rows — financial summary data saved in old imports */}
            {footerItems.length > 0 && (
              <React.Fragment key="document_footer">
                {footerItems.map(p => (
                  <tr key={p.id} className="border-b border-slate-200 bg-slate-100 text-slate-500 italic">
                    <td className="p-2 text-slate-400 tabular-nums">{p.line_no ?? '-'}</td>
                    <td className="p-2 text-center">—</td>
                    <td className="p-2 font-mono whitespace-nowrap">{p.marks ?? '-'}</td>
                    <td className="p-2 max-w-[100px] truncate">{p.shop ?? '-'}</td>
                    <td className="p-2 tabular-nums">{p.item_code ?? '-'}</td>
                    <td className="p-2 max-w-[200px]">{p.description ?? '-'}</td>
                    <td className="p-2 whitespace-nowrap">{p.packaging ?? '-'}</td>
                    <td className="p-2 text-right tabular-nums">{fmtN(p.total_cartons, 0)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtN(p.total_quantity, 0)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtN(p.dim_l_cm, 1)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtN(p.dim_w_cm, 1)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtN(p.dim_h_cm, 1)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtN(p.unit_cbm, 4)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtN(p.total_cbm, 4)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtN(p.unit_weight_kg, 3)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtN(p.total_weight_kg, 3)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtMoney(p.unit_price_rmb)}</td>
                    <td className="p-2 text-right tabular-nums font-medium">{fmtMoney(p.total_amount_rmb)}</td>
                    <td className="p-2 tabular-nums">{boxLabel(p.box_no_start, p.box_no_end)}</td>
                    <td className="p-2">
                      <span className="text-[10px] text-slate-400 border border-slate-300 rounded px-1">footer</span>
                    </td>
                    <td className="p-1">
                      <Button
                        type="button" variant="ghost" size="icon"
                        className="h-7 w-7 text-slate-300 hover:text-red-600"
                        disabled={isPending}
                        onClick={() => handleDeleteItem(p.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
                <tr className="text-xs bg-slate-300 border-t-2 border-slate-500 font-semibold text-slate-700">
                  <td className="p-2" colSpan={7}>Document Footer — {footerItems.length} rows (financial summary)</td>
                  <td colSpan={14} />
                </tr>
              </React.Fragment>
            )}
            {selectedRows.length > 0 && (
              <tr className="bg-emerald-100 border-t-2 border-emerald-500 font-bold text-emerald-900">
                <td className="p-2" colSpan={7}>SELECTED TOTALS — {selectedRows.length} rows</td>
                <td className="p-2 text-right tabular-nums">{fmtN(selectedTotals.cartons, 0)} CTN</td>
                <td className="p-2 text-right tabular-nums">{fmtN(selectedTotals.qty, 0)} pcs</td>
                <td colSpan={3} />
                <td />
                <td className="p-2 text-right tabular-nums">{fmtN(selectedTotals.cbm, 4)} CBM</td>
                <td />
                <td className="p-2 text-right tabular-nums">{fmtN(selectedTotals.weight, 3)} KGS</td>
                <td />
                <td className="p-2 text-right tabular-nums">¥{fmtN(selectedTotals.amount, 0)} RMB</td>
                <td colSpan={3} />
              </tr>
            )}
            {listStats.totalCount > 0 && multiSection && (
              <tr className="bg-slate-800 text-white font-bold border-t-2 border-slate-900 text-xs">
                <td className="p-2" colSpan={7}>
                  {footerGrandTotals ? 'PDF FOOTER TOTAL' : `GRAND TOTAL — ${listStats.totalCount} rows`}
                </td>
                <td className="p-2 text-right tabular-nums">{fmtN(footerGrandTotals?.cartons ?? totals.cartons, 0)} CTN</td>
                <td className="p-2 text-right tabular-nums">{fmtN(footerGrandTotals?.qty ?? totals.qty, 0)} pcs</td>
                <td colSpan={3} />
                <td />
                <td className="p-2 text-right tabular-nums">{fmtN(footerGrandTotals?.cbm ?? totals.cbm, 4)} CBM</td>
                <td />
                <td className="p-2 text-right tabular-nums">{fmtN(footerGrandTotals?.weight ?? totals.weight, 3)} KGS</td>
                <td />
                <td className="p-2 text-right tabular-nums">¥{fmtN(footerGrandTotals?.amount ?? totals.amount, 0)} RMB</td>
                <td colSpan={3} />
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Financial summary */}
      {footerMeta && (
        <div className="rounded-md border bg-white overflow-hidden text-xs">
          <div className="grid grid-cols-2 divide-x divide-slate-200">
            <table className="w-full">
              <tbody>
                <MetaRow label="TOTAL WEIGHT" value={footerMeta.total_weight_kgs != null ? `${fmtN(footerMeta.total_weight_kgs, 1)} KGS` : '-'} />
                <MetaRow label="TOTAL CBM" value={footerMeta.total_cbm != null ? `${fmtN(footerMeta.total_cbm, 1)} CBM` : '-'} />
                <MetaRow label="TOTAL CARTON" value={footerMeta.total_carton != null ? `${fmtN(footerMeta.total_carton, 0)} CTN` : '-'} />
                <MetaRow
                  label="TOTAL COST"
                  value={
                    <>
                      {footerMeta.total_cost_rmb != null && <span className="mr-3">¥{fmtN(footerMeta.total_cost_rmb, 2)} RMB</span>}
                      {footerMeta.total_cost_usd != null && <span>${fmtN(footerMeta.total_cost_usd, 2)} USD</span>}
                      {footerMeta.total_cost_rmb == null && footerMeta.total_cost_usd == null && '-'}
                    </>
                  }
                />
              </tbody>
            </table>
            <table className="w-full">
              <tbody>
                {footerPaymentRows && footerPaymentRows.length > 0 ? (
                  <>
                    {footerPaymentRows.map((row, idx) => (
                      <MetaRow key={`${row.label}-${idx}`} label={row.label} value={row.value} highlight={row.highlight} />
                    ))}
                    {footerMeta.goods_balance_usd != null && (
                      <MetaRow label="GOODS BALANCE" value={`$${fmtN(footerMeta.goods_balance_usd, 2)} USD`} />
                    )}
                    {footerMeta.total_balance_usd != null && (
                      <MetaRow label="TOTAL BALANCE" value={`$${fmtN(footerMeta.total_balance_usd, 2)} USD`} highlight />
                    )}
                    {footerMeta.exchange_rate != null && (
                      <MetaRow label="EXCHANGE RATE" value={`¥${fmtN(footerMeta.exchange_rate, 2)} RMB`} />
                    )}
                  </>
                ) : (
                  <>
                    {footerMeta.payment_date != null && footerMeta.payment_usd != null && (
                      <MetaRow label={`${footerMeta.payment_date} PAYMENT`} value={`$${fmtN(footerMeta.payment_usd, 2)} USD`} />
                    )}
                    {footerMeta.goods_balance_usd != null && (
                      <MetaRow label="GOODS BALANCE" value={`$${fmtN(footerMeta.goods_balance_usd, 2)} USD`} />
                    )}
                    {footerMeta.credit_support_usd != null && (
                      <MetaRow label="CREDIT SUPPORT TO MOMBASA" value={`$${fmtN(footerMeta.credit_support_usd, 2)} USD`} />
                    )}
                    {footerMeta.pivoc_usd != null && (
                      <MetaRow label="PIVOC" value={`$${fmtN(footerMeta.pivoc_usd, 2)} USD`} />
                    )}
                    {footerMeta.freight_usd != null && (
                      <MetaRow label="YIWU-MOMBASA FREIGHT" value={`$${fmtN(footerMeta.freight_usd, 2)} USD`} />
                    )}
                    {footerMeta.total_balance_usd != null && (
                      <MetaRow label="TOTAL BALANCE" value={`$${fmtN(footerMeta.total_balance_usd, 2)} USD`} highlight />
                    )}
                    {footerMeta.exchange_rate != null && (
                      <MetaRow label="EXCHANGE RATE" value={`¥${fmtN(footerMeta.exchange_rate, 2)} RMB`} />
                    )}
                  </>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Dialog open={!!editingItem} onOpenChange={(open) => !open && setEditingItem(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Product Row</DialogTitle>
          </DialogHeader>
          {editingItem && (
            <form action={handleSaveItemEdit} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Marks" name="marks" defaultValue={editingItem.marks ?? ''} />
                <Field label="Item No" name="item_code" defaultValue={editingItem.item_code ?? ''} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Shop" name="shop" defaultValue={editingItem.shop ?? ''} />
                <Field label="Packing" name="packaging" defaultValue={editingItem.packaging ?? ''} />
              </div>
              <div>
                <Label className="text-xs text-slate-600 mb-1 block">Description</Label>
                <Textarea name="description" rows={2} defaultValue={editingItem.description ?? ''} className="text-sm resize-none" />
              </div>
              <div className="grid grid-cols-5 gap-3">
                <Field label="CTN" name="total_cartons" type="number" defaultValue={String(editingItem.total_cartons ?? '')} />
                <Field label="Qty" name="total_quantity" type="number" defaultValue={String(editingItem.total_quantity ?? '')} />
                <Field label="U.CBM" name="unit_cbm" type="number" step="0.0001" defaultValue={String(editingItem.unit_cbm ?? '')} />
                <Field label="T.CBM" name="total_cbm" type="number" step="0.0001" defaultValue={String(editingItem.total_cbm ?? '')} />
                <Field label="Amount ¥" name="total_amount_rmb" type="number" step="0.01" defaultValue={String(editingItem.total_amount_rmb ?? '')} />
              </div>
              <div className="grid grid-cols-5 gap-3">
                <Field label="L (cm)" name="dim_l_cm" type="number" step="0.1" defaultValue={String(editingItem.dim_l_cm ?? '')} />
                <Field label="W (cm)" name="dim_w_cm" type="number" step="0.1" defaultValue={String(editingItem.dim_w_cm ?? '')} />
                <Field label="H (cm)" name="dim_h_cm" type="number" step="0.1" defaultValue={String(editingItem.dim_h_cm ?? '')} />
                <Field label="U.Wkg" name="unit_weight_kg" type="number" step="0.001" defaultValue={String(editingItem.unit_weight_kg ?? '')} />
                <Field label="T.Wkg" name="total_weight_kg" type="number" step="0.001" defaultValue={String(editingItem.total_weight_kg ?? '')} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Unit Price ¥" name="unit_price_rmb" type="number" step="0.01" defaultValue={String(editingItem.unit_price_rmb ?? '')} />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" size="sm" onClick={() => setEditingItem(null)}>Cancel</Button>
                <Button type="submit" size="sm" disabled={isPending}>Save Changes</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Field({ label, name, type = 'text', defaultValue, step }: {
  label: string
  name: string
  type?: string
  defaultValue?: string
  step?: string
}) {
  return (
    <div>
      <Label className="text-xs text-slate-600 mb-1 block">{label}</Label>
      <Input name={name} type={type} defaultValue={defaultValue} step={step} className="h-8 text-sm" />
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
