'use client'

import { useState, useTransition, useRef } from 'react'
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
  Plus, Search, MoreHorizontal, Pencil, Trash2,
  Download, Upload, FileSpreadsheet, FileText, ImageIcon,
} from 'lucide-react'
import { createProduct, updateProduct, deleteProduct, importProducts } from '@/app/actions/products'
import { exportProductsToExcel, exportProductsToPdf, parseImportFile } from '@/lib/export'
import { formatCurrency, stockStatus } from '@/lib/utils'
import { useFilter } from '@/hooks/use-inventory'
import type { Product, Category, Supplier } from '@/lib/types'

type Props = {
  products: Product[]
  categories: Category[]
  suppliers: Supplier[]
}

const UNITS = ['pcs', 'kg', 'g', 'L', 'mL', 'box', 'bag', 'roll', 'pair', 'set', 'ctn']

export function ProductsClient({ products, categories, suppliers }: Props) {
  const [editing, setEditing] = useState<Product | null>(null)
  const [adding, setAdding] = useState(false)
  const [isPending, startTransition] = useTransition()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { query, setQuery, filtered } = useFilter(products, ['name', 'sku'])

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

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    // Image files: treat as a standalone product image (not a data import)
    if (file.type.startsWith('image/')) {
      toast.info('To attach an image to a product, open the product and upload from the edit form.')
      e.target.value = ''
      return
    }

    try {
      const rows = await parseImportFile(file)
      startTransition(async () => {
        try {
          const count = await importProducts(rows)
          toast.success(`Imported ${count} products`)
        } catch (err: any) {
          toast.error(err.message)
        }
      })
    } catch {
      toast.error('Failed to parse file')
    }
    e.target.value = ''
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Products</h1>
          <p className="text-sm text-slate-500 mt-0.5">{products.length} items total</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <Input
              placeholder="Search name or SKU…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="pl-8 h-8 text-sm w-52"
            />
          </div>
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
          >
            <Upload className="h-3.5 w-3.5" /> Import
          </Button>
          <Button size="sm" className="h-8 gap-1.5 bg-slate-900 hover:bg-slate-700" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add Product
          </Button>
        </div>
      </div>

      <div className="rounded-md border bg-white overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="text-xs bg-slate-50">
              <TableHead className="w-10" />
              <TableHead className="w-28">SKU</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Supplier</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-sm text-slate-400 py-10">
                  No products found.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(p => {
                const status = stockStatus(p.quantity, p.reorder_level)
                return (
                  <TableRow key={p.id} className="text-xs hover:bg-slate-50">
                    <TableCell className="p-1">
                      {p.image_url ? (
                        <img
                          src={p.image_url}
                          alt={p.name ?? ''}
                          className="h-8 w-8 rounded object-cover border border-slate-100"
                        />
                      ) : (
                        <div className="h-8 w-8 rounded bg-slate-100 flex items-center justify-center">
                          <ImageIcon className="h-3.5 w-3.5 text-slate-300" />
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono">{p.sku ?? '-'}</TableCell>
                    <TableCell className="font-medium text-slate-900">{p.name ?? '-'}</TableCell>
                    <TableCell>{p.categories?.name ?? '-'}</TableCell>
                    <TableCell>{p.suppliers?.name ?? '-'}</TableCell>
                    <TableCell className="text-right">{formatCurrency(p.cost_price)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(p.selling_price)}</TableCell>
                    <TableCell className="text-right font-medium">
                      {p.quantity} {p.unit}
                    </TableCell>
                    <TableCell>
                      {status === 'ok' ? null : (
                        <Badge
                          variant={status === 'out' ? 'destructive' : 'outline'}
                          className={
                            status === 'low'
                              ? 'border-amber-400 text-amber-700 bg-amber-50 text-[10px]'
                              : 'text-[10px]'
                          }
                        >
                          {status === 'out' ? 'Out' : 'Low'}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger>
                          <Button variant="ghost" size="icon" className="h-7 w-7">
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditing(p)}>
                            <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-red-600"
                            onClick={() => handleDelete(p.id, p.name)}
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

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
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{product ? 'Edit Product' : 'Add Product'}</DialogTitle>
        </DialogHeader>
        <form action={onSubmit} className="space-y-3" encType="multipart/form-data">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" name="name" defaultValue={product?.name ?? ''} />
            <Field label="SKU" name="sku" defaultValue={product?.sku ?? ''} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label="Category"
              name="category_id"
              defaultValue={product?.category_id ?? ''}
              options={categories.map(c => ({ value: c.id, label: c.name }))}
              placeholder="None"
            />
            <SelectField
              label="Supplier"
              name="supplier_id"
              defaultValue={product?.supplier_id ?? ''}
              options={suppliers.map(s => ({ value: s.id, label: s.name ?? '' }))}
              placeholder="None"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <SelectField
              label="Unit"
              name="unit"
              defaultValue={product?.unit ?? 'pcs'}
              options={UNITS.map(u => ({ value: u, label: u }))}
              placeholder="pcs"
            />
            <Field label="Cost Price" name="cost_price" type="number" step="0.01" defaultValue={String(product?.cost_price ?? '')} />
            <Field label="Selling Price" name="selling_price" type="number" step="0.01" defaultValue={String(product?.selling_price ?? '')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantity" name="quantity" type="number" defaultValue={String(product?.quantity ?? 0)} />
            <Field label="Reorder Level" name="reorder_level" type="number" defaultValue={String(product?.reorder_level ?? 0)} />
          </div>
          <div>
            <Label className="text-xs text-slate-600 mb-1 block">Description</Label>
            <Textarea
              name="description"
              defaultValue={product?.description ?? ''}
              rows={2}
              className="text-sm resize-none"
            />
          </div>
          <div>
            <Label className="text-xs text-slate-600 mb-1 block">Product Image (optional)</Label>
            {preview && (
              <img src={preview} alt="preview" className="h-20 w-20 object-cover rounded border border-slate-200 mb-2" />
            )}
            <Input
              name="image"
              type="file"
              accept="image/*"
              className="h-8 text-sm"
              onChange={e => {
                const f = e.target.files?.[0]
                if (f) setPreview(URL.createObjectURL(f))
              }}
            />
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

function Field({
  label, name, type = 'text', defaultValue, step,
}: {
  label: string
  name: string
  type?: string
  defaultValue?: string
  step?: string
}) {
  return (
    <div>
      <Label className="text-xs text-slate-600 mb-1 block">{label}</Label>
      <Input
        name={name}
        type={type}
        defaultValue={defaultValue}
        step={step}
        className="h-8 text-sm"
      />
    </div>
  )
}

function SelectField({
  label, name, defaultValue, options, placeholder,
}: {
  label: string
  name: string
  defaultValue: string
  options: { value: string; label: string }[]
  placeholder: string
}) {
  return (
    <div>
      <Label className="text-xs text-slate-600 mb-1 block">{label}</Label>
      <Select name={name} defaultValue={defaultValue || undefined}>
        <SelectTrigger className="h-8 text-sm">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map(o => (
            <SelectItem key={o.value} value={o.value} className="text-sm">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
