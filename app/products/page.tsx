export const dynamic = 'force-dynamic'

import { getProducts, getLatestImportMeta } from "@/app/actions/products"
import { getCategories } from "@/app/actions/categories"
import { getSuppliers } from "@/app/actions/suppliers"
import { ProductsClient } from "./products-client"

export default async function ProductsPage() {
  const [productsResult, categoriesResult, suppliersResult, importMetaResult] = await Promise.allSettled([
    getProducts(),
    getCategories(),
    getSuppliers(),
    getLatestImportMeta(),
  ])

  if (productsResult.status === 'rejected') {
    throw productsResult.reason
  }

  const products = productsResult.value
  const categories = categoriesResult.status === 'fulfilled' ? categoriesResult.value : []
  const suppliers = suppliersResult.status === 'fulfilled' ? suppliersResult.value : []
  const importMeta = importMetaResult.status === 'fulfilled' ? importMetaResult.value : null

  return (
    <ProductsClient
      products={products as any}
      categories={categories}
      suppliers={suppliers}
      importMeta={importMeta}
    />
  )
}
