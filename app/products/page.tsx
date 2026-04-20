export const dynamic = 'force-dynamic'

import { getProducts, getLatestImportMeta } from "@/app/actions/products"
import { getCategories } from "@/app/actions/categories"
import { getSuppliers } from "@/app/actions/suppliers"
import { ProductsClient } from "./products-client"

export default async function ProductsPage() {
  const [products, categories, suppliers, importMeta] = await Promise.all([
    getProducts(),
    getCategories(),
    getSuppliers(),
    getLatestImportMeta(),
  ])

  return (
    <ProductsClient
      products={products as any}
      categories={categories}
      suppliers={suppliers}
      importMeta={importMeta}
    />
  )
}
