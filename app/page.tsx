export const dynamic = 'force-dynamic'

import Link from 'next/link'
import {
  getDocumentItemDocuments,
  getDocumentItemsForList,
  getDocumentItemsPageStats,
} from '@/app/actions/products'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Package,
  FileStack,
  Boxes,
  Banknote,
  AlertTriangle,
  PackageX,
  ArrowRight,
  Container,
} from 'lucide-react'
import { isFooterLikeItem } from '@/lib/document-item-filters'
import { formatDateTime } from '@/lib/utils'
import type { DocumentItem, ProductDocumentRef } from '@/lib/types'

function fmtN(n: number, digits = 0) {
  return n.toLocaleString('en-UG', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/** Prefer a short container code from marks (MS-7, KM-1, MMB) when shared across the file. */
function containerCodeFromMarks(marks: (string | null | undefined)[]): string | null {
  const prefixes = new Map<string, number>()
  for (const raw of marks) {
    const m = String(raw ?? '')
      .replace(/\n.*/, '')
      .trim()
      .toUpperCase()
    const hit = m.match(/^([A-Z]{2,4})(?:-(\d+))?/)
    if (!hit) continue
    const key = hit[2] ? `${hit[1]}-${hit[2]}` : hit[1]
    // Prefer family like MS-7 from MS-703-3 → take MS + first number group loosely
    const family = m.match(/^([A-Z]{2,4}-\d+)/)?.[1] ?? hit[1]
    prefixes.set(family, (prefixes.get(family) ?? 0) + 1)
  }
  if (prefixes.size === 0) return null
  return [...prefixes.entries()].sort((a, b) => b[1] - a[1])[0]![0]
}

function containerTitle(doc: ProductDocumentRef, rows: DocumentItem[]): string {
  const file = (doc.source_file_name ?? 'Container').trim() || 'Container'
  const code = containerCodeFromMarks(rows.map(r => r.marks))
  if (code && !file.toUpperCase().includes(code)) return `${code} · ${file}`
  return file
}

export default async function DashboardPage() {
  const [stats, documents, items] = await Promise.all([
    getDocumentItemsPageStats({}),
    getDocumentItemDocuments(),
    getDocumentItemsForList({}),
  ])

  const productRows = items.filter(i => !isFooterLikeItem(i) && !i.deleted_at)
  const outOfStockAll = productRows.filter(
    p => (p.total_cartons ?? 0) === 0 && (p.total_quantity ?? 0) === 0
  )
  const outOfStockCount = outOfStockAll.length

  const rowsByDoc = new Map<string, DocumentItem[]>()
  for (const row of productRows) {
    if (!row.document_id) continue
    if (!rowsByDoc.has(row.document_id)) rowsByDoc.set(row.document_id, [])
    rowsByDoc.get(row.document_id)!.push(row)
  }

  const containers = [...documents]
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    .map(doc => {
      const rows = rowsByDoc.get(doc.id) ?? []
      const oos = rows.filter(
        p => (p.total_cartons ?? 0) === 0 && (p.total_quantity ?? 0) === 0
      )
      return {
        doc,
        rows,
        oos,
        title: containerTitle(doc, rows),
        lineCount: rows.length,
        cartonSum: rows.reduce((s, r) => s + (r.total_cartons ?? 0), 0),
      }
    })

  const containersWithOos = containers.filter(c => c.oos.length > 0).length

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const imports7d = documents.filter(d => {
    const t = d.created_at ? new Date(d.created_at).getTime() : NaN
    return Number.isFinite(t) && t >= weekAgo
  }).length

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Dashboard</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Containers (imported files) and what is out of stock in each
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <Link
            href="/products"
            className="inline-flex items-center gap-1 rounded-md border bg-white px-2.5 py-1.5 text-slate-700 hover:bg-slate-50"
          >
            Products <ArrowRight className="h-3 w-3" />
          </Link>
          <Link
            href="/management"
            className="inline-flex items-center gap-1 rounded-md border bg-white px-2.5 py-1.5 text-slate-700 hover:bg-slate-50"
          >
            Management <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatCard title="Line items" value={fmtN(stats.totalCount)} icon={Package} iconClass="text-blue-600" />
        <StatCard title="Total cartons" value={fmtN(stats.totals.cartons)} icon={Boxes} iconClass="text-sky-600" />
        <StatCard
          title="Inventory value"
          value={`¥${fmtN(stats.totals.amount, 2)}`}
          icon={Banknote}
          iconClass="text-emerald-600"
        />
        <StatCard title="Containers" value={fmtN(documents.length)} icon={Container} iconClass="text-indigo-600" />
        <StatCard title="Out of stock" value={fmtN(outOfStockCount)} icon={PackageX} iconClass="text-red-500" />
        <StatCard title="Imports (7d)" value={fmtN(imports7d)} icon={FileStack} iconClass="text-violet-600" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MiniStat label="Pieces" value={fmtN(stats.totals.qty)} />
        <MiniStat label="CBM" value={fmtN(stats.totals.cbm, 3)} />
        <MiniStat label="Weight (kg)" value={fmtN(stats.totals.weight, 1)} />
        <MiniStat
          label="Containers with OOS"
          value={`${fmtN(containersWithOos)} of ${fmtN(containers.length)}`}
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <Container className="h-4 w-4 text-indigo-500" />
            Containers
            <span className="font-normal text-slate-400">
              — each imported file, with out-of-stock lines
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          {containers.length === 0 ? (
            <p className="text-sm text-slate-500 py-4">No containers imported yet.</p>
          ) : (
            containers.map(({ doc, oos, title, lineCount, cartonSum }) => (
              <div
                key={doc.id}
                className={`rounded-md border ${oos.length > 0 ? 'border-red-200 bg-red-50/40' : 'bg-white'}`}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 border-b border-inherit">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        href={`/management?doc=${doc.id}`}
                        className="text-sm font-semibold text-slate-900 hover:text-indigo-700 truncate max-w-[min(100%,28rem)]"
                        title={doc.source_file_name ?? doc.id}
                      >
                        {title}
                      </Link>
                      <Badge variant="secondary" className="text-[10px] font-normal shrink-0">
                        {doc.document_type === 'sales_order' ? 'Sales' : 'Manifest'}
                      </Badge>
                      {oos.length > 0 ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-red-700">
                          <AlertTriangle className="h-3 w-3" />
                          {oos.length} out of stock
                        </span>
                      ) : (
                        <span className="text-[11px] text-emerald-700">In stock</span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {fmtN(lineCount)} lines · {fmtN(cartonSum)} CTN
                      {doc.created_at ? ` · imported ${formatDateTime(doc.created_at)}` : ''}
                    </p>
                  </div>
                  <Link
                    href={`/management?doc=${doc.id}`}
                    className="text-xs text-indigo-600 hover:underline shrink-0"
                  >
                    Open in Management
                  </Link>
                </div>

                {oos.length > 0 && (
                  <div className="px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-1.5">
                      Missing in this container
                    </p>
                    <ul className="space-y-1">
                      {oos.slice(0, 6).map(p => (
                        <li
                          key={p.id}
                          className="flex items-baseline gap-2 text-xs text-slate-800"
                        >
                          <span className="font-mono text-slate-700 shrink-0">
                            {(p.marks ?? '-').replace(/\n.*/, '').trim()}
                          </span>
                          <span className="truncate text-slate-600">
                            {p.product_name_local ?? p.description ?? '-'}
                          </span>
                          {p.shop ? (
                            <span className="ml-auto shrink-0 text-slate-400">{p.shop}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    {oos.length > 6 && (
                      <Link
                        href={`/management?doc=${doc.id}`}
                        className="inline-block mt-1.5 text-[11px] text-indigo-600 hover:underline"
                      >
                        +{oos.length - 6} more — view all
                      </Link>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-white px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className="text-sm font-semibold text-slate-800 mt-0.5 truncate">{value}</p>
    </div>
  )
}

function StatCard({
  title,
  value,
  icon: Icon,
  iconClass,
}: {
  title: string
  value: string
  icon: React.ElementType
  iconClass: string
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-slate-500 truncate">{title}</p>
            <p className="text-xl font-bold text-slate-900 mt-0.5 truncate">{value}</p>
          </div>
          <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${iconClass}`} />
        </div>
      </CardContent>
    </Card>
  )
}
