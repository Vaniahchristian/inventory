'use client'

import React, { useMemo, useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { Search, Pencil, Trash2 } from 'lucide-react'
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
import { deleteDocumentItem, updateDocumentItem } from '@/app/actions/products'
import { isFooterLikeItem } from '@/lib/document-item-filters'
import type { DocumentItem, ImportMeta, ProductDocumentRef } from '@/lib/types'

type Props = {
  documents: ProductDocumentRef[]
  items: DocumentItem[]
  selectedDocumentId: string | null
  importMeta?: ImportMeta | null
}

function fmtNum(n: number | null | undefined) {
  if (n == null) return '-'
  return n.toLocaleString('en-UG', { maximumFractionDigits: 2 })
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
  selectedDocumentId,
  importMeta = null,
}: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const [query, setQuery] = useState('')
  const [editingItem, setEditingItem] = useState<DocumentItem | null>(null)

  const visibleItems = useMemo(() => {
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

  const sectionGroups = useMemo(() => {
    const hasNamed = visibleItems.some(i => !!parseSectionLabel(i.remarks))
    const map = new Map<string, DocumentItem[]>()
    for (const item of visibleItems) {
      const title = sectionTitleForItem(item, hasNamed)
      if (!map.has(title)) map.set(title, [])
      map.get(title)!.push(item)
    }
    return [...map.entries()]
      .map(([title, rows]) => ({
        title,
        rows,
        st: {
          cartons: rows.reduce((s, r) => s + (r.total_cartons ?? 0), 0),
          qty: rows.reduce((s, r) => s + (r.total_quantity ?? 0), 0),
          cbm: rows.reduce((s, r) => s + (r.total_cbm ?? 0), 0),
          weight: rows.reduce((s, r) => s + (r.total_weight_kg ?? 0), 0),
          amount: rows.reduce((s, r) => s + (r.total_amount_rmb ?? 0), 0),
        },
        minLine: rows.reduce((m, r) => Math.min(m, r.line_no ?? 999999), 999999),
      }))
      .sort((a, b) => {
        const ra = sectionSortRank(a.title)
        const rb = sectionSortRank(b.title)
        if (ra !== rb) return ra - rb
        if (a.minLine !== b.minLine) return a.minLine - b.minLine
        return a.title.localeCompare(b.title)
      })
  }, [visibleItems])

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
    if (!confirm('Delete this row? This cannot be undone.')) return
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
      </div>

      <div className="flex-1 overflow-auto p-4">
        {!selectedDocumentId ? (
          <div className="rounded-md border bg-white px-4 py-12 text-center text-sm text-slate-500">
            {documents.length === 0
              ? 'No imported files yet.'
              : 'Select a file from the dropdown to view its rows.'}
          </div>
        ) : (
          <div className="rounded-md border bg-white overflow-x-auto">
            <Table className="text-xs">
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead className="w-10 text-center">#</TableHead>
                  <TableHead className="min-w-[100px]">Marks</TableHead>
                  <TableHead className="min-w-[140px]">Name</TableHead>
                  <TableHead className="min-w-[220px]">Description</TableHead>
                  <TableHead className="w-24 text-right">Pieces</TableHead>
                  <TableHead className="w-24 text-right">Cartons</TableHead>
                  <TableHead className="w-24 text-center">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleItems.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-slate-500 py-10">
                      No rows for this file.
                    </TableCell>
                  </TableRow>
                ) : (
                  sectionGroups.map(({ title, rows, st }) => (
                    <React.Fragment key={title}>
                      <TableRow className="bg-amber-100/80 border-y border-amber-200">
                        <TableCell colSpan={7} className="py-2 px-3 text-[11px] font-semibold text-amber-950 tracking-wide">
                          {title}
                        </TableCell>
                      </TableRow>
                      {rows.map((item, idx) => (
                        <TableRow key={item.id}>
                          <TableCell className="text-center text-slate-400">{idx + 1}</TableCell>
                          <TableCell className="font-medium text-slate-800">
                            {item.marks ?? '-'}
                          </TableCell>
                          <TableCell>
                            {item.product_name_local ?? item.description ?? '-'}
                          </TableCell>
                          <TableCell className="max-w-[360px] truncate text-slate-600" title={item.description ?? ''}>
                            {item.description ?? '-'}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtNum(item.total_quantity)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtNum(item.total_cartons)}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-center gap-1">
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
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="bg-amber-50 border-b-2 border-amber-200 text-[11px] font-semibold">
                        <TableCell colSpan={4} className="py-2 px-3 text-amber-950">
                          {title} — {rows.length} rows
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(st.qty)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(st.cartons)} CTN</TableCell>
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
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Row</DialogTitle>
          </DialogHeader>
          {editingItem && (
            <form action={handleSave} className="space-y-3">
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
              <DialogFooter>
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
    </div>
  )
}
