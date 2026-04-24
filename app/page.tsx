export const dynamic = 'force-dynamic'

import { getDashboardStats } from "@/app/actions/stock"
import { getProducts } from "@/app/actions/products"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Package, TrendingDown, AlertTriangle, ArrowLeftRight, PackageX } from "lucide-react"
import { formatCurrency, stockStatus } from "@/lib/utils"

export default async function DashboardPage() {
  const [stats, products] = await Promise.all([
    getDashboardStats(),
    getProducts(),
  ])

  const outOfStockProducts = products
    .filter(p => (p.cartons ?? 0) === 0 || p.quantity === 0)
    .slice(0, 20)

  const lowStockProducts = products
    .filter(p => {
      const s = stockStatus(p.quantity, p.reorder_level)
      return s === 'low'
    })
    .slice(0, 10)

  const outOfStockCount = products.filter(p => (p.cartons ?? 0) === 0 || p.quantity === 0).length

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Dashboard</h1>
        <p className="text-sm text-slate-500 mt-0.5">Overview of your inventory</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Products"
          value={stats.totalProducts.toLocaleString()}
          icon={Package}
          iconClass="text-blue-600"
        />
        <StatCard
          title="Inventory Value"
          value={formatCurrency(stats.totalValue)}
          icon={TrendingDown}
          iconClass="text-emerald-600"
        />
        <StatCard
          title="Out of Stock"
          value={outOfStockCount.toLocaleString()}
          icon={PackageX}
          iconClass="text-red-500"
        />
        <StatCard
          title="Movements (7d)"
          value={stats.recentMovements.toLocaleString()}
          icon={ArrowLeftRight}
          iconClass="text-violet-600"
        />
      </div>

      {/* Out of Stock & Zero CTN */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-red-500" />
            Out of Stock &amp; Missing Cartons
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {outOfStockProducts.length === 0 ? (
            <p className="text-sm text-slate-500 px-4 pb-4">All items have stock.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="text-xs">
                  <TableHead>SKU</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Shop</TableHead>
                  <TableHead className="text-right">CTN</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outOfStockProducts.map(p => {
                  const zeroCtns = (p.cartons ?? 0) === 0
                  const zeroQty = p.quantity === 0
                  return (
                    <TableRow key={p.id} className="text-xs bg-red-50">
                      <TableCell className="font-mono">{p.sku ?? '-'}</TableCell>
                      <TableCell className="font-medium">{p.name ?? '-'}</TableCell>
                      <TableCell>{p.shop_name ?? '-'}</TableCell>
                      <TableCell className="text-right font-bold text-red-700">{p.cartons ?? 0}</TableCell>
                      <TableCell className="text-right">{p.quantity}</TableCell>
                      <TableCell>
                        {zeroCtns && zeroQty ? (
                          <Badge variant="destructive" className="text-[10px]">Out of Stock</Badge>
                        ) : zeroCtns ? (
                          <Badge variant="outline" className="border-red-400 text-red-700 bg-red-50 text-[10px]">Zero CTN</Badge>
                        ) : (
                          <Badge variant="outline" className="border-amber-400 text-amber-700 bg-amber-50 text-[10px]">Zero Qty</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Low Stock */}
      {lowStockProducts.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-slate-700">
              Low Stock Items
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="text-xs">
                  <TableHead>SKU</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Reorder At</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lowStockProducts.map(p => (
                  <TableRow key={p.id} className="text-xs">
                    <TableCell className="font-mono">{p.sku}</TableCell>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>{p.categories?.name ?? '-'}</TableCell>
                    <TableCell className="text-right">{p.quantity}</TableCell>
                    <TableCell className="text-right">{p.reorder_level}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="border-amber-400 text-amber-700 bg-amber-50 text-[10px]">
                        Low stock
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
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
