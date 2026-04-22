export const dynamic = 'force-dynamic'

import { getProducts, getLatestImportMeta } from '@/app/actions/products'
import { getCategories } from '@/app/actions/categories'
import { getSuppliers } from '@/app/actions/suppliers'
import { CompiledProductsClient } from './compiled-client'

export default async function CompiledProductsPage() {
  const [products, importMeta, categories, suppliers] = await Promise.all([
    getProducts(),
    getLatestImportMeta(),
    getCategories(),
    getSuppliers(),
  ])

  return (
    <CompiledProductsClient
      products={products as any}
      importMeta={importMeta}
      categories={categories}
      suppliers={suppliers as any}
    />
  )
}
