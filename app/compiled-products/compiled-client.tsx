'use client'

import React, { useMemo, useState } from 'react'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Search, ImageIcon } from 'lucide-react'
import type { Product, ImportMeta } from '@/lib/types'

type Props = {
  products: Product[]
  importMeta: ImportMeta | null
}

type CompiledRow = Product & { _variants: number }

function fmt(n: number | null | undefined, decimals = 2) {
  if (n == null) return '-'
  return n.toLocaleString('en-UG', { minimumFractionDigits: 0, maximumFractionDigits: decimals })
}

function parseWeight(w: string | null | undefined): number {
  return parseFloat((w ?? '0').replace(/[^\d.]/g, '')) || 0
}

export function CompiledProductsClient({ products, importMeta }: Props) {
  const [query, setQuery] = useState('')

  // Group by name + packing. Products without a name or packing are kept as-is.
  const compiled = useMemo<CompiledRow[]>(() => {
    const map = new Map<string, CompiledRow>()
    const singles: CompiledRow[] = []

    for (const p of products) {
      if (!p.name || !p.packing) {
        singles.push({ ...p, _variants: 1 })
        continue
      }
      const key = `${p.name.trim().toLowerCase()}||${p.packing.trim().toLowerCase()}`
      const existing = map.get(key)
      if (!existing) {
        map.set(key, { ...p, _variants: 1 })
      } else {
        existing._variants++
        existing.cartons = (existing.cartons ?? 0) + (p.cartons ?? 0)
        existing.quantity += p.quantity
        existing.cbm = +((existing.cbm ?? 0) + (p.cbm ?? 0)).toFixed(4)
        const sumW = parseWeight(existing.total_weight) + parseWeight(p.total_weight)
        existing.total_weight = sumW > 0 ? `${sumW.toFixed(1)}KGS` : existing.total_weight
        existing.total_amount_rmb =
          (existing.total_amount_rmb ?? 0) + (p.total_amount_rmb ?? 0)
      }
    }

    return [...map.values(), ...singles]
  }, [products])

  const filtered = useMemo(() => {
    if (!query.trim()) return compiled
    const q = query.toLowerCase()
    return compiled.filter(
      p =>
        p.name?.toLowerCase().includes(q) ||
        p.sku?.toLowerCase().includes(q) ||
        p.shop_name?.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q)
    )
  }, [compiled, query])

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
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
          <Input
            placeholder="Search name, SKU, shop…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="pl-8 h-8 text-sm w-56"
          />
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
              <TableHead className="w-10 px-2" />
              <TableHead className="w-28">SKU / MARKS</TableHead>
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

            {/* Yellow totals row from importMeta */}
            {importMeta && (
              <TableRow className="bg-yellow-300 font-bold border-t-2 border-yellow-500">
                <TableCell /><TableCell /><TableCell /><TableCell /><TableCell /><TableCell />
                <TableCell className="text-right text-slate-900">
                  {importMeta.total_carton != null ? `${fmt(importMeta.total_carton, 0)} CTNS` : ''}
                </TableCell>
                <TableCell />
                <TableCell />
                <TableCell className="text-right text-slate-900">
                  {importMeta.total_cbm != null ? `${fmt(importMeta.total_cbm, 4)} CBM` : ''}
                </TableCell>
                <TableCell />
                <TableCell className="text-right text-slate-900">
                  {importMeta.total_weight_kgs != null ? `${fmt(importMeta.total_weight_kgs, 1)} KGS` : ''}
                </TableCell>
                <TableCell />
                <TableCell className="text-right text-slate-900">
                  {importMeta.total_cost_rmb != null ? `¥${fmt(importMeta.total_cost_rmb, 2)}` : ''}
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
