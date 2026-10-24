'use client'

import React, { useMemo, useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { Search, Pencil, Trash2, Minus, Plus, History, RotateCcw } from 'lucide-react'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { DocumentItemPhotoFields } from '@/components/document-item-photo-fields'
import { ImagePreviewThumb } from '@/components/image-preview'
import {
  adjustDocumentItemCartons,
  deleteDocumentItem,
  restoreDocumentItem,
  updateDocumentItem,
} from '@/app/actions/products'
import { isFooterLikeItem } from '@/lib/document-item-filters'
import type { DocumentItem, DocumentItemChange, ImportMeta, ProductDocumentRef } from '@/lib/types'

type Props = {
  documents: ProductDocumentRef[]
  items: DocumentItem[]
  changes: DocumentItemChange[]
  selectedDocumentId: string | null
  importMeta?: ImportMeta | null
}

type Totals = { cartons: number; qty: number; cbm: number; weight: number; amount: number }

const FIELD_LABELS: Record<string, string> = {
  marks: 'Marks',
  product_name_local: 'Name',
  description: 'Description',
  section: 'Section',
  total_quantity: 'Pieces',
  total_cartons: 'Cartons',
  total_cbm: 'CBM',
  total_weight_kg: 'Weight (kg)',
  total_amount_rmb: 'Amount (¥)',
  photo: 'Photo',
  photo2: 'Photo 2',
  deleted_at: 'Deleted',
}

function fmtNum(n: number | null | undefined) {
  if (n == null) return '-'
  return n.toLocaleString('en-UG', { maximumFractionDigits: 2 })
}

function fmtDelta(n: number) {
  const r = Math.round(n * 100) / 100
  if (r === 0) return '0'
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toLocaleString('en-UG', { maximumFractionDigits: 2 })}`
}

function deltaClass(n: number) {
  if (Math.abs(n) < 0.005) return 'text-slate-400'
  return n < 0 ? 'text-red-600' : 'text-emerald-600'
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Pre-audit rows have no snapshot; treat their live value as the imported one. */
function liveTotals(item: DocumentItem): Totals {
  return {
    cartons: num(item.total_cartons),
    qty: num(item.total_quantity),
    cbm: num(item.total_cbm),
    weight: num(item.total_weight_kg),
    amount: num(item.total_amount_rmb),
  }
}

function importedTotals(item: DocumentItem): Totals {
  return {
    cartons: num(item.original_total_cartons ?? item.total_cartons),
    qty: num(item.original_total_quantity ?? item.total_quantity),
    cbm: num(item.original_total_cbm ?? item.total_cbm),
    weight: num(item.original_total_weight_kg ?? item.total_weight_kg),
    amount: num(item.original_total_amount_rmb ?? item.total_amount_rmb),
  }
}

function sumTotals(rows: Totals[]): Totals {
  return rows.reduce(
    (s, t) => ({
      cartons: s.cartons + t.cartons,
      qty: s.qty + t.qty,
      cbm: s.cbm + t.cbm,
      weight: s.weight + t.weight,
      amount: s.amount + t.amount,
    }),
    { cartons: 0, qty: 0, cbm: 0, weight: 0, amount: 0 }
  )
}

function fmtChangeValue(key: string, v: unknown): string {
  if (v == null || v === '') return '—'
  if (key === 'deleted_at') return 'yes'
  if (typeof v === 'number') return fmtNum(v)
  return String(v)
}

/** Live value with the imported value struck through when they differ. */
function RowPhoto({ url, url2 }: { url?: string | null; url2?: string | null }) {
  return (
    <ImagePreviewThumb
      url={url}
      extraUrls={[url2]}
      size="lg"
      title="Product photo"
      stopPropagation
    />
  )
}

function AuditValue({ current, original }: { current: number; original: number }) {
  const delta = current - original
  if (Math.abs(delta) < 0.005) return <>{fmtNum(current)}</>
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span>{fmtNum(current)}</span>
      <span className="text-[10px]">
        <span className="line-through text-slate-400">{fmtNum(original)}</span>{' '}
        <span className={deltaClass(delta)}>{fmtDelta(delta)}</span>
      </span>
    </span>
  )
}

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

function parseSectionLabel(remarks: string | null | undefined): string | null {
  const raw = (remarks ?? '').split(';').map(s => s.trim()).find(s => s.startsWith('section_label:'))
  if (!raw) return null
  try {
    return decodeURIComponent(raw.slice('section_label:'.length)).trim() || null
  } catch {
    return raw.slice('section_label:'.length).trim() || null
  }
}

function sectionTitleForItem(item: DocumentItem, hasNamedBlocks: boolean): string {
  const custom = parseSectionLabel(item.remarks)
  if (custom) return custom
  if (hasNamedBlocks && (item.section ?? 'shipped') === 'shipped') return 'NEW ORDERS'
  if (item.section === 'left_in_warehouse') return 'GOODS LEFT IN SANCARGO'
  if (item.section === 'repacked') return 'REPACKED'
  if (item.section === 'other') return 'OTHER'
  return 'NEW ORDERS'
}

function sectionSortRank(title: string): number {
  const u = title.toUpperCase()
  if (/\bNEW\s+ORDERS?\b/.test(u)) return 0
  if (/\bGOODS\s+LOAD\b/.test(u) || /\bMMB\b/.test(u)) return 1
  if (/^SHEET\s*\d+\b/.test(u)) return 2
  if (/\bLEFT\b/.test(u)) return 3
  if (/\bREPACK/.test(u)) return 4
  return 5
}

export function ManagementClient({
  documents,
  items,
  changes,
  selectedDocumentId,
  importMeta = null,
}: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const [query, setQuery] = useState('')
  const [editingItem, setEditingItem] = useState<DocumentItem | null>(null)
  const [adjustingId, setAdjustingId] = useState<string | null>(null)
  const [showDeleted, setShowDeleted] = useState(false)
  /** null = closed, '' = whole file, otherwise a document_item id */
  const [historyFor, setHistoryFor] = useState<string | null>(null)

  const itemById = useMemo(() => new Map(items.map(i => [i.id, i])), [items])
  const deletedCount = useMemo(
    () => items.filter(i => i.deleted_at && !isFooterLikeItem(i)).length,
    [items]
  )

  /** Search-matched rows including deleted ones (imported totals still count them). */
  const matchedItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = items.filter(i => !isFooterLikeItem(i))
    if (!q) return rows
    return rows.filter(i => {
      const hay = [
        i.marks,
        i.product_name_local,
        i.description,
        parseSectionLabel(i.remarks),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [items, query])

  const visibleItems = useMemo(
    () => (showDeleted ? matchedItems : matchedItems.filter(i => !i.deleted_at)),
    [matchedItems, showDeleted]
  )

  const sectionGroups = useMemo(() => {
    const hasNamed = matchedItems.some(i => !!parseSectionLabel(i.remarks))
    const map = new Map<string, DocumentItem[]>()
    for (const item of matchedItems) {
      const title = sectionTitleForItem(item, hasNamed)
      if (!map.has(title)) map.set(title, [])
      map.get(title)!.push(item)
    }
    return [...map.entries()]
      .map(([title, all]) => ({
        title,
        rows: showDeleted ? all : all.filter(r => !r.deleted_at),
        liveCount: all.filter(r => !r.deleted_at).length,
        st: sumTotals(all.filter(r => !r.deleted_at).map(liveTotals)),
        orig: sumTotals(all.map(importedTotals)),
        minLine: all.reduce((m, r) => Math.min(m, r.line_no ?? 999999), 999999),
      }))
      .sort((a, b) => {
        const ra = sectionSortRank(a.title)
        const rb = sectionSortRank(b.title)
        if (ra !== rb) return ra - rb
        if (a.minLine !== b.minLine) return a.minLine - b.minLine
        return a.title.localeCompare(b.title)
      })
  }, [matchedItems, showDeleted])

  const fileTotals = useMemo(
    () => ({
      orig: sumTotals(sectionGroups.map(g => g.orig)),
      live: sumTotals(sectionGroups.map(g => g.st)),
    }),
    [sectionGroups]
  )

  const historyRows = useMemo(
    () =>
      historyFor == null
        ? []
        : historyFor === ''
          ? changes
          : changes.filter(c => c.document_item_id === historyFor),
    [changes, historyFor]
  )
  const changeCountByItem = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of changes) m.set(c.document_item_id, (m.get(c.document_item_id) ?? 0) + 1)
    return m
  }, [changes])
  /** changes arrive newest first, so the first hit per item is its latest change */
  const lastChangeByItem = useMemo(() => {
    const m = new Map<string, DocumentItemChange>()
    for (const c of changes) if (!m.has(c.document_item_id)) m.set(c.document_item_id, c)
    return m
  }, [changes])

  const changedProducts = useMemo(() => {
    const hasNamed = matchedItems.some(i => !!parseSectionLabel(i.remarks))
    return matchedItems
      .map(item => {
        const imp = importedTotals(item)
        const live = item.deleted_at ? sumTotals([]) : liveTotals(item)
        return { item, imp, live, section: sectionTitleForItem(item, hasNamed), last: lastChangeByItem.get(item.id) }
      })
      .filter(({ item, imp, live, last }) =>
        !!item.deleted_at ||
        !!last ||
        (Object.keys(imp) as (keyof Totals)[]).some(k => Math.abs(live[k] - imp[k]) >= 0.005)
      )
      .sort((a, b) => String(b.last?.changed_at ?? '').localeCompare(String(a.last?.changed_at ?? '')))
  }, [matchedItems, lastChangeByItem])

  const [view, setView] = useState<'all' | 'changes'>('all')

  const hasDocFooter =
    !!importMeta &&
    (importMeta.total_carton != null ||
      importMeta.total_cbm != null ||
      importMeta.total_weight_kgs != null ||
      importMeta.total_cost_rmb != null)

  function selectDocument(id: string) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('doc', id)
    router.replace(`${pathname}?${params.toString()}`)
  }

  function handleDelete(id: string) {
    if (!confirm('Delete this row? It can be restored from "Show deleted".')) return
    startTransition(async () => {
      try {
        await deleteDocumentItem(id)
        toast.success('Row deleted')
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Delete failed')
      }
    })
  }

  function handleRestore(id: string) {
    startTransition(async () => {
      try {
        await restoreDocumentItem(id)
        toast.success('Row restored')
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Restore failed')
      }
    })
  }

  function handleSave(formData: FormData) {
    if (!editingItem) return
    startTransition(async () => {
      try {
        await updateDocumentItem(editingItem.id, formData)
        toast.success('Row updated')
        setEditingItem(null)
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Save failed')
      }
    })
  }

  async function handleAdjustCartons(id: string, delta: number) {
    if (adjustingId || isPending) return
    setAdjustingId(id)
    try {
      await adjustDocumentItemCartons(id, delta)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Adjust failed')
    } finally {
      setAdjustingId(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50">
      <div className="px-4 py-3 border-b bg-white flex items-center gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold text-slate-900">Management</h1>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {visibleItems.length} row{visibleItems.length === 1 ? '' : 's'}
            {query.trim() ? ' matching search' : ''}
            {documents.length > 0
              ? ` · ${documents.length} imported file${documents.length === 1 ? '' : 's'}`
              : ''}
          </p>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
          <Input
            placeholder="Search marks, name, description…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="pl-8 h-8 text-sm w-64"
            disabled={!selectedDocumentId}
          />
        </div>
        <Select
          value={selectedDocumentId ?? undefined}
          onValueChange={(v) => {
            if (v) selectDocument(v)
          }}
          disabled={documents.length === 0}
        >
          <SelectTrigger className="h-8 text-xs min-w-[300px] max-w-[420px]">
            <SelectValue placeholder="Select imported file" />
          </SelectTrigger>
          <SelectContent>
            {documents.map(doc => (
              <SelectItem key={doc.id} value={doc.id}>
                {documentSelectLabel(doc)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 select-none">
          <Checkbox
            checked={showDeleted}
            onCheckedChange={(v) => setShowDeleted(!!v)}
            disabled={!selectedDocumentId}
          />
          Show deleted{deletedCount > 0 ? ` (${deletedCount})` : ''}
        </label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          disabled={!selectedDocumentId}
          onClick={() => setHistoryFor('')}
        >
          <History className="h-3.5 w-3.5 mr-1" />
          History{changes.length > 0 ? ` (${changes.length})` : ''}
        </Button>
      </div>

      {selectedDocumentId && (
        <div className="px-4 py-2 border-b bg-white grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          {([
            ['Cartons', fileTotals.orig.cartons, fileTotals.live.cartons, ' CTN'],
            ['Pieces', fileTotals.orig.qty, fileTotals.live.qty, ''],
          ] as const).map(([label, orig, live, unit]) => (
            <div key={label} className="col-span-2 flex items-baseline gap-4">
              <span className="w-14 text-[11px] font-semibold text-slate-700">{label}</span>
              <span>
                <span className="text-slate-400">Imported </span>
                <span className="tabular-nums font-medium">{fmtNum(orig)}{unit}</span>
              </span>
              <span>
                <span className="text-slate-400">Current </span>
                <span className="tabular-nums font-semibold">{fmtNum(live)}{unit}</span>
              </span>
              <span>
                <span className="text-slate-400">Change </span>
                <span className={`tabular-nums font-semibold ${deltaClass(live - orig)}`}>
                  {fmtDelta(live - orig)}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4">
        {!selectedDocumentId ? (
          <div className="rounded-md border bg-white px-4 py-12 text-center text-sm text-slate-500">
            {documents.length === 0
              ? 'No imported files yet.'
              : 'Select a file from the dropdown to view its rows.'}
          </div>
        ) : (
          <>
          <div className="mb-3 inline-flex rounded-md border bg-white p-0.5 text-xs">
            {([
              ['all', 'All rows'],
              ['changes', `Changes by product (${changedProducts.length})`],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setView(key)}
                className={`rounded px-3 py-1 ${view === key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                {label}
              </button>
            ))}
          </div>
          {view === 'changes' ? (
            <div className="rounded-md border bg-white overflow-x-auto">
              <Table className="text-xs w-full">
                <TableHeader>
                  <TableRow className="bg-slate-50">
                    <TableHead className="w-14">Photo</TableHead>
                    <TableHead className="w-[9rem]">Marks</TableHead>
                    <TableHead className="min-w-[12rem] w-full">Name</TableHead>
                    <TableHead className="whitespace-nowrap">Section</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Pieces imported</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Current</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Change</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Cartons imported</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Current</TableHead>
                    <TableHead className="text-right whitespace-nowrap">Change</TableHead>
                    <TableHead className="min-w-[10rem] whitespace-nowrap">Last change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {changedProducts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={11} className="text-center text-slate-500 py-10">
                        No product in this file has changed since import.
                      </TableCell>
                    </TableRow>
                  ) : (
                    changedProducts.map(({ item, imp, live, section, last }) => (
                      <TableRow
                        key={item.id}
                        className="cursor-pointer hover:bg-slate-50"
                        onClick={() => setHistoryFor(item.id)}
                        title="Show history"
                      >
                        <TableCell className="align-top">
                          <RowPhoto url={item.photo} url2={item.photo2} />
                        </TableCell>
                        <TableCell className="align-top font-medium text-slate-800 whitespace-normal break-words">
                          {item.marks ?? '-'}
                        </TableCell>
                        <TableCell className="align-top whitespace-normal break-words">
                          {item.product_name_local ?? item.description ?? '-'}
                          {item.deleted_at && (
                            <span className="ml-1.5 rounded bg-red-50 px-1 text-[10px] text-red-600">deleted</span>
                          )}
                        </TableCell>
                        <TableCell className="align-top text-slate-500 whitespace-normal break-words">{section}</TableCell>
                        <TableCell className="align-top text-right tabular-nums text-slate-500">{fmtNum(imp.qty)}</TableCell>
                        <TableCell className="align-top text-right tabular-nums font-medium">{fmtNum(live.qty)}</TableCell>
                        <TableCell className={`align-top text-right tabular-nums font-semibold ${deltaClass(live.qty - imp.qty)}`}>
                          {fmtDelta(live.qty - imp.qty)}
                        </TableCell>
                        <TableCell className="align-top text-right tabular-nums text-slate-500">{fmtNum(imp.cartons)}</TableCell>
                        <TableCell className="align-top text-right tabular-nums font-medium">{fmtNum(live.cartons)}</TableCell>
                        <TableCell className={`align-top text-right tabular-nums font-semibold ${deltaClass(live.cartons - imp.cartons)}`}>
                          {fmtDelta(live.cartons - imp.cartons)}
                        </TableCell>
                        <TableCell className="align-top text-slate-500 whitespace-normal break-words">
                          {last ? (
                            <>
                              {new Date(last.changed_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                              {(changeCountByItem.get(item.id) ?? 0) > 1 && ` · ${changeCountByItem.get(item.id)} changes`}
                              {last.note && <span className="block italic text-slate-600">“{last.note}”</span>}
                            </>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          ) : (
          <div className="rounded-md border bg-white overflow-x-auto">
            <Table className="text-xs w-full">
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead className="w-10 text-center">#</TableHead>
                  <TableHead className="w-14">Photo</TableHead>
                  <TableHead className="w-[9rem]">Marks</TableHead>
                  <TableHead className="min-w-[12rem]">Name</TableHead>
                  <TableHead className="min-w-[14rem] w-full">Description</TableHead>
                  <TableHead className="w-20 text-right whitespace-nowrap">Pieces</TableHead>
                  <TableHead className="w-28 text-right whitespace-nowrap">Cartons</TableHead>
                  <TableHead className="w-28 text-center whitespace-nowrap">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleItems.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-slate-500 py-10">
                      No rows for this file.
                    </TableCell>
                  </TableRow>
                ) : (
                  sectionGroups.map(({ title, rows, liveCount, st, orig }) => (
                    <React.Fragment key={title}>
                      <TableRow className="bg-amber-100/80 border-y border-amber-200">
                        <TableCell colSpan={8} className="py-2 px-3 text-[11px] font-semibold text-amber-950 tracking-wide">
                          {title}
                        </TableCell>
                      </TableRow>
                      {rows.map((item, idx) => {
                        const deleted = !!item.deleted_at
                        const imp = importedTotals(item)
                        const live = liveTotals(item)
                        const historyCount = changeCountByItem.get(item.id) ?? 0
                        return (
                        <TableRow
                          key={item.id}
                          className={deleted ? 'bg-slate-50 text-slate-400 [&_td]:line-through' : undefined}
                        >
                          <TableCell className="align-top text-center text-slate-400">{idx + 1}</TableCell>
                          <TableCell className="align-top">
                            <RowPhoto url={item.photo} url2={item.photo2} />
                          </TableCell>
                          <TableCell className="align-top font-medium text-slate-800 whitespace-normal break-words">
                            {item.marks ?? '-'}
                          </TableCell>
                          <TableCell className="align-top whitespace-normal break-words">
                            {item.product_name_local ?? item.description ?? '-'}
                          </TableCell>
                          <TableCell className="align-top whitespace-normal break-words text-slate-600">
                            {item.description ?? '-'}
                          </TableCell>
                          <TableCell className="align-top text-right tabular-nums">
                            {deleted ? fmtNum(imp.qty) : <AuditValue current={live.qty} original={imp.qty} />}
                          </TableCell>
                          <TableCell className="align-top text-right tabular-nums">
                            {deleted ? (
                              <span className="pr-7">{fmtNum(imp.cartons)}</span>
                            ) : (
                            <div className="flex items-start justify-end gap-0.5">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 rounded text-slate-500 hover:text-slate-900"
                                disabled={adjustingId === item.id || isPending}
                                onClick={() => handleAdjustCartons(item.id, -1)}
                                aria-label="Subtract one carton"
                              >
                                <Minus className="h-3 w-3" />
                              </Button>
                              <span className="min-w-8 text-center tabular-nums pt-1">
                                <AuditValue current={live.cartons} original={imp.cartons} />
                              </span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 rounded text-slate-500 hover:text-slate-900"
                                disabled={adjustingId === item.id || isPending}
                                onClick={() => handleAdjustCartons(item.id, +1)}
                                aria-label="Add one carton"
                              >
                                <Plus className="h-3 w-3" />
                              </Button>
                            </div>
                            )}
                          </TableCell>
                          <TableCell className="align-top">
                            <div className="flex items-center justify-center gap-1">
                              {deleted ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-slate-600"
                                  onClick={() => handleRestore(item.id)}
                                  disabled={isPending}
                                  aria-label="Restore row"
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                </Button>
                              ) : (
                                <>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    onClick={() => setEditingItem(item)}
                                    disabled={isPending}
                                    aria-label="Edit row"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-red-600 hover:text-red-700"
                                    onClick={() => handleDelete(item.id)}
                                    disabled={isPending}
                                    aria-label="Delete row"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </>
                              )}
                              {historyCount > 0 && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-slate-500"
                                  onClick={() => setHistoryFor(item.id)}
                                  aria-label="Row history"
                                  title={`${historyCount} change${historyCount === 1 ? '' : 's'}`}
                                >
                                  <History className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                        )
                      })}
                      <TableRow className="bg-amber-50 border-b-2 border-amber-200 text-[11px] font-semibold">
                        <TableCell colSpan={5} className="py-2 px-3 text-amber-950">
                          {title} — {liveCount} row{liveCount === 1 ? '' : 's'}
                          <span className="ml-3 font-normal text-slate-600">
                            Imported {fmtNum(orig.cartons)} CTN · Current {fmtNum(st.cartons)} CTN ·{' '}
                            <span className={deltaClass(st.cartons - orig.cartons)}>
                              Change {fmtDelta(st.cartons - orig.cartons)}
                            </span>
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <AuditValue current={st.qty} original={orig.qty} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <AuditValue current={st.cartons} original={orig.cartons} /> CTN
                        </TableCell>
                        <TableCell className="text-right text-[10px] font-normal text-slate-500 pr-3">
                          {fmtNum(st.cbm)} CBM · {fmtNum(st.weight)} kg
                          {st.amount > 0 ? ` · ¥${fmtNum(st.amount)}` : ''}
                        </TableCell>
                      </TableRow>
                    </React.Fragment>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          )}
          </>
        )}

        {selectedDocumentId && hasDocFooter && importMeta && (
          <div className="mt-4 rounded-md border bg-white px-4 py-3 text-xs">
            <p className="text-[11px] font-semibold text-slate-700 mb-2">Document footer</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-slate-700">
              <div>
                <span className="text-slate-400">TOTAL CARTON</span>
                <p className="font-semibold tabular-nums">
                  {importMeta.total_carton != null ? `${fmtNum(importMeta.total_carton)} CTN` : '-'}
                </p>
              </div>
              <div>
                <span className="text-slate-400">TOTAL CBM</span>
                <p className="font-semibold tabular-nums">
                  {importMeta.total_cbm != null ? `${fmtNum(importMeta.total_cbm)} CBM` : '-'}
                </p>
              </div>
              <div>
                <span className="text-slate-400">TOTAL WEIGHT</span>
                <p className="font-semibold tabular-nums">
                  {importMeta.total_weight_kgs != null ? `${fmtNum(importMeta.total_weight_kgs)} KGS` : '-'}
                </p>
              </div>
              <div>
                <span className="text-slate-400">TOTAL COST</span>
                <p className="font-semibold tabular-nums">
                  {importMeta.total_cost_rmb != null ? `¥${fmtNum(importMeta.total_cost_rmb)}` : '-'}
                  {importMeta.total_cost_usd != null ? ` / $${fmtNum(importMeta.total_cost_usd)}` : ''}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      <Dialog open={!!editingItem} onOpenChange={(open) => !open && setEditingItem(null)}>
        <DialogContent className="flex max-h-[min(85vh,640px)] max-w-lg flex-col gap-3 overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>Edit Row</DialogTitle>
          </DialogHeader>
          {editingItem && (
            <form action={handleSave} className="flex min-h-0 flex-1 flex-col gap-3">
              {/* Preserve other fields so updateDocumentItem does not null them out */}
              <input type="hidden" name="item_code" value={editingItem.item_code ?? ''} />
              <input type="hidden" name="source_item_no" value={editingItem.source_item_no ?? ''} />
              <input type="hidden" name="delivery_no" value={editingItem.delivery_no ?? ''} />
              <input type="hidden" name="customer_item_ref" value={editingItem.customer_item_ref ?? ''} />
              <input type="hidden" name="unit" value={editingItem.unit ?? ''} />
              <input type="hidden" name="material" value={editingItem.material ?? ''} />
              <input type="hidden" name="shop" value={editingItem.shop ?? ''} />
              <input type="hidden" name="packaging" value={editingItem.packaging ?? ''} />
              <input type="hidden" name="dim_l_cm" value={editingItem.dim_l_cm ?? ''} />
              <input type="hidden" name="dim_w_cm" value={editingItem.dim_w_cm ?? ''} />
              <input type="hidden" name="dim_h_cm" value={editingItem.dim_h_cm ?? ''} />
              <input type="hidden" name="unit_cbm" value={editingItem.unit_cbm ?? ''} />
              <input type="hidden" name="total_cbm" value={editingItem.total_cbm ?? ''} />
              <input type="hidden" name="unit_weight_kg" value={editingItem.unit_weight_kg ?? ''} />
              <input type="hidden" name="total_weight_kg" value={editingItem.total_weight_kg ?? ''} />
              <input type="hidden" name="unit_price_rmb" value={editingItem.unit_price_rmb ?? ''} />
              <input type="hidden" name="total_amount_rmb" value={editingItem.total_amount_rmb ?? ''} />

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
                <div>
                  <Label className="text-xs text-slate-600 mb-1 block">Marks</Label>
                  <Input name="marks" defaultValue={editingItem.marks ?? ''} className="h-8 text-sm" />
                </div>
                <div>
                  <Label className="text-xs text-slate-600 mb-1 block">Name</Label>
                  <Input
                    name="product_name_local"
                    defaultValue={editingItem.product_name_local ?? ''}
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs text-slate-600 mb-1 block">Description</Label>
                  <Textarea
                    name="description"
                    rows={3}
                    defaultValue={editingItem.description ?? ''}
                    className="text-sm resize-none"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-slate-600 mb-1 block">Pieces</Label>
                    <Input
                      name="total_quantity"
                      type="number"
                      defaultValue={String(editingItem.total_quantity ?? '')}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-slate-600 mb-1 block">Cartons</Label>
                    <Input
                      name="total_cartons"
                      type="number"
                      defaultValue={String(editingItem.total_cartons ?? '')}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
                <DocumentItemPhotoFields
                  key={editingItem.id}
                  photo={editingItem.photo}
                  photo2={editingItem.photo2}
                />
                <div>
                  <Label className="text-xs text-slate-600 mb-1 block">Reason (optional)</Label>
                  <Input
                    name="note"
                    placeholder="e.g. 2 cartons damaged on arrival"
                    className="h-8 text-sm"
                  />
                </div>
              </div>
              <DialogFooter className="shrink-0 border-t border-slate-100 pt-3">
                <Button type="button" variant="outline" size="sm" onClick={() => setEditingItem(null)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={isPending}>
                  Save Changes
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={historyFor != null} onOpenChange={(open) => !open && setHistoryFor(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {historyFor
                ? `History — ${itemById.get(historyFor)?.marks ?? itemById.get(historyFor)?.product_name_local ?? 'row'}`
                : 'Change history for this file'}
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto -mx-1 px-1">
            {historyRows.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500">No changes recorded yet.</p>
            ) : (
              <ul className="divide-y text-xs">
                {historyRows.map(c => {
                  const row = itemById.get(c.document_item_id)
                  const keys = Object.keys(c.new_values ?? {}).filter(k => k !== 'deleted_at')
                  return (
                    <li key={c.id} className="py-2">
                      <div className="flex items-baseline gap-2">
                        <span className="text-slate-400 tabular-nums">
                          {new Date(c.changed_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                        </span>
                        {!historyFor && (
                          <span className="font-medium text-slate-800">
                            {row?.marks ?? row?.product_name_local ?? 'Row'}
                          </span>
                        )}
                        <span
                          className={
                            c.action === 'delete'
                              ? 'text-red-600'
                              : c.action === 'restore'
                                ? 'text-emerald-600'
                                : 'text-slate-500'
                          }
                        >
                          {c.action === 'delete' ? 'Deleted' : c.action === 'restore' ? 'Restored' : 'Edited'}
                        </span>
                      </div>
                      {keys.length > 0 && (
                        <ul className="mt-1 space-y-0.5 pl-2">
                          {keys.map(k => {
                            const before = c.old_values?.[k]
                            const after = c.new_values?.[k]
                            const numeric = typeof before === 'number' || typeof after === 'number'
                            const delta = numeric ? num(after) - num(before) : 0
                            return (
                              <li key={k} className="text-slate-700">
                                <span className="text-slate-500">{FIELD_LABELS[k] ?? k}:</span>{' '}
                                <span className="line-through text-slate-400">{fmtChangeValue(k, before)}</span>
                                {' → '}
                                <span className="font-medium">{fmtChangeValue(k, after)}</span>
                                {numeric && (
                                  <span className={`ml-1 ${deltaClass(delta)}`}>({fmtDelta(delta)})</span>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      )}
                      {c.note && <p className="mt-1 pl-2 italic text-slate-600">“{c.note}”</p>}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
