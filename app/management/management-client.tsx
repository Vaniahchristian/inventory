'use client'

import { useMemo, useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { Search, Pencil, Trash2, FileText, FileSpreadsheet } from 'lucide-react'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { deleteDocumentItem, updateDocumentItem } from '@/app/actions/products'
import { isFooterLikeItem } from '@/lib/document-item-filters'
import type { DocumentItem, ProductDocumentRef } from '@/lib/types'

type Props = {
  documents: ProductDocumentRef[]
  items: DocumentItem[]
  selectedDocumentId: string | null
}

function fmtNum(n: number | null | undefined) {
  if (n == null) return '-'
  return n.toLocaleString('en-UG', { maximumFractionDigits: 2 })
}

function formatDate(iso: string | undefined) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return ''
  }
}

function docTypeLabel(t: ProductDocumentRef['document_type']) {
  return t === 'sales_order' ? 'Sales' : 'Manifest'
}

export function ManagementClient({ documents, items, selectedDocumentId }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const [query, setQuery] = useState('')
  const [editingItem, setEditingItem] = useState<DocumentItem | null>(null)

  const selectedDoc = documents.find(d => d.id === selectedDocumentId) ?? null

  const visibleItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = items.filter(i => !isFooterLikeItem(i))
    if (!q) return rows
    return rows.filter(i => {
      const hay = [
        i.marks,
        i.product_name_local,
        i.description,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [items, query])

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
    <div className="flex h-full min-h-0">
      {/* Left: file list */}
      <aside className="w-[280px] shrink-0 border-r bg-white flex flex-col min-h-0">
        <div className="px-3 py-3 border-b">
          <h1 className="text-sm font-semibold text-slate-900">Management</h1>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {documents.length} imported file{documents.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex-1 overflow-y-auto">
          {documents.length === 0 ? (
            <p className="px-3 py-6 text-xs text-slate-500">No imported files yet.</p>
          ) : (
            <ul className="py-1">
              {documents.map(doc => {
                const active = doc.id === selectedDocumentId
                const isSales = doc.document_type === 'sales_order'
                return (
                  <li key={doc.id}>
                    <button
                      type="button"
                      onClick={() => selectDocument(doc.id)}
                      className={cn(
                        'w-full text-left px-3 py-2.5 border-l-2 transition-colors',
                        active
                          ? 'bg-slate-100 border-slate-800'
                          : 'border-transparent hover:bg-slate-50'
                      )}
                    >
                      <div className="flex items-start gap-2">
                        {isSales ? (
                          <FileSpreadsheet className="h-3.5 w-3.5 mt-0.5 shrink-0 text-slate-500" />
                        ) : (
                          <FileText className="h-3.5 w-3.5 mt-0.5 shrink-0 text-slate-500" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className={cn(
                            'text-xs truncate',
                            active ? 'font-semibold text-slate-900' : 'font-medium text-slate-700'
                          )}>
                            {doc.source_file_name ?? doc.id}
                          </p>
                          <div className="flex items-center gap-1.5 mt-1">
                            <Badge
                              variant="secondary"
                              className="text-[9px] px-1.5 py-0 h-4 font-normal"
                            >
                              {docTypeLabel(doc.document_type)}
                            </Badge>
                            <span className="text-[10px] text-slate-400">
                              {formatDate(doc.created_at)}
                            </span>
                          </div>
                        </div>
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* Right: items table */}
      <section className="flex-1 min-w-0 flex flex-col bg-slate-50">
        <div className="px-4 py-3 border-b bg-white flex items-center gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-slate-900 truncate">
              {selectedDoc?.source_file_name ?? 'Select a file'}
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {visibleItems.length} row{visibleItems.length === 1 ? '' : 's'}
              {query.trim() ? ' matching search' : ''}
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
        </div>

        <div className="flex-1 overflow-auto p-4">
          {!selectedDocumentId ? (
            <div className="rounded-md border bg-white px-4 py-12 text-center text-sm text-slate-500">
              Select a file from the left to view its rows.
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
                    visibleItems.map((item, idx) => (
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
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </section>

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
