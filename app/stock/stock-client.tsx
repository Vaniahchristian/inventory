'use client'

import { useState, useTransition } from 'react'
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
import { Plus, Search, Download, FileSpreadsheet, FileText, ArrowDown, ArrowUp, RefreshCw } from 'lucide-react'
import { createStockMovement } from '@/app/actions/stock'
import { exportMovementsToExcel, exportMovementsToPdf } from '@/lib/export'
import { formatDateTime } from '@/lib/utils'
import { useFilter } from '@/hooks/use-inventory'
import type { StockMovement, Product } from '@/lib/types'

const MOVEMENT_COLORS = {
  in: 'border-emerald-400 text-emerald-700 bg-emerald-50',
  out: 'border-red-400 text-red-700 bg-red-50',
  adjustment: 'border-blue-400 text-blue-700 bg-blue-50',
}

const MOVEMENT_ICONS = {
  in: ArrowDown,
  out: ArrowUp,
  adjustment: RefreshCw,
}

export function StockClient({
  movements,
  products,
}: {
  movements: StockMovement[]
  products: Product[]
}) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const { query, setQuery, filtered } = useFilter(movements, [])

  const filteredBySearch = query
    ? movements.filter(
        m =>
          m.products?.name?.toLowerCase().includes(query.toLowerCase()) ||
          m.products?.sku?.toLowerCase().includes(query.toLowerCase()) ||
          m.reference?.toLowerCase().includes(query.toLowerCase())
      )
    : movements

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Stock Movements</h1>
          <p className="text-sm text-slate-500 mt-0.5">{movements.length} records (latest 500)</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <Input
              placeholder="Search product or ref…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="pl-8 h-8 text-sm w-52"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="h-8 gap-1.5" />}>
              <Download className="h-3.5 w-3.5" /> Export
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => exportMovementsToExcel(movements)}>
                <FileSpreadsheet className="h-3.5 w-3.5 mr-2" /> Excel (.xlsx)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportMovementsToPdf(movements)}>
                <FileText className="h-3.5 w-3.5 mr-2" /> PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" className="h-8 gap-1.5 bg-slate-900 hover:bg-slate-700" onClick={() => setOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> Record Movement
          </Button>
        </div>
      </div>

      <div className="rounded-md border bg-white overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="text-xs bg-slate-50">
              <TableHead>Date</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredBySearch.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-sm text-slate-400 py-10">
                  No movements found.
                </TableCell>
              </TableRow>
            ) : (
              filteredBySearch.map(m => {
                const Icon = MOVEMENT_ICONS[m.movement_type]
                return (
                  <TableRow key={m.id} className="text-xs hover:bg-slate-50">
                    <TableCell className="whitespace-nowrap">{formatDateTime(m.created_at)}</TableCell>
                    <TableCell className="font-medium text-slate-900">{m.products?.name ?? '-'}</TableCell>
                    <TableCell className="font-mono">{m.products?.sku ?? '-'}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`${MOVEMENT_COLORS[m.movement_type]} gap-1 text-[10px]`}>
                        <Icon className="h-2.5 w-2.5" />
                        {m.movement_type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {m.quantity} {m.products?.unit ?? ''}
                    </TableCell>
                    <TableCell>{m.reference ?? '-'}</TableCell>
                    <TableCell className="max-w-[200px] truncate">{m.notes ?? '-'}</TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={v => !v && setOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record Stock Movement</DialogTitle>
          </DialogHeader>
          <form
            action={(formData) => {
              startTransition(async () => {
                try {
                  await createStockMovement(formData)
                  toast.success('Movement recorded')
                  setOpen(false)
                } catch (e: any) {
                  toast.error(e.message)
                }
              })
            }}
            className="space-y-3"
          >
            <div>
              <Label className="text-xs text-slate-600 mb-1 block">Product *</Label>
              <Select name="product_id" required>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="Select product…" />
                </SelectTrigger>
                <SelectContent>
                  {products.map(p => (
                    <SelectItem key={p.id} value={p.id} className="text-sm">
                      {p.sku} — {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-slate-600 mb-1 block">Type *</Label>
                <Select name="movement_type" required>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue placeholder="Type…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="in">Stock In</SelectItem>
                    <SelectItem value="out">Stock Out</SelectItem>
                    <SelectItem value="adjustment">Adjustment (set qty)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs text-slate-600 mb-1 block">Quantity *</Label>
                <Input name="quantity" type="number" min="1" required className="h-8 text-sm" />
              </div>
            </div>
            <div>
              <Label className="text-xs text-slate-600 mb-1 block">Reference</Label>
              <Input name="reference" placeholder="PO-001, INV-42, …" className="h-8 text-sm" />
            </div>
            <div>
              <Label className="text-xs text-slate-600 mb-1 block">Notes</Label>
              <Textarea name="notes" rows={2} className="text-sm resize-none" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={isPending} className="bg-slate-900 hover:bg-slate-700">
                {isPending ? 'Saving…' : 'Record'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
