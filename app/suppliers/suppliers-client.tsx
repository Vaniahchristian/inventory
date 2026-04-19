'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Plus, Search, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { createSupplier, updateSupplier, deleteSupplier } from '@/app/actions/suppliers'
import { useFilter } from '@/hooks/use-inventory'
import type { Supplier } from '@/lib/types'

export function SuppliersClient({ suppliers }: { suppliers: Supplier[] }) {
  const [editing, setEditing] = useState<Supplier | null>(null)
  const [adding, setAdding] = useState(false)
  const [isPending, startTransition] = useTransition()
  const { query, setQuery, filtered } = useFilter(suppliers, ['name', 'email', 'phone'])

  function handleDelete(id: string, name: string) {
    if (!confirm(`Delete supplier "${name}"?`)) return
    startTransition(async () => {
      try {
        await deleteSupplier(id)
        toast.success('Supplier deleted')
      } catch (e: any) {
        toast.error(e.message)
      }
    })
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Suppliers</h1>
          <p className="text-sm text-slate-500 mt-0.5">{suppliers.length} suppliers</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <Input
              placeholder="Search…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="pl-8 h-8 text-sm w-48"
            />
          </div>
          <Button size="sm" className="h-8 gap-1.5 bg-slate-900 hover:bg-slate-700" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add Supplier
          </Button>
        </div>
      </div>

      <div className="rounded-md border bg-white overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="text-xs bg-slate-50">
              <TableHead>Name</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Address</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-slate-400 py-10">
                  No suppliers found.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(s => (
                <TableRow key={s.id} className="text-xs hover:bg-slate-50">
                  <TableCell className="font-medium text-slate-900">{s.name}</TableCell>
                  <TableCell>{s.contact_name ?? '-'}</TableCell>
                  <TableCell>{s.email ?? '-'}</TableCell>
                  <TableCell>{s.phone ?? '-'}</TableCell>
                  <TableCell className="max-w-[200px] truncate">{s.address ?? '-'}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger>
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditing(s)}>
                          <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-red-600"
                          onClick={() => handleDelete(s.id, s.name)}
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={adding || !!editing} onOpenChange={v => !v && (setAdding(false), setEditing(null))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Supplier' : 'Add Supplier'}</DialogTitle>
          </DialogHeader>
          <form
            action={(formData) => {
              startTransition(async () => {
                try {
                  if (editing) {
                    await updateSupplier(editing.id, formData)
                    toast.success('Supplier updated')
                  } else {
                    await createSupplier(formData)
                    toast.success('Supplier created')
                  }
                  setAdding(false)
                  setEditing(null)
                } catch (e: any) {
                  toast.error(e.message)
                }
              })
            }}
            className="space-y-3"
          >
            <div>
              <Label className="text-xs text-slate-600 mb-1 block">Name *</Label>
              <Input name="name" required defaultValue={editing?.name} className="h-8 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-slate-600 mb-1 block">Contact Name</Label>
                <Input name="contact_name" defaultValue={editing?.contact_name ?? ''} className="h-8 text-sm" />
              </div>
              <div>
                <Label className="text-xs text-slate-600 mb-1 block">Phone</Label>
                <Input name="phone" defaultValue={editing?.phone ?? ''} className="h-8 text-sm" />
              </div>
            </div>
            <div>
              <Label className="text-xs text-slate-600 mb-1 block">Email</Label>
              <Input name="email" type="email" defaultValue={editing?.email ?? ''} className="h-8 text-sm" />
            </div>
            <div>
              <Label className="text-xs text-slate-600 mb-1 block">Address</Label>
              <Textarea name="address" defaultValue={editing?.address ?? ''} rows={2} className="text-sm resize-none" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => { setAdding(false); setEditing(null) }}>Cancel</Button>
              <Button type="submit" size="sm" disabled={isPending} className="bg-slate-900 hover:bg-slate-700">
                {isPending ? 'Saving…' : editing ? 'Save Changes' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
