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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Package,
  FileStack,
  Boxes,
  Banknote,
  AlertTriangle,
  PackageX,
  ArrowRight,
} from 'lucide-react'
import { isFooterLikeItem } from '@/lib/document-item-filters'
import { formatDateTime } from '@/lib/utils'

function fmtN(n: number, digits = 0) {
  return n.toLocaleString('en-UG', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export default async function DashboardPage() {
  const [stats, documents, items] = await Promise.all([
    getDocumentItemsPageStats({}),
    getDocumentItemDocuments(),
    getDocumentItemsForList({}),
  ])

  const productRows = items.filter(i => !isFooterLikeItem(i))
  const outOfStock = productRows
    .filter(p => (p.total_cartons ?? 0) === 0 && (p.total_quantity ?? 0) === 0)
    .slice(0, 20)
  const outOfStockCount = productRows.filter(
    p => (p.total_cartons ?? 0) === 0 && (p.total_quantity ?? 0) === 0
  ).length

  const recentDocs = [...documents]
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    .slice(0, 8)

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
            Live view of imported packing lists and line stock
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
        <StatCard title="Documents" value={fmtN(documents.length)} icon={FileStack} iconClass="text-indigo-600" />
        <StatCard title="Out of stock" value={fmtN(outOfStockCount)} icon={PackageX} iconClass="text-red-500" />
        <StatCard title="Imports (7d)" value={fmtN(imports7d)} icon={FileStack} iconClass="text-violet-600" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MiniStat label="Pieces" value={fmtN(stats.totals.qty)} />
        <MiniStat label="CBM" value={fmtN(stats.totals.cbm, 3)} />
        <MiniStat label="Weight (kg)" value={fmtN(stats.totals.weight, 1)} />
        <MiniStat
          label="Sections"
          value={`${fmtN(stats.sectionCounts.shipped)} shipped · ${fmtN(stats.sectionCounts.left_in_warehouse)} left · ${fmtN(stats.sectionCounts.repacked)} repack`}
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              Out of stock
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {outOfStock.length === 0 ? (
              <p className="text-sm text-slate-500 px-4 pb-4">All line items have stock.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="text-xs">
                    <TableHead>Marks</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Shop</TableHead>
                    <TableHead className="text-right">CTN</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {outOfStock.map(p => (
                    <TableRow key={p.id} className="text-xs bg-red-50">
                      <TableCell className="font-mono">{p.marks ?? '-'}</TableCell>
                      <TableCell className="font-medium max-w-[180px] truncate">
                        {p.product_name_local ?? p.description ?? '-'}
                      </TableCell>
                      <TableCell>{p.shop ?? '-'}</TableCell>
                      <TableCell className="text-right font-bold text-red-700">
                        {p.total_cartons ?? 0}
                      </TableCell>
                      <TableCell className="text-right">{p.total_quantity ?? 0}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <FileStack className="h-4 w-4 text-indigo-500" />
              Recent imports
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {recentDocs.length === 0 ? (
              <p className="text-sm text-slate-500 px-4 pb-4">No documents imported yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="text-xs">
                    <TableHead>File</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Imported</TableHead>
                    <TableHead className="text-right">Open</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentDocs.map(doc => (
                    <TableRow key={doc.id} className="text-xs">
                      <TableCell className="font-medium max-w-[200px] truncate">
                        {doc.source_file_name ?? doc.id}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="text-[10px] font-normal">
                          {doc.document_type === 'sales_order' ? 'Sales' : 'Manifest'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-slate-500 whitespace-nowrap">
                        {doc.created_at ? formatDateTime(doc.created_at) : '-'}
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          href={`/management?doc=${doc.id}`}
                          className="text-indigo-600 hover:underline"
                        >
                          Manage
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
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
