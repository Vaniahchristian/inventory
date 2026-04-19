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
import { createCategory, updateCategory, deleteCategory } from '@/app/actions/categories'
import { formatDate } from '@/lib/utils'
import { useFilter } from '@/hooks/use-inventory'
import type { Category } from '@/lib/types'

export function CategoriesClient({ categories }: { categories: Category[] }) {
  const [editing, setEditing] = useState<Category | null>(null)
  const [adding, setAdding] = useState(false)
  const [isPending, startTransition] = useTransition()
  const { query, setQuery, filtered } = useFilter(categories, ['name', 'description'])

  function handleDelete(id: string, name: string) {
    if (!confirm(`Delete category "${name}"? Products in this category will become uncategorized.`)) return
    startTransition(async () => {
      try {
        await deleteCategory(id)
        toast.success('Category deleted')
      } catch (e: any) {
        toast.error(e.message)
      }
    })
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Categories</h1>
          <p className="text-sm text-slate-500 mt-0.5">{categories.length} categories</p>
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
            <Plus className="h-3.5 w-3.5" /> Add Category
          </Button>
        </div>
      </div>

      <div className="rounded-md border bg-white overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="text-xs bg-slate-50">
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-sm text-slate-400 py-10">
                  No categories found.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(c => (
                <TableRow key={c.id} className="text-xs hover:bg-slate-50">
                  <TableCell className="font-medium text-slate-900">{c.name}</TableCell>
                  <TableCell className="text-slate-500 max-w-[320px] truncate">{c.description ?? '-'}</TableCell>
                  <TableCell>{formatDate(c.created_at)}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="h-7 w-7" />}>
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditing(c)}>
                          <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-red-600"
                          onClick={() => handleDelete(c.id, c.name)}
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
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Category' : 'Add Category'}</DialogTitle>
          </DialogHeader>
          <form
            action={(formData) => {
              startTransition(async () => {
                try {
                  if (editing) {
                    await updateCategory(editing.id, formData)
                    toast.success('Category updated')
                  } else {
                    await createCategory(formData)
                    toast.success('Category created')
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
            <div>
              <Label className="text-xs text-slate-600 mb-1 block">Description</Label>
              <Textarea name="description" defaultValue={editing?.description ?? ''} rows={2} className="text-sm resize-none" />
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
